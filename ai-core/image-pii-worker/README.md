# image-pii-worker

Stateless FastAPI microservice that takes a photo, OCRs it with
`rapidocr-onnxruntime`, runs Presidio (with ported Indian recognizers for
Aadhaar, PAN, GSTIN, voter ID, passport, vehicle registration/license plates,
UPI, IFSC, bank account, campus/roll IDs, QR tokens, secrets, and phone
numbers) over the recognized lines, and returns the pixel bounding boxes of
any PII-bearing lines so a downstream service can blur them.

## Install

```
pip install -r requirements.txt
python -m spacy download en_core_web_sm
```

The `spacy download` step is required — Presidio's `AnalyzerEngine` needs an
NLP engine for tokenization even though none of the custom Indian recognizers
here are NER-based. A missing model is a hard failure on the first request
rather than at boot, which is why the Dockerfile bakes it in at build time.

`rapidocr-onnxruntime` needs no download: its detection, recognition and
classification ONNX weights ship inside the wheel, verified by inspecting the
installed package. (This paragraph previously claimed they are fetched to a
cache on first use. They are not, and no model volume is mounted for them.)

## Run

Run from this directory, like face-worker:

```
uvicorn main:app --port 8002
```

## Endpoints

- `GET /health` -> `{"status": "ok"}`
- `POST /detect-pii` (multipart `file` upload, an image) ->
  `{"regions": [[x1,y1,x2,y2], ...], "entities": [{"type": "IN_AADHAAR", "text": "...", "bbox": [x1,y1,x2,y2]}, ...]}`

Detection is line-level: for each OCR line, Presidio analyzes that line's
text, and if any PII entity is found, the whole line's axis-aligned bbox is
emitted (once per matched entity). This avoids fragile character-offset
math when mapping a match back to pixels.
