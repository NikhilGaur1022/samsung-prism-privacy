FROM python:3.11-slim

# libgl1/libglib2.0-0 are opencv's runtime deps, pulled in through
# rapidocr-onnxruntime. Without them the import succeeds and the first
# /detect-pii call fails, which is the worst place to find out.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Baked at build time, not fetched on boot: Presidio's AnalyzerEngine needs an
# NLP engine for tokenization even though none of the Indian recognizers are
# NER-based, so a missing model is a hard failure on the first request.
RUN python -m spacy download en_core_web_sm

COPY main.py pii_recognizers.py redaction.py ./
COPY tests ./tests

# No model volume, unlike face-worker: rapidocr-onnxruntime ships its detection,
# recognition and classification ONNX weights inside the wheel, so there is
# nothing to fetch at runtime and nothing to cache. This means the image needs
# no network at run time, only at build.
EXPOSE 8002
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8002"]
