"""
PRISM Visual Pipeline — Processing-result schemas.

A :class:`ProcessingResult` aggregates all :class:`FaceTag` annotations for a
single image together with pipeline lifecycle state.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, computed_field

from app.schemas.face_tag import FaceTag, MatchStatus


class ImageStatus(str, Enum):
    """Lifecycle stage of a single image inside the processing pipeline."""

    STAGED = "STAGED"
    PROCESSING = "PROCESSING"
    PENDING_REVIEW = "PENDING_REVIEW"
    CONFIRMED = "CONFIRMED"
    COMMITTED = "COMMITTED"
    FAILED = "FAILED"


class ProcessingResult(BaseModel):
    """Result of processing a single DSLR image through the pipeline."""

    image_file: str
    session_id: str
    batch_id: str
    status: ImageStatus = ImageStatus.STAGED
    faces: list[FaceTag] = []
    processed_at: Optional[datetime] = None
    error: Optional[str] = None

    @computed_field  # type: ignore[misc]
    @property
    def total_faces(self) -> int:
        """Total number of detected faces."""
        return len(self.faces)

    @computed_field  # type: ignore[misc]
    @property
    def matched_faces(self) -> int:
        """Number of faces that were matched to an enrolled subject."""
        return sum(
            1
            for f in self.faces
            if f.match_status in (MatchStatus.MATCHED, MatchStatus.MANUAL_MATCH)
        )

    @computed_field  # type: ignore[misc]
    @property
    def unmatched_faces(self) -> int:
        """Number of faces that could not be matched (strangers)."""
        return sum(
            1 for f in self.faces if f.match_status == MatchStatus.UNMATCHED
        )
