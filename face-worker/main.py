"""Stateless face detection + embedding service.

Deliberately holds no state and talks to no database: it takes an image, returns
bounding boxes and embeddings, and forgets. The Node worker owns clustering,
storage, and the decision to throw the embeddings away.
"""

import io
import json
import os

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from insightface.app import FaceAnalysis
from PIL import Image

app = FastAPI(title="Prism Face Worker")

# buffalo_l = SCRFD detector + ArcFace (512-d) recogniser. CPU is fine here: this
# runs as a batch pass after a session ends, not in any request path.
#
# `root` is passed explicitly. Without it insightface ignores INSIGHTFACE_HOME and
# resolves to ~/.insightface inside the container — which is the container's own
# writable layer, not the face_models volume this service shares with
# video-worker. The pack is ~300MB (601MB with the zip it keeps), so every
# `docker compose up` that recreated the container re-downloaded it, and on a slow
# link the service sat in startup for minutes while /analyze calls against it
# failed and parked their clips DEFERRED. video-worker hit the identical bug.
INSIGHTFACE_ROOT = os.getenv("INSIGHTFACE_HOME", "~/.insightface")
face_app = FaceAnalysis(
    name="buffalo_l", root=INSIGHTFACE_ROOT, providers=["CPUExecutionProvider"]
)
face_app.prepare(ctx_id=-1, det_size=(640, 640))

# Blur strength for bystander redaction. Deliberately irreversible: a large kernel
# with a wide sigma destroys the signal rather than merely obscuring it.
BLUR_KERNEL = int(os.getenv("FACE_BLUR_KERNEL", "99"))
BLUR_SIGMA = float(os.getenv("FACE_BLUR_SIGMA", "30"))

# Text redaction. A mosaic this coarse discards the pixels outright, which is
# what makes a redacted Aadhaar unrecoverable rather than merely smeared; the
# padding covers ascenders and descenders that fall outside a tight OCR box.
PII_MOSAIC_BLOCKS = int(os.getenv("PII_MOSAIC_BLOCKS", "6"))
PII_PAD_RATIO = float(os.getenv("PII_PAD_RATIO", "0.12"))
PII_PAD_MIN = int(os.getenv("PII_PAD_MIN", "4"))


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/detect")
async def detect(file: UploadFile = File(...)):
    raw = await file.read()
    try:
        image = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Unreadable image: {exc}") from exc

    # insightface expects BGR
    bgr = np.array(image)[:, :, ::-1]
    faces = face_app.get(bgr)

    return {
        "faces": [
            {
                "bbox": [float(v) for v in face.bbox],
                "det_score": float(face.det_score),
                # normed_embedding is L2-normalised, so the Node side's cosine
                # similarity is a plain dot product.
                "embedding": [float(v) for v in face.normed_embedding],
            }
            for face in faces
        ]
    }


@app.post("/embed")
async def embed(file: UploadFile = File(...)):
    """Single-face embedding for enrollment selfies.

    Returns the LARGEST face when several are present (a bystander in frame must
    not silently become the enrolled identity — the caller sees face_count and
    can reject). 400 when no face is found at all.
    """
    raw = await file.read()
    try:
        image = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Unreadable image: {exc}") from exc

    bgr = np.array(image)[:, :, ::-1]
    faces = face_app.get(bgr)
    if not faces:
        raise HTTPException(status_code=400, detail="No face detected in the image")

    faces.sort(key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]), reverse=True)
    face = faces[0]

    # Best-effort quality signals for the caller — not used for rejection here,
    # that stays in the Node worker / client. brightness = mean luma, blur =
    # variance of the Laplacian (higher = sharper).
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    brightness = float(gray.mean())
    blur = float(cv2.Laplacian(gray, cv2.CV_64F).var())

    return {
        "embedding": [float(v) for v in face.normed_embedding],
        "det_score": float(face.det_score),
        "bbox": [float(v) for v in face.bbox],
        "face_count": len(faces),
        "brightness": brightness,
        "blur": blur,
    }


def _parse_boxes(value: str, field: str):
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid {field} JSON: {exc}") from exc
    if not isinstance(parsed, list):
        raise HTTPException(status_code=400, detail=f"{field} must be a JSON array")
    return parsed


