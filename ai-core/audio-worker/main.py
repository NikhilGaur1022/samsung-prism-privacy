"""Stateless audio worker: diarization + transcription + speaker-ID +
transcript PII detection, and a separate mute-interval execution step.

Holds no state and talks to no database, matching face-worker and
image-pii-worker's shape. In particular, this service makes NO consent
decisions and NO redact/keep decisions — /analyze only detects and reports;
/redact only executes an interval list it's handed. The backend is the only
place that ever sees `project_consent_matrix` and turns detection output
into a decision.
"""

import json
import logging
import os
import shutil
import tempfile
import uuid
from types import SimpleNamespace

from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile

from config import settings
from diarization import diarize
from pii_text import find_pii_spans
from redact import apply_mute_intervals
from schemas import AnalyzeResponse, DiarizedSegment, PiiSpan, SpeakerMatch
from speaker_id import extract_voice_vector, match_speaker
from transcription import transcribe

logger = logging.getLogger("audio-worker")

app = FastAPI(
    title=settings.PROJECT_NAME,
    version="1.0.0",
    docs_url=f"{settings.API_V1_STR}/docs",
    openapi_url=f"{settings.API_V1_STR}/openapi.json",
)


@app.get("/health")
def health():
    return {"status": "ok"}


def _speaker_for_segment(turns: list[dict], seg_start: float, seg_end: float) -> str | None:
    """Which diarization speaker slot was talking during [seg_start, seg_end].

    Uses maximum time overlap to prevent boundary jitter from dropping speakers
    to UNKNOWN. Falls back to midpoint check or closest turn.
    """
    if not turns:
        return None

    best_speaker = None
    max_overlap = 0.0
    for turn in turns:
        overlap = max(0.0, min(seg_end, turn["end"]) - max(seg_start, turn["start"]))
        if overlap > max_overlap:
            max_overlap = overlap
            best_speaker = turn["speaker_id"]

    if best_speaker is not None and max_overlap > 0:
        return best_speaker

    # Fall back to midpoint
    mid = (seg_start + seg_end) / 2
    for turn in turns:
        if turn["start"] <= mid <= turn["end"]:
            return turn["speaker_id"]

    # Fall back to closest turn
    closest = min(
        turns,
        key=lambda t: min(abs(t["start"] - seg_end), abs(t["end"] - seg_start)),
    )
    return closest["speaker_id"]


def _map_pii_span_to_time(seg, span: dict) -> tuple[float, float]:
    """Presidio's span is a character offset local to seg.text; map it to
    word timestamps when available, else fall back to the whole segment's time
    range so nothing gets silently dropped for lack of word-level alignment.
    """
    words = getattr(seg, "words", None) or []
    seg_text = getattr(seg, "text", "") or ""
    if not words or not seg_text:
        return seg.start, seg.end

    span_start = span["start"]
    span_end = span["end"]

    # Compute character boundaries for each word within seg_text
    word_spans = []
    curr_idx = 0
    for w in words:
        w_text = getattr(w, "word", "").strip()
        if not w_text:
            continue
        idx = seg_text.find(w_text, curr_idx)
        if idx == -1:
            idx = curr_idx
        w_start_char = idx
        w_end_char = idx + len(w_text)
        curr_idx = w_end_char
        word_spans.append((w_start_char, w_end_char, w.start, w.end))

    matching = [
        (ws, we)
        for w_sc, w_ec, ws, we in word_spans
        if not (w_ec <= span_start or w_sc >= span_end)
    ]
    if matching:
        return matching[0][0], matching[-1][1]

    return seg.start, seg.end


