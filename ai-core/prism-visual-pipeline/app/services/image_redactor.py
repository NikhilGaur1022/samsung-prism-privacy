"""
ImageRedactor — Surgical face blurring for stranger privacy.

Applies Gaussian blur to bounding-box regions of unmatched (stranger) faces
while leaving matched (consented) faces untouched.
"""

from __future__ import annotations

import logging
from datetime import datetime

import cv2
import numpy as np

from app.config import settings
from app.schemas.face_tag import FaceTag, MatchStatus, RedactedReason

logger = logging.getLogger(__name__)


class ImageRedactor:
    """
    Blurs stranger faces in DSLR images.

    Only faces with ``match_status == UNMATCHED`` are redacted.
    The blur is applied as a Gaussian kernel sized to fully obscure
    the facial features while keeping the rest of the image intact.
    """

    def __init__(self):
        self._kernel_size = settings.BLUR_KERNEL_SIZE
        self._sigma = settings.BLUR_SIGMA
        # Ensure kernel size is odd
        if self._kernel_size % 2 == 0:
            self._kernel_size += 1

    def blur_face(
        self,
        image: np.ndarray,
        x1: int, y1: int, x2: int, y2: int,
    ) -> np.ndarray:
        """
        Apply Gaussian blur to a rectangular region of the image.

        Modifies the image in-place and returns it.
        """
        h, w = image.shape[:2]

        # Clamp coordinates to image boundaries
        x1 = max(0, x1)
        y1 = max(0, y1)
        x2 = min(w, x2)
        y2 = min(h, y2)

        if x2 <= x1 or y2 <= y1:
            return image

        roi = image[y1:y2, x1:x2]
        blurred = cv2.GaussianBlur(
            roi,
            (self._kernel_size, self._kernel_size),
            self._sigma,
        )
        image[y1:y2, x1:x2] = blurred

        return image

    def blur_faces(
        self,
        image_bytes: bytes,
        face_tags: list[FaceTag],
    ) -> tuple[bytes, list[FaceTag]]:
        """
        Blur all unmatched faces in an image.

        Args:
            image_bytes: Raw image file bytes.
            face_tags: List of FaceTag objects from the matcher.

        Returns:
            (redacted_image_bytes, updated_face_tags) — the blurred JPEG
            bytes and the same tags with ``is_redacted`` flags set.
        """
        arr = np.frombuffer(image_bytes, dtype=np.uint8)
        image = cv2.imdecode(arr, cv2.IMREAD_COLOR)

        if image is None:
            raise ValueError("Failed to decode image for redaction.")

        strangers_blurred = 0

        for tag in face_tags:
            if tag.match_status == MatchStatus.UNMATCHED:
                self.blur_face(
                    image,
                    tag.bbox.x1, tag.bbox.y1,
                    tag.bbox.x2, tag.bbox.y2,
                )
                tag.is_redacted = True
                tag.redacted_reason = RedactedReason.STRANGER
                tag.redacted_at = datetime.utcnow()
                strangers_blurred += 1

                logger.info(
                    "Redacted face_index=%d (consent_id=%s) in image",
                    tag.face_index, tag.consent_id,
                )

        # Encode back to JPEG
        _, buffer = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 95])
        redacted_bytes = buffer.tobytes()

        return redacted_bytes, face_tags
