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
face_app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
face_app.prepare(ctx_id=-1, det_size=(640, 640))

# Blur strength for bystander redaction. Deliberately irreversible: a large kernel
# with a wide sigma destroys the signal rather than merely obscuring it.
BLUR_KERNEL = int(os.getenv("FACE_BLUR_KERNEL", "99"))
BLUR_SIGMA = float(os.getenv("FACE_BLUR_SIGMA", "30"))


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


@app.post("/redact")
async def redact(file: UploadFile = File(...), bboxes: str = Form(...)):
    """Blur the given regions and return the JPEG bytes.

    The caller sends only the boxes it has decided are bystanders — this service
    makes no consent decision of its own, it just applies the blur it's told to.
    """
    raw = await file.read()
    try:
        image = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Unreadable image: {exc}") from exc

    try:
        regions = json.loads(bboxes)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid bboxes JSON: {exc}") from exc

    bgr = np.array(image)[:, :, ::-1].copy()
    height, width = bgr.shape[:2]
    # Kernel must be odd for GaussianBlur.
    kernel = BLUR_KERNEL if BLUR_KERNEL % 2 == 1 else BLUR_KERNEL + 1

    for box in regions:
        x1, y1, x2, y2 = (int(round(float(v))) for v in box[:4])
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(width, x2), min(height, y2)
        if x2 <= x1 or y2 <= y1:
            continue
        roi = bgr[y1:y2, x1:x2]
        bgr[y1:y2, x1:x2] = cv2.GaussianBlur(roi, (kernel, kernel), BLUR_SIGMA)

    ok, encoded = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
    if not ok:
        raise HTTPException(status_code=500, detail="Failed to encode redacted image")

    return Response(content=encoded.tobytes(), media_type="image/jpeg")
