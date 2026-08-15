from presidio_analyzer import AnalyzerEngine

_analyzer: AnalyzerEngine | None = None

# Entity set carried over from the original prototype. Unlike
# image-pii-worker (which has ported Indian-specific recognizers for
# Aadhaar/PAN/GSTIN/etc.), this only needs Presidio's built-ins because
# transcript text is spoken language, not scanned ID documents.
PII_ENTITIES = [
    "PHONE_NUMBER",
    "EMAIL_ADDRESS",
    "CREDIT_CARD",
    "PERSON",
    "LOCATION",
    "DATE_TIME",
    "NRP",
    "STREET_ADDRESS",
]


def get_pii_analyzer() -> AnalyzerEngine:
    """Lazily builds the Presidio analyzer with its default NLP engine.
    Mirrors image-pii-worker.get_analyzer()'s lazy-load reasoning."""
    global _analyzer
    if _analyzer is None:
        _analyzer = AnalyzerEngine()
    return _analyzer


def find_pii_spans(text: str) -> list[dict]:
    """Runs Presidio over one transcript line and returns entity spans as
    character offsets local to `text`. Time-mapping those offsets back onto
    the audio is the caller's job (it has the word timestamps)."""
    if not text or not text.strip():
        return []

    analyzer = get_pii_analyzer()
    results = analyzer.analyze(text=text, language="en", entities=PII_ENTITIES)
    return [
        {"type": r.entity_type, "start": r.start, "end": r.end, "score": r.score}
        for r in results
    ]
