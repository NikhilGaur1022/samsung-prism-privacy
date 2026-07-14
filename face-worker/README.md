# Face worker

Stateless HTTP service: image in, face bboxes + ArcFace embeddings out. Nothing is
stored here. The Node recognition worker (`backend/src/workers/recognition.worker.js`)
calls it once per photo after a session ends, clusters the embeddings in memory,
and discards them.

## Run with Docker (preferred)

    docker compose up face-worker    # from backend/

## Run locally without Docker

    pip install -r requirements.txt
    uvicorn main:app --port 8001

First start downloads the `buffalo_l` model pack (~300MB).
