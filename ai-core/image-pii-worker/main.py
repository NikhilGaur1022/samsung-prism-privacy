"""Stateless image PII detection and redaction service.

Takes a photo, OCRs it to get words/lines with pixel bounding boxes, runs the
ported Indian-PII Presidio recognizers (Aadhaar, PAN, GSTIN, voter ID,
passport, driving licence, vehicle registration/license plate, UPI, IFSC, bank
account, PIN code, campus/roll ID, QR tokens, secrets) plus Presidio's
built-ins (names, addresses, dates, phone, email, cards, IBAN, IP, URL, crypto)
over the recognized text, and either returns the pixel regions that should be
blurred (`/detect-pii`) or returns the image with them already destroyed
(`/redact-pii`, `/redact`).

Holds no state and talks to no database, matching face-worker's shape: an
image goes in, boxes or bytes come out, nothing is persisted here.

Fails CLOSED. Every path that cannot confirm what is in the image answers 503,
never an empty region list — "we found no PII" and "we could not look" are not
the same answer, and only one of them is safe to publish on.
"""

import io
import json
import logging
import os

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from PIL import Image
from presidio_analyzer import AnalyzerEngine
from presidio_analyzer.nlp_engine import NlpEngineProvider
from rapidocr_onnxruntime import RapidOCR

from pii_recognizers import CUSTOM_RECOGNIZERS, IDENTIFIER_ENTITIES, NER_ENTITIES
from redaction import redact_regions

logger = logging.getLogger("image-pii-worker")

app = FastAPI(title="Prism Image PII Worker")

# Score threshold for keeping a Presidio match. Lower than the text-services
# default (0.35) because OCR text is noisier than clean typed text, and a
# missed blur is worse than an extra one for this service's purpose.
SCORE_THRESHOLD = 0.4

JPEG_QUALITY = 92

# Names, addresses and dates are the noisiest half of the set. On by default —
# they are printed on every ID card this pipeline sees — but a deployment that
# would rather keep banner text legible can drop them without a rebuild.
NER_ENABLED = os.getenv("PII_DISABLE_NER", "").strip().lower() not in {"1", "true", "yes"}

REQUESTED_ENTITIES = IDENTIFIER_ENTITIES + (NER_ENTITIES if NER_ENABLED else [])

_ocr_engine: RapidOCR | None = None
_analyzer: AnalyzerEngine | None = None
_entities: list[str] | None = None


def get_ocr_engine() -> RapidOCR:
    """Lazily builds the OCR engine. rapidocr-onnxruntime's ONNX weights ship
    inside the wheel, so nothing is fetched here — but loading them into three
    sessions is slow, and doing it at import time would make /health wait on
    work it does not need."""
    global _ocr_engine
    if _ocr_engine is None:
        _ocr_engine = RapidOCR()
    return _ocr_engine


def get_analyzer() -> AnalyzerEngine:
    """Lazily builds the Presidio analyzer with the ported Indian recognizers
    registered alongside Presidio's built-ins (PHONE_NUMBER etc.).

    Requires the spaCy `en_core_web_sm` model to already be downloaded (see
    README) — Presidio's AnalyzerEngine needs an NLP engine for tokenization,
    and the built-in PERSON/LOCATION/DATE_TIME entities are NER-based.
    """
    global _analyzer
    if _analyzer is None:
        configuration = {
            "nlp_engine_name": "spacy",
            "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}],
        }
        provider = NlpEngineProvider(nlp_configuration=configuration)
        nlp_engine = provider.create_engine()

        analyzer = AnalyzerEngine(nlp_engine=nlp_engine, supported_languages=["en"])
        for recognizer_factory in CUSTOM_RECOGNIZERS:
            analyzer.registry.add_recognizer(recognizer_factory())

        # Presidio raises on an entity no loaded recognizer supports, which
        # would turn a typo in the allow-list into a 503 on every photo. Ask
        # only for what the registry can actually answer, and say loudly which
        # requested entity is going unchecked.
        global _entities
        supported = set(analyzer.get_supported_entities(language="en"))
        _entities = [entity for entity in REQUESTED_ENTITIES if entity in supported]
        missing = [entity for entity in REQUESTED_ENTITIES if entity not in supported]
        if missing:
            logger.error("No recognizer for requested PII entities, they will NOT be blurred: %s", missing)
        if not _entities:
            raise RuntimeError("No requested PII entity has a recognizer — refusing to scan")

        _analyzer = analyzer
    return _analyzer


def ocr_boxes_to_bbox(box_points) -> list[int]:
    """Converts a 4-corner OCR box (list of [x, y] points) to an axis-aligned
    [x1, y1, x2, y2] pixel bbox."""
    xs = [point[0] for point in box_points]
    ys = [point[1] for point in box_points]
    return [int(round(min(xs))), int(round(min(ys))), int(round(max(xs))), int(round(max(ys)))]


def load_image(raw: bytes) -> Image.Image:
    try:
        return Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Unreadable image: {exc}") from exc


