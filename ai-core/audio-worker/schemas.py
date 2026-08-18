from pydantic import BaseModel


class DiarizedSegment(BaseModel):
    """One transcribed utterance, attributed to a diarization speaker slot
    (SPEAKER_00, SPEAKER_01, ...) — not yet a subject identity."""

    start: float
    end: float
    speaker_id: str
    transcript: str


class SpeakerEmbedding(BaseModel):
    """A 192-d ECAPA-TDNN voice vector for one diarization speaker slot,
    taken from that speaker's longest turn.

    This replaces the old SpeakerMatch. The worker no longer decides WHO a
    slot is — it reports what the voice sounds like and the backend searches
    its own gallery of enrolled subjects. Identity is a consent-bearing fact
    and belongs on the side of the wire that can see consent.

    `embedding` is None when the slot's longest turn is below
    MIN_UTTERANCE_DURATION, i.e. too short to embed meaningfully, or when
    embedding raised. Both mean the same thing to the caller and must be
    handled the same way: not identifiable, therefore an unconsented
    bystander, therefore muted. `reason` says which, for the operator.
    """

    speaker_id: str
    embedding: list[float] | None
    longest_turn_sec: float
    reason: str | None = None


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
    speaker_embeddings: list[SpeakerEmbedding]
    pii_spans: list[PiiSpan]


class EmbedResponse(BaseModel):
    """One voice vector for a whole clip — the enrollment path.

    Separate from /analyze because enrollment is one person speaking on
    purpose: there is nothing to diarize, nothing to transcribe, and no PII
    decision to make. Running the enrollment clip through /analyze would load
    Whisper and pyannote to answer a question neither of them is being asked.
    """

    embedding: list[float]
    dim: int
    duration_sec: float
