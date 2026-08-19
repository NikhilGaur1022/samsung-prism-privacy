"""Stateless text PII analysis and context-aware redaction service.

Provides:
1. /api/v1/analyze: Analyzes text for Indian & global PII (Aadhaar, PAN, Voter, Passport,
   GSTIN, Vehicle registration, UPI, IFSC, Bank account, Campus ID, QR token, Secrets,
   Person, Phone, Email, Location, DateTime, etc.) with character offsets.
2. /api/v1/redact: Performs granular consent-aware text redaction:
   - Consented tagged spans: PII entities are masked/redacted, non-PII text is preserved.
   - Unconsented tagged spans: 100% of the span is redacted.
   - Untagged spans: 100% of the untagged span is redacted.
   - Manual override spans: Manually redacted or explicitly unredacted by collection agent.
"""

import logging
from typing import Any, List, Optional
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from presidio_analyzer import AnalyzerEngine, RecognizerResult
from presidio_analyzer.nlp_engine import NlpEngineProvider

# Import custom recognizers from app.py
from app import (
    CUSTOM_RECOGNIZERS,
    TEXT_ENTITIES,
    HIGH_RISK_ENTITIES,
    ENTITY_PRIORITY,
    typed_token,
    sentence_spans,
    should_keep_result,
    resolve_overlaps,
    clone_result_with_offset,
)

logger = logging.getLogger("text-services")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Prism Pure Text Redaction Pipeline", version="1.0.0")

_recognizers = None