def analyze_line(analyzer: AnalyzerEngine, line_text: str):
    """Runs the analyzer over one OCR line, then over a de-spaced variant.

    OCR routinely drops or invents spaces inside long digit runs, which breaks
    patterns anchored on them ("2345 6789 0123" arriving as "234567890123" or
    "2345 67890123"). The second pass is over `line_text` with whitespace
    removed. Offsets from that pass do not map back to the original string, so
    only the fact that something matched is used — the whole OCR line box is
    what gets blurred either way, so nothing is lost by not mapping them.
    """
    results = analyzer.analyze(
        text=line_text,
        language="en",
        entities=_entities,
        score_threshold=SCORE_THRESHOLD,
    )
    if results:
        return [(r.entity_type, line_text[r.start : r.end]) for r in results]

    compact = "".join(line_text.split())
    if compact == line_text or len(compact) < 6:
        return []

    compact_results = analyzer.analyze(
        text=compact,
        language="en",
        entities=_entities,
        score_threshold=SCORE_THRESHOLD,
    )
    return [(r.entity_type, compact[r.start : r.end]) for r in compact_results]


def find_pii_entities(image: Image.Image) -> list[dict]:
    """OCR + PII analysis over one image. Raises HTTPException(503) if any part
    of the scan could not complete — see the fail-closed note at module level."""
    rgb = np.array(image)

    try:
        ocr_result, _ = get_ocr_engine()(rgb)
    except Exception as exc:
        # This used to be swallowed into "nothing found", which handed the
        # caller a 200 and an empty region list for an image nobody had
        # actually read. An OCR crash is not evidence of a clean photo.
        logger.exception("OCR failed")
        raise HTTPException(status_code=503, detail=f"OCR unavailable: {exc}") from exc

    if not ocr_result:
        return []

    try:
        analyzer = get_analyzer()
    except Exception as exc:
        logger.exception("Presidio analyzer unavailable")
        raise HTTPException(status_code=503, detail=f"PII analyzer unavailable: {exc}") from exc

    entities: list[dict] = []

    for line in ocr_result:
        try:
            box_points, line_text, _score = line
        except Exception as exc:
            logger.exception("Malformed OCR line")
            raise HTTPException(status_code=503, detail=f"Malformed OCR result: {exc}") from exc

        if not line_text or not line_text.strip():
            continue

        try:
            matches = analyze_line(analyzer, line_text)
        except Exception as exc:
            # Skipping the line would mean answering "clean" for text that was
            # never actually examined. Fail the request instead; the caller
            # parks the photo and retries.
            logger.exception("Analyzer failed on an OCR line")
            raise HTTPException(status_code=503, detail=f"PII analysis failed: {exc}") from exc

        if not matches:
            continue

        bbox = ocr_boxes_to_bbox(box_points)
        if bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
            continue

        for entity_type, text in matches:
            entities.append({"type": entity_type, "text": text, "bbox": bbox})

    return entities


def dedupe_regions(entities: list[dict]) -> list[list[int]]:
    """One box per distinct region. Several entities on one OCR line all carry
    that line's box, and blurring the same rectangle five times is just wasted
    work."""
    seen: set[tuple[int, ...]] = set()
    regions: list[list[int]] = []
    for entity in entities:
        key = tuple(entity["bbox"])
        if key in seen:
            continue
        seen.add(key)
        regions.append(entity["bbox"])
    return regions


def parse_bboxes(bboxes: str) -> list:
    try:
        parsed = json.loads(bboxes)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid bboxes JSON: {exc}") from exc
    if not isinstance(parsed, list):
        raise HTTPException(status_code=400, detail="bboxes must be a JSON array")
    return parsed


def encode_jpeg(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=JPEG_QUALITY)
    return buffer.getvalue()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/detect-pii")
async def detect_pii(file: UploadFile = File(...)):
    """Regions only. Used by the Node pipeline, which merges these with the
    face boxes it owns and applies both in a single redaction pass."""
    image = load_image(await file.read())
    entities = find_pii_entities(image)
    return {"regions": dedupe_regions(entities), "entities": entities}


@app.post("/redact-pii")
async def redact_pii(file: UploadFile = File(...)):
    """Detect and destroy in one call, returning JPEG bytes.

    Self-contained: a caller that uses this endpoint cannot end up publishing an
    image whose PII was detected but never blurred, because there is no
    intermediate state where it holds boxes and the original. `X-Pii-Regions`
    reports how many regions were applied.
    """
    image = load_image(await file.read())
    entities = find_pii_entities(image)
    applied = redact_regions(image, dedupe_regions(entities))

    return Response(
        content=encode_jpeg(image),
        media_type="image/jpeg",
        headers={"X-Pii-Regions": str(applied), "X-Pii-Entities": str(len(entities))},
    )


@app.post("/redact")
async def redact(file: UploadFile = File(...), bboxes: str = Form(...)):
    """Destroy caller-supplied regions without detecting anything.

    Same contract as face-worker's /redact so either service can apply a box
    list, but the redaction here is the text-grade one (mosaic then blur)
    rather than a plain Gaussian.
    """
    image = load_image(await file.read())
    applied = redact_regions(image, parse_bboxes(bboxes))
    return Response(
        content=encode_jpeg(image),
        media_type="image/jpeg",
        headers={"X-Pii-Regions": str(applied)},
    )
