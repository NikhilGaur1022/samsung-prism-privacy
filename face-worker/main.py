"""Stateless face detection + embedding service.

Deliberately holds no state and talks to no database: it takes an image, returns
bounding boxes and embeddings, and forgets. The Node worker owns clustering,
storage, and the decision to throw the embeddings away.
"""

import io

import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from insightface.app import FaceAnalysis
from PIL import Image

app = FastAPI(title="Prism Face Worker")

# buffalo_l = SCRFD detector + ArcFace (512-d) recogniser. CPU is fine here: this
# runs as a batch pass after a session ends, not in any request path.
face_app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
face_app.prepare(ctx_id=-1, det_size=(640, 640))


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
