"""
PRISM Visual Pipeline — Enrollment schemas.

Payloads and records for subject enrolment (selfie upload → ArcFace embedding
→ Qdrant storage).
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class EnrollmentPayload(BaseModel):
    """Incoming request body for enrolling a new subject in a session."""

    consent_id: str
    master_user_id: str
    project_id: str
    subject_name: Optional[str] = None


class EnrollmentRecord(BaseModel):
    """Persisted record of a successful enrolment."""

    consent_id: str
    master_user_id: str
    project_id: str
    subject_name: Optional[str] = None
    enrolled_at: datetime = datetime.utcnow()
    det_score: Optional[float] = None
