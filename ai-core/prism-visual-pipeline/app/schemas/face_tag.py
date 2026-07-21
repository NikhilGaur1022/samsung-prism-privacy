"""
PRISM Visual Pipeline — Face-tag schemas.

Each detected face in a processed image is represented as a :class:`FaceTag`
carrying identity-match metadata and optional redaction state.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, computed_field


# ── Enums ────────────────────────────────────────────────────────────────────


class MatchStatus(str, Enum):
    """Outcome of matching a detected face against the session enrolment DB."""

    MATCHED = "MATCHED"
    MANUAL_MATCH = "MANUAL_MATCH"
    UNMATCHED = "UNMATCHED"


class RedactedReason(str, Enum):
    """Why a face region was redacted (blurred)."""

    STRANGER = "STRANGER"
    CONSENT_REVOKED = "CONSENT_REVOKED"


# ── Value objects ────────────────────────────────────────────────────────────


class BoundingBox(BaseModel):
    """Axis-aligned bounding box around a detected face (pixel coords)."""

    x1: int
    y1: int
    x2: int
    y2: int

    @computed_field  # type: ignore[misc]
    @property
    def area(self) -> int:
        """Area in pixels²."""
        return max(0, self.x2 - self.x1) * max(0, self.y2 - self.y1)


# ── Main tag ─────────────────────────────────────────────────────────────────


class FaceTag(BaseModel):
    """Full annotation for one detected face inside a processed image."""

    face_index: int
    consent_id: Optional[str] = None
    master_user_id: Optional[str] = None
    subject_name: Optional[str] = None

    bbox: BoundingBox
    det_score: float
    match_score: Optional[float] = None
    match_status: MatchStatus = MatchStatus.UNMATCHED

    dco_confirmed: bool = False

    is_redacted: bool = False
    redacted_reason: Optional[RedactedReason] = None
    redacted_at: Optional[datetime] = None
    matched_at: Optional[datetime] = None
