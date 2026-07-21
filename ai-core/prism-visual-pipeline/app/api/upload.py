"""
Upload API — Endpoints for DSLR image upload and processing.

Routes:
    POST  /api/upload/{session_id}                — Upload DSLR images
    GET   /api/upload/{session_id}/{batch_id}      — Get batch processing results
    GET   /api/upload/{session_id}/{batch_id}/{image} — Get single image result
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from app.services.upload_pipeline import UploadPipeline
from app.services.staging import StagingManager
from app.services.qdrant_session import SessionQdrantManager

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/upload", tags=["upload"])

# Shared service instances
_qdrant = SessionQdrantManager()
_staging = StagingManager()
_pipeline = UploadPipeline(qdrant_manager=_qdrant, staging_manager=_staging)


ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".tif", ".webp"}
MAX_FILE_SIZE = 50 * 1024 * 1024  # 50MB per file


@router.post("/{session_id}")
async def upload_images(
    session_id: str,
    images: list[UploadFile] = File(
        ..., description="DSLR images to process (JPEG, PNG, etc.)"
    ),
):
    """
    Upload DSLR images for face detection, consent matching, and stranger blurring.

    This triggers the full pipeline:
        1. Files staged locally
        2. RetinaFace detects all faces in each image
        3. ArcFace extracts embeddings, matched against session Qdrant
        4. Matched faces tagged with consent_id + bounding box
        5. Unmatched faces (strangers) blurred immediately
        6. Results saved for DCO review
    """
    if not _qdrant.session_exists(session_id):
        raise HTTPException(
            status_code=404,
            detail=f"Session '{session_id}' does not exist. Create it and enroll subjects first.",
        )

    # Validate files
    files_to_process = []
    for image in images:
        # Check extension
        ext = "." + image.filename.rsplit(".", 1)[-1].lower() if "." in image.filename else ""
        if ext not in ALLOWED_EXTENSIONS:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported file type: {image.filename}. Allowed: {ALLOWED_EXTENSIONS}",
            )

        content = await image.read()

        # Check size
        if len(content) > MAX_FILE_SIZE:
            raise HTTPException(
                status_code=400,
                detail=f"File too large: {image.filename} ({len(content)} bytes). Max: {MAX_FILE_SIZE}",
            )

        files_to_process.append((image.filename, content))

    if not files_to_process:
        raise HTTPException(status_code=400, detail="No valid image files provided.")

    # Run the pipeline
    try:
        summary = _pipeline.process_upload(
            session_id=session_id,
            files=files_to_process,
        )
        return summary

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Upload pipeline failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Processing failed: {str(e)}")


@router.get("/{session_id}/{batch_id}")
async def get_batch_results(session_id: str, batch_id: str):
    """Get processing results for an entire upload batch."""
    results = _staging.load_all_results(session_id, batch_id)

    if not results:
        raise HTTPException(
            status_code=404,
            detail=f"No results found for batch {batch_id} in session {session_id}.",
        )

    return {
        "session_id": session_id,
        "batch_id": batch_id,
        "total_images": len(results),
        "images": [r.model_dump(mode="json") for r in results],
    }


@router.get("/{session_id}/{batch_id}/{image_filename}")
async def get_image_result(session_id: str, batch_id: str, image_filename: str):
    """Get the processing result for a single image."""
    result = _staging.load_result(session_id, batch_id, image_filename)

    if result is None:
        raise HTTPException(
            status_code=404,
            detail=f"No result found for {image_filename}.",
        )

    return result.model_dump(mode="json")


@router.get("/{session_id}/{batch_id}/{image_filename}/redacted")
async def get_redacted_image(session_id: str, batch_id: str, image_filename: str):
    """Download the redacted (stranger-blurred) version of an image."""
    path = _staging.get_redacted_path(session_id, batch_id, image_filename)

    if path is None:
        # Fall back to original if no redaction was needed
        path = _staging.get_original_path(session_id, batch_id, image_filename)

    if path is None:
        raise HTTPException(status_code=404, detail=f"Image not found: {image_filename}")

    return FileResponse(path, media_type="image/jpeg")


@router.get("/{session_id}/{batch_id}/{image_filename}/original")
async def get_original_image(session_id: str, batch_id: str, image_filename: str):
    """Download the original (unredacted) version of an image."""
    path = _staging.get_original_path(session_id, batch_id, image_filename)

    if path is None:
        raise HTTPException(status_code=404, detail=f"Original image not found: {image_filename}")

    return FileResponse(path, media_type="image/jpeg")
