# GPU base image — pyannote + Whisper + SpeechBrain all run meaningfully
# faster with CUDA. If no GPU is available, swap the line below for
# `FROM python:3.12-slim`; every model loader in this service (see
# diarization.py, transcription.py, speaker_id.py) already checks
# torch.cuda.is_available() and falls back to CPU automatically — it will
# just be slow.
FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

RUN apt-get update && apt-get install -y \
    python3-pip python3-dev ffmpeg git curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

COPY pyproject.toml uv.lock* ./
RUN uv sync --no-cache

COPY . .

EXPOSE 8003
CMD ["uv", "run", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8003"]