@app.post(f"{settings.API_V1_STR}/analyze", response_model=AnalyzeResponse)
async def analyze(
    main_audio: UploadFile = File(...),
    voice_snippets: list[UploadFile] = File(default=[]),
    snippet_muids: str = Form(default="[]"),
    min_speakers: int | None = Form(default=None),
    max_speakers: int | None = Form(default=None),
):
    """Detection only — no consent lookups, no redaction decisions.

    `snippet_muids` is a JSON array positionally aligned with
    `voice_snippets`, e.g. '["<subject-uuid-1>", "<subject-uuid-2>"]' for two
    uploaded reference snippets. The caller (backend) already knows which
    subjects are on this project and supplies their enrollment voice clips —
    this worker never looks that up itself.
    """
    try:
        muids = json.loads(snippet_muids)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="snippet_muids must be a JSON array")

    if len(muids) != len(voice_snippets):
        raise HTTPException(
            status_code=400,
            detail="snippet_muids length must match voice_snippets length",
        )

    with tempfile.TemporaryDirectory() as tmp:
        audio_ext = os.path.splitext(main_audio.filename or "")[1] or ".wav"
        audio_path = os.path.join(tmp, f"main{audio_ext}")
        with open(audio_path, "wb") as f:
            shutil.copyfileobj(main_audio.file, f)

        registered_vectors: dict[str, list[float]] = {}
        for muid, snippet in zip(muids, voice_snippets):
            snippet_ext = os.path.splitext(snippet.filename or "")[1] or ".wav"
            snippet_path = os.path.join(tmp, f"snippet_{uuid.uuid4().hex}{snippet_ext}")
            with open(snippet_path, "wb") as f:
                shutil.copyfileobj(snippet.file, f)
            try:
                registered_vectors[muid] = extract_voice_vector(snippet_path)
            except Exception as exc:
                # One bad reference snippet must not fail the whole request —
                # that subject simply can't be matched, which the response
                # will reflect via an unmatched speaker slot.
                logger.warning("Could not embed voice snippet for %s: %s", muid, exc)

        effective_min_speakers = min_speakers or settings.MIN_SPEAKERS
        if effective_min_speakers is None and len(voice_snippets) > 0:
            effective_min_speakers = max(2, len(voice_snippets))

        effective_max_speakers = max_speakers or settings.MAX_SPEAKERS

        try:
            turns = diarize(
                audio_path,
                min_speakers=effective_min_speakers,
                max_speakers=effective_max_speakers,
            )
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Diarization failed: {exc}") from exc

        try:
            transcript_segments = transcribe(audio_path)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Transcription failed: {exc}") from exc

        # Anchor each speaker's identity match to their single longest turn —
        # more signal, less risk of matching on a noisy short clip.
        best_turn_by_speaker: dict[str, dict] = {}
        for turn in turns:
            duration = turn["end"] - turn["start"]
            current = best_turn_by_speaker.get(turn["speaker_id"])
            if current is None or duration > (current["end"] - current["start"]):
                best_turn_by_speaker[turn["speaker_id"]] = turn

        speaker_matches: list[SpeakerMatch] = []
        for speaker_id, turn in best_turn_by_speaker.items():
            duration = turn["end"] - turn["start"]
            if duration < settings.MIN_UTTERANCE_DURATION or not registered_vectors:
                speaker_matches.append(
                    SpeakerMatch(speaker_id=speaker_id, matched_muid=None, score=0.0)
                )
                continue
            try:
                embedding = extract_voice_vector(audio_path, turn["start"], turn["end"])
                muid, score = match_speaker(
                    embedding, registered_vectors, settings.SIMILARITY_THRESHOLD
                )
            except Exception as exc:
                logger.warning("Speaker match failed for %s: %s", speaker_id, exc)
                muid, score = None, 0.0
            speaker_matches.append(
                SpeakerMatch(speaker_id=speaker_id, matched_muid=muid, score=score)
            )

        # Collect all word timestamps across whisper segments
        all_words = []
        for seg in transcript_segments:
            for w in (getattr(seg, "words", None) or []):
                all_words.append(w)

        segments_out: list[DiarizedSegment] = []
        pii_spans_out: list[PiiSpan] = []

        if turns:
            for turn in turns:
                t_start = turn["start"]
                t_end = turn["end"]
                speaker_id = turn["speaker_id"]
                turn_words = [
                    w
                    for w in all_words
                    if not (w.end <= t_start or w.start >= t_end)
                ]
                turn_text = " ".join(
                    getattr(w, "word", "").strip()
                    for w in turn_words
                    if getattr(w, "word", "").strip()
                ).strip()

                segments_out.append(
                    DiarizedSegment(
                        start=t_start,
                        end=t_end,
                        speaker_id=speaker_id,
                        transcript=turn_text,
                    )
                )

                if turn_text:
                    turn_mock = SimpleNamespace(
                        text=turn_text, words=turn_words, start=t_start, end=t_end
                    )
                    for span in find_pii_spans(turn_text):
                        word_start, word_end = _map_pii_span_to_time(turn_mock, span)
                        pii_spans_out.append(
                            PiiSpan(
                                start=word_start,
                                end=word_end,
                                type=span["type"],
                                speaker_id=speaker_id,
                            )
                        )
        else:
            for seg in transcript_segments:
                speaker_id = "UNKNOWN"
                segments_out.append(
                    DiarizedSegment(
                        start=seg.start,
                        end=seg.end,
                        speaker_id=speaker_id,
                        transcript=seg.text,
                    )
                )
                for span in find_pii_spans(seg.text):
                    word_start, word_end = _map_pii_span_to_time(seg, span)
                    pii_spans_out.append(
                        PiiSpan(
                            start=word_start,
                            end=word_end,
                            type=span["type"],
                            speaker_id=speaker_id,
                        )
                    )

        return AnalyzeResponse(
            segments=segments_out,
            speaker_matches=speaker_matches,
            pii_spans=pii_spans_out,
        )


@app.post(f"{settings.API_V1_STR}/redact")
async def redact(
    main_audio: UploadFile = File(...),
    intervals: str = Form(...),
):
    """Pure execution: mute the given [start, end] second ranges and return
    the redacted audio bytes.

    Takes no position on *why* an interval is muted — that decision was
    already made by the caller using /analyze's output joined against real
    consent data. This mirrors face-worker's /redact, which takes bboxes it
    did not compute itself.
    """
    try:
        parsed_intervals = json.loads(intervals)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="intervals must be a JSON array")

    if not isinstance(parsed_intervals, list):
        raise HTTPException(status_code=400, detail="intervals must be a JSON array")

    with tempfile.TemporaryDirectory() as tmp:
        audio_ext = os.path.splitext(main_audio.filename or "")[1] or ".wav"
        input_path = os.path.join(tmp, f"input{audio_ext}")
        output_path = os.path.join(tmp, "output.wav")
        with open(input_path, "wb") as f:
            shutil.copyfileobj(main_audio.file, f)

        try:
            apply_mute_intervals(input_path, output_path, parsed_intervals)
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        with open(output_path, "rb") as f:
            data = f.read()

    return Response(content=data, media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8003, reload=True)
