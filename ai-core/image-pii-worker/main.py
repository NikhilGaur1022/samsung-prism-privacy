"""Stateless image PII detection service.

Takes a photo, OCRs it to get words/lines with pixel bounding boxes, runs the
ported Indian-PII Presidio recognizers (Aadhaar, PAN, GSTIN, voter ID,
passport, vehicle registration/license plate, UPI, IFSC, bank account,
campus/roll ID, QR tokens, secrets, phone numbers) over the recognized text,
and returns the pixel regions that should be blurred.

Holds no state and talks to no database, matching face-worker's shape: an
image goes in, boxes come out, nothing is persisted here.
"""

import io
import logging

import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from PIL import Image
from presidio_analyzer import AnalyzerEngine
from presidio_analyzer.nlp_engine import NlpEngineProvider
from rapidocr_onnxruntime import RapidOCR

from pii_recognizers import CUSTOM_RECOGNIZERS, PII_ENTITIES

logger = logging.getLogger("image-pii-worker")

app = FastAPI(title="Prism Image PII Worker")

# Score threshold for keeping a Presidio match. Lower than the text-services
# default (0.35) because OCR text is noisier than clean typed text, and a
# missed blur is worse than an extra one for this service's purpose.
SCORE_THRESHOLD = 0.4

_ocr_engine: RapidOCR | None = None
_analyzer: AnalyzerEngine | None = None


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
    README) — Presidio's AnalyzerEngine needs an NLP engine for tokenization
    even though none of our custom recognizers are NER-based.
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

        _analyzer = analyzer
    return _analyzer


def ocr_boxes_to_bbox(box_points) -> list[int]:
    """Converts a 4-corner OCR box (list of [x, y] points) to an axis-aligned
    [x1, y1, x2, y2] pixel bbox."""
    xs = [point[0] for point in box_points]
    ys = [point[1] for point in box_points]
    return [int(round(min(xs))), int(round(min(ys))), int(round(max(xs))), int(round(max(ys)))]


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/detect-pii")
async def detect_pii(file: UploadFile = File(...)):
    raw = await file.read()
    try:
        image = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Unreadable image: {exc}") from exc

    rgb = np.array(image)

    try:
        ocr_engine = get_ocr_engine()
        ocr_result, _ = ocr_engine(rgb)
    except Exception as exc:
        # OCR failing on a decodable image is treated as "nothing found"
        # rather than a hard failure — the caller still gets a valid response.
        logger.warning("OCR failed, returning no PII regions: %s", exc)
        ocr_result = None

    entities: list[dict] = []

    if ocr_result:
        try:
            analyzer = get_analyzer()
        except Exception as exc:
            logger.warning("Presidio analyzer unavailable, returning no PII regions: %s", exc)
            analyzer = None

        if analyzer is not None:
            for line in ocr_result:
                try:
                    box_points, line_text, _score = line
                    if not line_text or not line_text.strip():
                        continue

                    results = analyzer.analyze(
                        text=line_text,
                        language="en",
                        entities=PII_ENTITIES,
                        score_threshold=SCORE_THRESHOLD,
                    )
                except Exception as exc:
                    # Skip this line only — one bad OCR line must never fail
                    # the whole request.
                    logger.warning("Skipping OCR line due to analyzer error: %s", exc)
                    continue

                if not results:
                    continue

                bbox = ocr_boxes_to_bbox(box_points)
                if bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
                    continue

                for result in results:
                    entities.append(
                        {
                            "type": result.entity_type,
                            "text": line_text[result.start : result.end],
                            "bbox": bbox,
                        }
                    )

    regions = [entity["bbox"] for entity in entities]
    return {"regions": regions, "entities": entities}
