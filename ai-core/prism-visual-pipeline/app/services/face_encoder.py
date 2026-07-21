"""
FaceEncoder — InsightFace wrapper for face detection and embedding extraction.

Uses RetinaFace for detection and ArcFace for 512-d embedding extraction.
The model is loaded lazily as a singleton to avoid repeated initialization.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional

import cv2
import numpy as np

from app.config import settings

logger = logging.getLogger(__name__)


@dataclass
class DetectedFace:
    """Container for a single detected face."""
    embedding: np.ndarray
    bbox: dict  # {"x1": int, "y1": int, "x2": int, "y2": int}
    det_score: float
    face_index: int


class FaceEncoder:
    """
    Handles face detection + embedding extraction via InsightFace.

    The underlying FaceAnalysis model is loaded once (singleton) on first use
    to avoid the heavy initialization cost on every request.
    """

    _face_app = None  # Singleton InsightFace model

    @classmethod
    def _get_face_app(cls):
        """Lazily load the InsightFace model pack."""
        if cls._face_app is None:
            import insightface
            from insightface.app import FaceAnalysis

            model_name = settings.INSIGHTFACE_MODEL
            det_size = (settings.DET_SIZE_W, settings.DET_SIZE_H)

            logger.info(
                "Loading InsightFace model pack: %s (det_size=%s)",
                model_name, det_size,
            )

            app = FaceAnalysis(
                name=model_name,
                providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
            )
            app.prepare(ctx_id=0, det_size=det_size)

            cls._face_app = app
            logger.info("InsightFace model loaded successfully")

        return cls._face_app

    @staticmethod
    def _image_from_bytes(image_bytes: bytes) -> np.ndarray:
        """Decode raw image bytes into a BGR numpy array (OpenCV format)."""
        arr = np.frombuffer(image_bytes, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("Failed to decode image bytes — unsupported or corrupt file.")
        return img

    def extract_single(self, image_bytes: bytes) -> tuple[np.ndarray, float]:
        """
        Extract a single face embedding from a selfie image.

        Used during subject enrollment. Raises ValueError if the image
        contains zero or more than one face.

        Returns:
            (embedding, det_score) — 512-d vector and detection confidence.
        """
        app = self._get_face_app()
        img = self._image_from_bytes(image_bytes)
        faces = app.get(img)

        if len(faces) == 0:
            raise ValueError(
                "No face detected in the selfie image. "
                "Please upload a clear, front-facing photo."
            )

        if len(faces) > 1:
            # Pick the largest face (by bounding-box area) instead of failing
            faces = sorted(
                faces,
                key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]),
                reverse=True,
            )
            logger.warning(
                "Multiple faces (%d) detected in selfie; using the largest one.",
                len(faces),
            )

        face = faces[0]
        embedding = face.normed_embedding  # 512-d, already L2-normalised
        det_score = float(face.det_score)

        return embedding, det_score

    def extract_all(self, image_bytes: bytes) -> list[DetectedFace]:
        """
        Detect and extract embeddings for *all* faces in an image.

        Used during DSLR upload processing. Faces below the configured
        MIN_DET_CONFIDENCE are filtered out.

        Returns:
            List of DetectedFace dataclass instances.
        """
        app = self._get_face_app()
        img = self._image_from_bytes(image_bytes)
        raw_faces = app.get(img)

        min_conf = settings.MIN_DET_CONFIDENCE
        results: list[DetectedFace] = []
        idx = 0

        for face in raw_faces:
            score = float(face.det_score)
            if score < min_conf:
                continue

            bbox = face.bbox.astype(int)
            results.append(DetectedFace(
                embedding=face.normed_embedding,
                bbox={
                    "x1": int(bbox[0]),
                    "y1": int(bbox[1]),
                    "x2": int(bbox[2]),
                    "y2": int(bbox[3]),
                },
                det_score=score,
                face_index=idx,
            ))
            idx += 1

        logger.info(
            "Detected %d faces in image (%d passed confidence filter from %d raw)",
            len(results), len(results), len(raw_faces),
        )

        return results
