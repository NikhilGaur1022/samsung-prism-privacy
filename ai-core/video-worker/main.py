"""Stateless video worker: face detection + tracking + sparse embedding, and a
separate box-schedule execution step.

Same contract as face-worker, image-pii-worker and audio-worker: no database, no
consent decision, no memory between calls. /analyze reports what is in the
frame; /redact executes a rectangle list it is handed. The backend is the only
component that ever sees `project_consent_matrix` and turns the first into the
second.

Why two calls rather than one: between them a human tags the clusters. A single
detect-and-blur endpoint would have to make the consent decision itself, which
is precisely the decision this service is built not to make.
"""

import json
import logging
import os
import shutil
import tempfile

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from analyze import PiiUnavailableError, analyze, face_app, probe
from config import ENCODER, GPU_ENABLED, settings
from redact import annotate, mute, redact
from schemas import AnalyzeResponse, ProbeResponse

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("video-worker")

app = FastAPI(title=settings.PROJECT_NAME, version="1.0.0")


@app.get("/health")
def health():
    return {
        "status": "ok",
        "gpu": GPU_ENABLED,
        "encoder": ENCODER,
        "detect_stride": settings.DETECT_STRIDE,
        "hold_sec": settings.HOLD_SEC,
    }


@app.on_event("startup")
def warm():
    """Load the model at boot, not on the first request.

    A cold buffalo_l load is ~15s and downloads ~300MB the very first time. Doing
    that inside the first /analyze makes an already-long call look hung and can
    trip the backend's timeout on a clip that would otherwise have succeeded.
    """
    try:
        face_app()
    except Exception:
        logger.exception("model warm-up failed — first /analyze will retry")


def _spool(upload: UploadFile) -> str:
    """Land the upload on disk. ffprobe and cv2.VideoCapture both need a real
    path, and a multi-hundred-MB clip has no business being held in memory."""
    suffix = os.path.splitext(upload.filename or "")[1] or ".mp4"
    handle = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    try:
        shutil.copyfileobj(upload.file, handle)
    finally:
        handle.close()
    return handle.name


@app.post("/probe", response_model=ProbeResponse)
async def probe_endpoint(file: UploadFile = File(...)):
    """Container facts only — what the upload route needs to accept or reject a
    file, without paying for a detection pass."""
    path = _spool(file)
    try:
        return probe(path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        os.unlink(path)


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze_endpoint(
    file: UploadFile = File(...),
    scan_pii: bool = Form(True),
):
    path = _spool(file)
    try:
        return analyze(path, scan_pii=scan_pii)
    except PiiUnavailableError as exc:
        # 503, not 500: the caller must be able to tell "this clip is
        # unprocessable" from "a dependency is down and a retry will work". The
        # backend maps this onto DEFERRED and requeues.
        raise HTTPException(status_code=503, detail=f"PII detector unavailable: {exc}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("analyze failed")
        raise HTTPException(status_code=500, detail=f"Analysis failed: {exc}") from exc
    finally:
        os.unlink(path)


@app.post("/mute")
async def mute_endpoint(file: UploadFile = File(...)):
    """Return the clip with every audio stream removed.

    Called at INGEST, before the backend stores anything. It is a separate call
    rather than a flag on /analyze because it has to happen before the bytes are
    sealed to disk, and /analyze runs long afterwards against what was stored.
    """
    src = _spool(file)
    out = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
    out.close()

    try:
        stats = mute(src, out.name)
    except Exception as exc:
        logger.exception("mute failed")
        os.path.exists(out.name) and os.unlink(out.name)
        raise HTTPException(status_code=500, detail=f"Could not strip audio: {exc}") from exc
    finally:
        os.unlink(src)

    logger.info("muted %s", stats)
    return FileResponse(
        out.name,
        media_type="video/mp4",
        filename="muted.mp4",
        headers={"X-Reencoded": str(stats["reencoded"]).lower()},
        background=None,
    )


@app.post("/annotate")
async def annotate_endpoint(
    file: UploadFile = File(...),
    tracks: str = Form(...),
):
    """Draw detection boxes over the clip. Masks nothing.

    `tracks` is {"tracks": [...]} where each entry carries keyframed boxes, the
    frame range to hold them over, and a label. Faces stay legible in the output,
    so the backend treats this derivative as it treats the original.
    """
    try:
        parsed = json.loads(tracks)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid tracks JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail="tracks must be a JSON object")

    src = _spool(file)
    out = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
    out.close()

    try:
        stats = annotate(src, out.name, parsed)
    except ValueError as exc:
        os.path.exists(out.name) and os.unlink(out.name)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("annotate failed")
        os.path.exists(out.name) and os.unlink(out.name)
        raise HTTPException(status_code=500, detail=f"Annotation failed: {exc}") from exc
    finally:
        os.unlink(src)

    logger.info("annotated %s", stats)
    return FileResponse(
        out.name,
        media_type="video/mp4",
        filename="detected.mp4",
        headers={
            "X-Total-Frames": str(stats["frames"]),
            "X-Regions": str(stats["regions"]),
            "X-Encoder": stats["encoder"],
        },
        background=None,
    )


@app.post("/redact")
async def redact_endpoint(
    file: UploadFile = File(...),
    schedule: str = Form(...),
):
    """Apply a box schedule and return the re-encoded file.

    `schedule` is {"blur": [...], "mosaic": [...]} where each entry carries
    keyframed boxes plus the frame range to hold them over. There is no branch
    here that decides what to blur.
    """
    try:
        parsed = json.loads(schedule)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid schedule JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail="schedule must be a JSON object")

    src = _spool(file)
    out = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
    out.close()

    try:
        stats = redact(src, out.name, parsed)
    except ValueError as exc:
        os.path.exists(out.name) and os.unlink(out.name)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("redact failed")
        os.path.exists(out.name) and os.unlink(out.name)
        raise HTTPException(status_code=500, detail=f"Redaction failed: {exc}") from exc
    finally:
        os.unlink(src)

    logger.info("redacted %s", stats)
    return FileResponse(
        out.name,
        media_type="video/mp4",
        filename="redacted.mp4",
        headers={
            "X-Redacted-Frames": str(stats["blurred_frames"]),
            "X-Total-Frames": str(stats["frames"]),
            "X-Blur-Regions": str(stats["blur_regions"]),
            "X-Mosaic-Regions": str(stats["mosaic_regions"]),
            "X-Encoder": stats["encoder"],
        },
        background=None,
    )
