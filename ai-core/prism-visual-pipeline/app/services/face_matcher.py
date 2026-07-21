"""
FaceMatcher — Orchestrates face detection → Qdrant search → tag generation.

For each DSLR image, extracts all faces, queries the session collection,
and produces a ProcessingResult containing tagged FaceTags.
"""

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from app.config import settings
from app.schemas.face_tag import BoundingBox, FaceTag, MatchStatus
from app.schemas.processing_result import ProcessingResult, ImageStatus
from app.services.face_encoder import FaceEncoder
from app.services.qdrant_session import SessionQdrantManager

logger = logging.getLogger(__name__)


class FaceMatcher:
    """
    Matches detected faces against enrolled subjects in a session.

    For each face in an image:
      1. Extract embedding via FaceEncoder
      2. Query session Qdrant collection
      3. If score >= threshold → MATCHED with consent_id
      4. If score < threshold  → UNMATCHED (stranger)
    """

    def __init__(
        self,
        qdrant_manager: SessionQdrantManager,
        face_encoder: FaceEncoder,
    ):
        self._qdrant = qdrant_manager
        self._encoder = face_encoder

    def process_image(
        self,
        session_id: str,
        image_file: str,
        image_bytes: bytes,
        batch_id: str = "",
    ) -> ProcessingResult:
        """
        Run the full detection → matching pipeline on a single image.

        Returns a ProcessingResult with a FaceTag for every detected face.
        """
        # Detect all faces
        detected_faces = self._encoder.extract_all(image_bytes)

        face_tags: list[FaceTag] = []

        for det in detected_faces:
            bbox = BoundingBox(
                x1=det.bbox["x1"],
                y1=det.bbox["y1"],
                x2=det.bbox["x2"],
                y2=det.bbox["y2"],
            )

            # Search Qdrant for a match
            match_result = self._qdrant.search_face(
                session_id=session_id,
                embedding=det.embedding.tolist(),
            )

            if match_result is not None:
                consent_id, score, payload = match_result
                tag = FaceTag(
                    face_index=det.face_index,
                    consent_id=consent_id,
                    master_user_id=payload.get("master_user_id"),
                    subject_name=payload.get("subject_name"),
                    bbox=bbox,
                    det_score=det.det_score,
                    match_score=score,
                    match_status=MatchStatus.MATCHED,
                    matched_at=datetime.utcnow(),
                )
            else:
                tag = FaceTag(
                    face_index=det.face_index,
                    bbox=bbox,
                    det_score=det.det_score,
                    match_status=MatchStatus.UNMATCHED,
                )

            face_tags.append(tag)

        matched_count = sum(
            1 for t in face_tags if t.match_status == MatchStatus.MATCHED
        )
        unmatched_count = len(face_tags) - matched_count

        logger.info(
            "Processed %s: %d faces detected, %d matched, %d unmatched",
            image_file, len(face_tags), matched_count, unmatched_count,
        )

        return ProcessingResult(
            image_file=image_file,
            session_id=session_id,
            batch_id=batch_id,
            status=ImageStatus.PENDING_REVIEW,
            faces=face_tags,
            processed_at=datetime.utcnow(),
        )