def get_recognizers():
    global _recognizers
    if _recognizers is None:
        from presidio_analyzer import PatternRecognizer, Pattern
        recs = [
            PatternRecognizer(
                supported_entity="EMAIL_ADDRESS",
                patterns=[Pattern(name="email", regex=r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b", score=0.85)],
                context=["email", "contact", "mail", "inbox"],
            ),
            PatternRecognizer(
                supported_entity="PHONE_NUMBER",
                patterns=[
                    Pattern(name="phone_in", regex=r"\b(?:\+91[-.\s]?)?[6-9]\d{9}\b", score=0.85),
                    Pattern(name="phone_general", regex=r"\b(?:\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b", score=0.75),
                ],
                context=["phone", "mobile", "contact", "call", "cell", "tel"],
            ),
            PatternRecognizer(
                supported_entity="IP_ADDRESS",
                patterns=[Pattern(name="ipv4", regex=r"\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b", score=0.85)],
                context=["ip", "host", "address", "server"],
            ),
            PatternRecognizer(
                supported_entity="CREDIT_CARD",
                patterns=[Pattern(name="cc", regex=r"\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12})\b", score=0.85)],
                context=["card", "credit", "debit", "visa", "mastercard"],
            ),
            PatternRecognizer(
                supported_entity="CRYPTO",
                patterns=[Pattern(name="btc", regex=r"\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b", score=0.80)],
                context=["wallet", "bitcoin", "crypto", "btc", "eth"],
            ),
            *[factory() for factory in CUSTOM_RECOGNIZERS]
        ]
        _recognizers = recs
        logger.info("Loaded %d high-speed recognizers", len(recs))
    return _recognizers

# --- Request & Response Models ---

class EntityMatch(BaseModel):
    entity_type: str
    start: int
    end: int
    score: float
    text: str


class AnalyzeRequest(BaseModel):
    text: str
    score_threshold: float = Field(default=0.35, ge=0.0, le=1.0)
    entities: Optional[List[str]] = None


class AnalyzeResponse(BaseModel):
    char_count: int
    entities: List[EntityMatch]


def run_pii_analysis(text: str, target_entities: Optional[List[str]] = None, score_threshold: float = 0.35) -> List[EntityMatch]:
    if not text:
        return []
    recs = get_recognizers()
    target_set = set(target_entities or TEXT_ENTITIES)
    raw_results = []

    sentences = sentence_spans(text)
    for sentence in sentences:
        for r in recs:
            supported = getattr(r, "supported_entities", [])
            if target_set and not any(ent in target_set for ent in supported):
                continue
            try:
                matches = r.analyze(text=sentence.text, entities=list(supported))
                if matches:
                    for match in matches:
                        if match.score >= score_threshold and match.entity_type in target_set:
                            global_res = clone_result_with_offset(match, sentence.start)
                            if should_keep_result(text, sentence, global_res):
                                raw_results.append(global_res)
            except Exception as exc:
                logger.warning("Recognizer %s failed: %s", getattr(r, "name", "unknown"), exc)

    resolved = resolve_overlaps(raw_results)
    return [
        EntityMatch(
            entity_type=r.entity_type,
            start=r.start,
            end=r.end,
            score=round(r.score, 4),
            text=text[r.start:r.end],
        )
        for r in resolved
    ]


class SpanInstruction(BaseModel):
    start: int
    end: int
    action: str = Field(
        ...,
        description="KEEP_NON_PII | REDACT_ALL | REDACT_PII | MANUAL_REDACT | MANUAL_UNREDACT",
    )
    reason: Optional[str] = None
    subject_id: Optional[str] = None
    consent_id: Optional[str] = None
    pii_type: Optional[str] = None


class RedactRequest(BaseModel):
    text: str
    spans: List[SpanInstruction] = Field(default_factory=list)
    default_action: str = Field(default="REDACT_ALL", description="Action for spans of text not explicitly tagged")


class RedactedInterval(BaseModel):
    start: int
    end: int
    original_text: str
    replacement: str
    reason: str
    pii_type: Optional[str] = None


class RedactResponse(BaseModel):
    original_text: str
    redacted_text: str
    redacted_intervals: List[RedactedInterval]


@app.get("/health")
def health():
    return {"status": "ok", "service": "text-services"}


@app.post("/api/v1/analyze", response_model=AnalyzeResponse)
def analyze_text(req: AnalyzeRequest):
    """Analyzes text and returns all detected PII entities with start/end character offsets."""
    text = req.text
    if not text:
        return AnalyzeResponse(char_count=0, entities=[])

    entities = run_pii_analysis(
        text=text,
        target_entities=req.entities or TEXT_ENTITIES,
        score_threshold=req.score_threshold,
    )
    return AnalyzeResponse(char_count=len(text), entities=entities)


@app.post("/api/v1/redact", response_model=RedactResponse)
def redact_text(req: RedactRequest):
    """Executes consent-driven text redaction on the document text.
    
    Rules:
    - Consented & general text prose is preserved.
    - All PII entities (phones, emails, IDs, names, secrets, etc.) are masked with <REDACTED_TYPE>.
    - Explicitly unconsented subject quotes are replaced with <UNCONSENTED_SUBJECT>.
    - Manual agent redactions are replaced with <AGENT_MANUAL_REDACTION> or custom token.
    - Manual keep (unredact) overrides preserve the exact text verbatim.
    """
    text = req.text
    if not text:
        return RedactResponse(original_text="", redacted_text="", redacted_intervals=[])

    text_len = len(text)

    # 1. Run PII detection across the document
    pii_matches = run_pii_analysis(text=text, target_entities=TEXT_ENTITIES)

    # 2. Build cut intervals
    cuts: List[RedactedInterval] = []

    # Check for spans that require full-span masking (e.g. Unconsented subject or Manual Redaction)
    for span in req.spans:
        clamped_start = max(0, min(span.start, text_len))
        clamped_end = max(clamped_start, min(span.end, text_len))
        span_text = text[clamped_start:clamped_end]
        if not span_text:
            continue

        if span.action in ("REDACT_ALL", "MANUAL_REDACT"):
            reason = span.reason or ("UNCONSENTED_SUBJECT" if span.subject_id else "AGENT_MANUAL_REDACTION")
            token = f"<{reason}>" if not reason.startswith("<") else reason
            cuts.append(
                RedactedInterval(
                    start=clamped_start,
                    end=clamped_end,
                    original_text=span_text,
                    replacement=token,
                    reason=reason,
                    pii_type=span.pii_type,
                )
            )

    # Manual unredact spans (keep verbatim)
    manual_unredact_spans = [
        (max(0, min(s.start, text_len)), max(0, min(s.end, text_len)))
        for s in req.spans
        if s.action == "MANUAL_UNREDACT"
    ]

    # For PII matches: include them UNLESS they fall inside a MANUAL_UNREDACT span or are covered by a full cut
    for m in pii_matches:
        # Check if overridden by manual unredact
        is_unredacted = any(u_start <= m.start and m.end <= u_end for u_start, u_end in manual_unredact_spans)
        if is_unredacted:
            continue

        # Check if already covered by an existing cut
        is_covered = any(c.start <= m.start and m.end <= c.end for c in cuts)
        if not is_covered:
            token = typed_token(m.entity_type)
            cuts.append(
                RedactedInterval(
                    start=m.start,
                    end=m.end,
                    original_text=text[m.start:m.end],
                    replacement=token,
                    reason=f"PII_{m.entity_type}_FOUND",
                    pii_type=m.entity_type,
                )
            )

    # 3. Sort cuts by start position and deduplicate overlapping cuts
    cuts = sorted(cuts, key=lambda c: (c.start, -(c.end - c.start)))

    deduped_cuts: List[RedactedInterval] = []
    last_end = 0
    for cut in cuts:
        if cut.start >= last_end:
            deduped_cuts.append(cut)
            last_end = cut.end

    # 4. Reconstruct the redacted document text
    result_pieces = []
    curr = 0
    for cut in deduped_cuts:
        if cut.start > curr:
            result_pieces.append(text[curr:cut.start])
        result_pieces.append(cut.replacement)
        curr = cut.end
    if curr < text_len:
        result_pieces.append(text[curr:])

    redacted_text = "".join(result_pieces)

    return RedactResponse(
        original_text=text,
        redacted_text=redacted_text,
        redacted_intervals=deduped_cuts,
    )
