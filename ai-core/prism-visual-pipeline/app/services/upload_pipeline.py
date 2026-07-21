"""
UploadPipeline — Top-level orchestrator for the PRISM visual pipeline.

Coordinates the full flow:
    1. Stage uploaded files locally
    2. Detect faces (RetinaFace)
    3. Extract embeddings (ArcFace)
    4. Match against session Qdrant collection
    5. Blur unmatched stranger faces
    6. Save results for DCO review
"""

from __future__ import annotations

import logging
from datetime import datetime
from uuid import uuid4

from app.config import settings
from app.schemas.face_tag import MatchStatus
from app.services.face_encoder import FaceEncoder
from app.services.face_matcher import FaceMatcher
from app.services.image_redactor import ImageRedactor
from app.services.qdrant_session import SessionQdrantManager
from app.services.staging import StagingManager

logger = logging.getLogger(__name__)


class UploadPipeline:
    """
    End-to-end pipeline for DSLR image processing.

    Wires together the face encoder, matcher, redactor, and staging manager
    to produce a complete batch processing result.
    """

    def __init__(
        self,
        qdrant_manager: SessionQdrantManager,
        staging_manager: StagingManager,
    ):
        self._qdrant = qdrant_manager
        self._staging = staging_manager
        self._encoder = FaceEncoder()
        self._matcher = FaceMatcher(
            qdrant_manager=qdrant_manager,
            face_encoder=self._encoder,
        )
        self._redactor = ImageRedactor()

    def enroll_subject(
        self,
        session_id: str,
        selfie_bytes: bytes,
        consent_id: str,
        master_user_id: str,
        project_id: str,
        subject_name: str | None = None,
    ) -> dict:
        """
        Enroll a consented subject into the session.

        Extracts a single face embedding from the selfie and stores it
        in the session's Qdrant collection. The raw selfie is discarded.

        Returns:
            Enrollment confirmation dict.
        """
        embedding, det_score = self._encoder.extract_single(selfie_bytes)

        point_id = self._qdrant.add_enrollment(
            session_id=session_id,
            consent_id=consent_id,
            embedding=embedding.tolist(),
            payload={
                "consent_id": consent_id,
                "master_user_id": master_user_id,
                "project_id": project_id,
                "subject_name": subject_name or "",
            },
        )

        logger.info(
            "Enrolled subject: consent_id=%s, session=%s, det_score=%.3f",
            consent_id, session_id, det_score,
        )

        return {
            "status": "enrolled",
            "consent_id": consent_id,
            "subject_name": subject_name,
            "det_score": det_score,
            "point_id": point_id,
        }

    def process_upload(
        self,
        session_id: str,
        files: list[tuple[str, bytes]],
    ) -> dict:
        """
        Process an upload batch through the full pipeline.

        Args:
            session_id: Active session identifier.
            files: List of (filename, content_bytes) tuples.

        Returns:
            Summary dict with batch_id, per-image results, and aggregate stats.
        """
        batch_id = str(uuid4())

        # 1. Stage files locally
        self._staging.stage_files(session_id, batch_id, files)

        logger.info(
            "Upload pipeline started: session=%s, batch=%s, files=%d",
            session_id, batch_id, len(files),
        )

        total_matched = 0
        total_unmatched = 0
        total_strangers_blurred = 0
        image_summaries = []

        for filename, content in files:
            # 2–4. Detect, extract, match
            result = self._matcher.process_image(
                session_id=session_id,
                image_file=filename,
                image_bytes=content,
                batch_id=batch_id,
            )

            # 5. Blur unmatched faces
            unmatched_faces = [
                t for t in result.faces
                if t.match_status == MatchStatus.UNMATCHED
            ]

            if unmatched_faces:
                redacted_bytes, updated_tags = self._redactor.blur_faces(
                    content, result.faces,
                )
                result.faces = updated_tags

                # Save redacted image
                self._staging.save_redacted(
                    session_id, batch_id, filename, redacted_bytes,
                )

                strangers_count = len(unmatched_faces)
                total_strangers_blurred += strangers_count
                logger.info(
                    "Blurred %d stranger face(s) in %s",
                    strangers_count, filename,
                )

            # 6. Save result JSON
            self._staging.save_result(session_id, batch_id, result)

            # Aggregate stats
            matched = sum(
                1 for t in result.faces
                if t.match_status == MatchStatus.MATCHED
            )
            unmatched = len(result.faces) - matched
            total_matched += matched
            total_unmatched += unmatched

            image_summaries.append({
                "image_file": filename,
                "total_faces": len(result.faces),
                "matched_faces": matched,
                "faces": [
                    t.model_dump(mode="json") for t in result.faces
                ],
            })

        logger.info(
            "Upload pipeline complete: batch=%s, images=%d, "
            "matched=%d, unmatched=%d, strangers_blurred=%d",
            batch_id, len(files), total_matched,
            total_unmatched, total_strangers_blurred,
        )

        return {
            "batch_id": batch_id,
            "session_id": session_id,
            "total_images": len(files),
            "total_faces_detected": total_matched + total_unmatched,
            "total_faces_matched": total_matched,
            "total_strangers_blurred": total_strangers_blurred,
            "images": image_summaries,
        }
