from pydantic import BaseModel


class DiarizedSegment(BaseModel):
    """One transcribed utterance, attributed to a diarization speaker slot
    (SPEAKER_00, SPEAKER_01, ...) — not yet a subject identity."""

    start: float
    end: float
    speaker_id: str
    transcript: str


class SpeakerMatch(BaseModel):
    """Result of matching one diarized speaker slot against the uploaded
    voice snippets. `matched_muid` is None when no snippet cleared the
    similarity threshold — the caller decides what that means (usually:
    treat as an unconsented bystander)."""

    speaker_id: str
    matched_muid: str | None
    score: float


class PiiSpan(BaseModel):
    """A PII entity detected in a transcript segment, in audio-time seconds
    (already mapped from Presidio's character offsets), attributed to the
    speaker slot that was talking at that moment."""

    start: float
    end: float
    type: str
    speaker_id: str


class AnalyzeResponse(BaseModel):
    segments: list[DiarizedSegment]
    speaker_matches: list[SpeakerMatch]
    pii_spans: list[PiiSpan]
