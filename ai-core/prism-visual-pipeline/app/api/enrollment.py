"""
Enrollment API — Endpoints for session management and subject enrollment.

Routes:
    POST   /api/sessions/{session_id}/create   — Create a new session collection
    POST   /api/sessions/{session_id}/enroll   — Enroll a subject (selfie + consent)
    GET    /api/sessions/{session_id}/subjects — List enrolled subjects
    DELETE /api/sessions/{session_id}          — Delete session and all data
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app.services.qdrant_session import SessionQdrantManager
from app.services.staging import StagingManager
from app.services.upload_pipeline import UploadPipeline

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/sessions", tags=["sessions"])

# Shared service instances
_qdrant = SessionQdrantManager()
_staging = StagingManager()
_pipeline = UploadPipeline(qdrant_manager=_qdrant, staging_manager=_staging)


@router.post("/{session_id}/create")
async def create_session(session_id: str):
    """Create a new ephemeral Qdrant collection for this session."""
    if _qdrant.session_exists(session_id):
        return {
            "status": "exists",
            "message": f"Session '{session_id}' already exists.",
        }

    _qdrant.create_session(session_id)
    return {
        "status": "created",
        "session_id": session_id,
    }


@router.post("/{session_id}/enroll")
async def enroll_subject(
    session_id: str,
    selfie: UploadFile = File(..., description="Subject selfie image"),
    consent_id: str = Form(...),
    master_user_id: str = Form(...),
    project_id: str = Form(...),
    subject_name: str = Form(""),
):
    """
    Enroll a consented subject into the session.

    Accepts a selfie image (multipart), extracts the face embedding,
    and stores it in the session's Qdrant collection.
    """
    if not _qdrant.session_exists(session_id):
        raise HTTPException(
            status_code=404,
            detail=f"Session '{session_id}' does not exist. Create it first.",
        )

    content = await selfie.read()

    try:
        result = _pipeline.enroll_subject(
            session_id=session_id,
            selfie_bytes=content,
            consent_id=consent_id,
            master_user_id=master_user_id,
            project_id=project_id,
            subject_name=subject_name,
        )
        return result

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Enrollment failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Enrollment failed: {str(e)}")


@router.get("/{session_id}/subjects")
async def list_subjects(session_id: str):
    """List all enrolled subjects in a session."""
    if not _qdrant.session_exists(session_id):
        raise HTTPException(
            status_code=404,
            detail=f"Session '{session_id}' does not exist.",
        )

    subjects = _qdrant.list_enrollments(session_id)
    return {
        "session_id": session_id,
        "total": len(subjects),
        "subjects": subjects,
    }


@router.delete("/{session_id}")
async def delete_session(session_id: str):
    """Delete a session and its Qdrant collection."""
    if not _qdrant.session_exists(session_id):
        raise HTTPException(
            status_code=404,
            detail=f"Session '{session_id}' does not exist.",
        )

    _qdrant.delete_session(session_id)
    return {
        "status": "deleted",
        "session_id": session_id,
    }