def _clamp_box(box, width: int, height: int, pad_ratio: float = 0.0, pad_min: int = 0):
    try:
        x1, y1, x2, y2 = (int(round(float(v))) for v in list(box)[:4])
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid bbox {box!r}: {exc}") from exc

    if x2 < x1:
        x1, x2 = x2, x1
    if y2 < y1:
        y1, y2 = y2, y1

    # Zero-area in, zero-area out: padding first would invent a region out of a
    # box that located nothing.
    if x2 == x1 or y2 == y1:
        return None

    if pad_ratio or pad_min:
        pad_x = max(pad_min, int(round((x2 - x1) * pad_ratio)))
        pad_y = max(pad_min, int(round((y2 - y1) * pad_ratio)))
        x1, y1, x2, y2 = x1 - pad_x, y1 - pad_y, x2 + pad_x, y2 + pad_y

    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(width, x2), min(height, y2)
    if x2 <= x1 or y2 <= y1:
        return None
    return x1, y1, x2, y2


@app.post("/redact")
async def redact(
    file: UploadFile = File(...),
    bboxes: str = Form(...),
    pii_bboxes: str = Form(""),
):
    """Blur the given regions and return the JPEG bytes.

    The caller sends only the boxes it has decided are bystanders — this service
    makes no consent decision of its own, it just applies the blur it's told to.

    `bboxes` are faces: a wide Gaussian, which is irreversible at face scale.
    `pii_bboxes` are printed text, which a Gaussian alone does not destroy —
    stroke structure survives in a small block of digits and is recoverable.
    Those are mosaicked first (the pixels are thrown away) and blurred second,
    and they are padded outward because OCR boxes hug the glyphs.
    """
    raw = await file.read()
    try:
        image = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Unreadable image: {exc}") from exc

    face_regions = _parse_boxes(bboxes, "bboxes")
    pii_regions = _parse_boxes(pii_bboxes, "pii_bboxes")

    bgr = np.array(image)[:, :, ::-1].copy()
    height, width = bgr.shape[:2]
    # Kernel must be odd for GaussianBlur.
    kernel = BLUR_KERNEL if BLUR_KERNEL % 2 == 1 else BLUR_KERNEL + 1

    for box in face_regions:
        clamped = _clamp_box(box, width, height)
        if clamped is None:
            continue
        x1, y1, x2, y2 = clamped
        roi = bgr[y1:y2, x1:x2]
        bgr[y1:y2, x1:x2] = cv2.GaussianBlur(roi, (kernel, kernel), BLUR_SIGMA)

    for box in pii_regions:
        clamped = _clamp_box(box, width, height, pad_ratio=PII_PAD_RATIO, pad_min=PII_PAD_MIN)
        if clamped is None:
            continue
        x1, y1, x2, y2 = clamped
        roi = bgr[y1:y2, x1:x2]
        roi_h, roi_w = roi.shape[:2]
        blocks_x = max(1, min(PII_MOSAIC_BLOCKS, roi_w))
        blocks_y = max(1, min(PII_MOSAIC_BLOCKS, roi_h))
        mosaic = cv2.resize(roi, (blocks_x, blocks_y), interpolation=cv2.INTER_AREA)
        mosaic = cv2.resize(mosaic, (roi_w, roi_h), interpolation=cv2.INTER_NEAREST)
        # Kernel must be odd and must not exceed the region, or GaussianBlur
        # spends the whole pass on reflected border pixels.
        soften = max(3, min(roi_w, roi_h) // 2)
        soften = soften if soften % 2 == 1 else soften + 1
        bgr[y1:y2, x1:x2] = cv2.GaussianBlur(mosaic, (soften, soften), 0)

    ok, encoded = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
    if not ok:
        raise HTTPException(status_code=500, detail="Failed to encode redacted image")

    return Response(
        content=encoded.tobytes(),
        media_type="image/jpeg",
        headers={"X-Redacted-Faces": str(len(face_regions)), "X-Redacted-Pii": str(len(pii_regions))},
    )
