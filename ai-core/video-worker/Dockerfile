# CPU by default, deliberately.
#
# The GPU variant is one build arg away (see below), but it is NOT the default:
# the CUDA base is a multi-GB pull and this service is only ever entered from a
# post-session batch job. Making every developer pay for CUDA to run a stack
# they will drive with a 10-second test clip is the same mistake audio-worker's
# compose profile exists to avoid.
#
#   CPU (default):  docker compose build video-worker
#   GPU:            docker compose build --build-arg BASE=nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04 \
#                                        --build-arg ORT=onnxruntime-gpu video-worker
#
# Nothing in the code branches on this. config.onnx_providers() probes what the
# runtime actually exposes and config.video_encoder() probes ffmpeg for NVENC,
# so the same image works either way and says which it picked on /health.
ARG BASE=python:3.11-slim
FROM ${BASE}

ARG ORT=onnxruntime

# ffmpeg is not optional here — it is both the probe (ffprobe) and the encoder
# for every redacted derivative. libgl1/libglib2.0-0 are opencv's runtime deps;
# without them the import succeeds and the first decode fails, which is the
# worst place to find out.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ffmpeg libgl1 libglib2.0-0 python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --break-system-packages -r requirements.txt \
    && pip install --no-cache-dir --break-system-packages ${ORT}

COPY config.py schemas.py tracking.py analyze.py redact.py main.py ./

# Shared with face-worker through the same named volume in docker-compose.yml.
# buffalo_l is ~300MB and both services load the identical pack, so a second
# copy would be 300MB of duplicate download for bytes that must match anyway.
ENV INSIGHTFACE_HOME=/models

EXPOSE 8004
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8004"]
