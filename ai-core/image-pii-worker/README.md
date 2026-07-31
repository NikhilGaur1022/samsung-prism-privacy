# image-pii-worker

Stateless FastAPI microservice that takes a photo, OCRs it with
`rapidocr-onnxruntime`, runs Presidio (with ported Indian recognizers for
Aadhaar, PAN, GSTIN, voter ID, passport, driving licence, vehicle
registration/license plates, PIN code, UPI, IFSC, bank account, campus/roll
IDs, QR tokens, secrets, and labelled names, plus the built-ins for phone,
email, cards, IBAN, crypto, IP, URL, names, places and dates) over the
recognized lines, and either returns the pixel bounding boxes of any
PII-bearing lines or returns the image with them already destroyed.

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

The container is the verified path — the image is built and exercised:

```
cd ../../backend && docker compose up -d image-pii-worker
```

Bring it up by name. A bare `docker compose up -d` also starts the `redis`
service on 6379, which collides with a native Redis or Memurai.

Running from this directory, like face-worker, still works and is the fallback:

```
uvicorn main:app --port 8002
```

Only one of the two at a time — both bind 8002, and the container is
`restart: unless-stopped`, so it comes back on boot.

## Endpoints

- `GET /health` -> `{"status": "ok"}`
- `POST /detect-pii` (multipart `file` upload, an image) ->
  `{"regions": [[x1,y1,x2,y2], ...], "entities": [{"type": "IN_AADHAAR", "text": "...", "bbox": [x1,y1,x2,y2]}, ...]}`
- `POST /redact-pii` (multipart `file`) -> JPEG bytes with every detected
  region destroyed. Headers `X-Pii-Regions` / `X-Pii-Entities` report counts.
- `POST /redact` (multipart `file` + `bboxes` JSON array) -> JPEG bytes with
  the caller's regions destroyed and nothing detected. Same request shape as
  face-worker's `/redact`.

`regions` is deduplicated (several entities on one OCR line share that line's
box); `entities` is not, so a caller can still see everything that matched.

Detection is line-level: for each OCR line, Presidio analyzes that line's
text, and if any PII entity is found, the whole line's axis-aligned bbox is
emitted. This avoids fragile character-offset math when mapping a match back
to pixels. Each line is analyzed twice — once as OCR'd, and once with
whitespace removed — because OCR drops and invents spaces inside long digit
runs, which breaks patterns anchored on them.

## Redaction is mosaic-then-blur, not blur

A Gaussian blur over a small block of printed digits leaves stroke-level
structure behind, recoverable by eye and trivially by a deblurring model. Every
region is therefore collapsed to a coarse mosaic first — that is the step that
throws the pixels away — and blurred second to hide the mosaic edges. Regions
are also padded outward (`BOX_PAD_RATIO`), because OCR boxes hug the glyphs and
ascenders routinely sit outside them.

face-worker's `/redact` applies the same treatment to the `pii_bboxes` field,
which is how the Node pipeline masks faces and text in a single pass.

## Fails closed

Any condition where the service cannot confirm what is in an image — OCR
crashing, the analyzer failing to build or failing on a line, a malformed OCR
result — answers **503**, never `{"regions": []}`. "We found no PII" and "we
could not look" are different answers and only one of them is safe to publish
on; the Node caller turns a 503 into `piiStatus=DEFERRED` and retries, so the
photo is unserveable in the meantime rather than served unmasked.

A `400` is different and means the upload itself was not a decodable image.

## Configuration

| Env | Default | Effect |
|-----|---------|--------|
| `PII_DISABLE_NER` | unset | Set to `1` to drop PERSON/LOCATION/DATE_TIME/NRP. They are the noisiest entities in the set — spaCy will call a sponsor banner a PERSON — but they are also the name, address and DOB printed on every ID card, so they are on by default. |

## Tests

```
python -m unittest discover -s tests
```

Covers the redaction primitives (padding, clamping, destruction) with only
Pillow, so it runs inside the built container:
`docker compose exec image-pii-worker python -m unittest discover -s tests`.
