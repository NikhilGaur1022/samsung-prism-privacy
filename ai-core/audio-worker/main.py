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
import threading

from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile

from audio_io import to_wav16k
from config import settings
from diarization import diarize, get_diarization_pipeline
from pii_text import find_pii_spans, get_pii_analyzer
from redact import apply_mute_intervals
from schemas import (
    AnalyzeResponse,
    DiarizedSegment,
    EmbedResponse,
    PiiSpan,
    SpeakerEmbedding,
)
from speaker_id import audio_duration_sec, extract_voice_vector, get_speaker_embedding_model
from transcription import transcribe, get_whisper_model

logger = logging.getLogger("audio-worker")

app = FastAPI(
    title=settings.PROJECT_NAME,
    version="1.0.0",
    docs_url=f"{settings.API_V1_STR}/docs",
    openapi_url=f"{settings.API_V1_STR}/openapi.json",
)

# Every endpoint below that touches a model is `def`, never `async def`.
#
# FastAPI runs a sync handler in its threadpool and an async one directly on the
# event loop. Diarization, transcription and embedding are seconds-to-minutes of
# blocking CPU work, and on the loop they froze the whole process: /health
# stopped answering mid-analysis, so the container read as dead, every queued
# request sat unread on the socket, and the backend's 180s timeout fired against
# a worker that was making progress the entire time. The keyword is the fix.

# --- warm-up ----------------------------------------------------------------
# Each of the four loaders below is lazy, which was right when the alternative
# was blocking import. It was wrong as the only strategy: the first real request
# paid for ~1.2 GB of downloads (pyannote, whisper-small, ECAPA) plus, on an
# image built before the spaCy layer, a 382 MB en_core_web_lg fetch shelled out
# from inside the handler. That is minutes of work charged to whoever clicks
# Analyze first, and it looked like a hang rather than a cold start.
#
# So they are warmed on a background thread at boot instead. /health answers
# immediately either way — it is a liveness probe and must never depend on a
# model. /ready reports the warm state, which is what an operator (and the
# portal) needs to distinguish "still loading" from "broken".
_WARMUP = {"state": "cold", "error": None}


def _warm_models() -> None:
    _WARMUP["state"] = "warming"
    for name, loader in (
        ("pii", get_pii_analyzer),
        ("whisper", get_whisper_model),
        ("speaker", get_speaker_embedding_model),
        ("diarization", get_diarization_pipeline),
    ):
        try:
            loader()
            logger.info("warm-up: %s ready", name)
        except Exception as exc:
            # A missing HF_TOKEN must not take the service down — /embed and
            # /redact do not need pyannote, and reporting which model failed is
            # more useful than refusing to start.
            logger.warning("warm-up: %s unavailable: %s", name, exc)
            _WARMUP["error"] = f"{name}: {exc}"
    _WARMUP["state"] = "ready"


@app.on_event("startup")
def _start_warmup() -> None:
    threading.Thread(target=_warm_models, name="model-warmup", daemon=True).start()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/ready")
def ready():
    """Liveness is /health; this is readiness. Separate on purpose — a warming
    worker is alive and must not be restarted by an orchestrator, but it is also
    not yet able to answer /analyze quickly."""
    return {
        "status": "ok" if _WARMUP["state"] == "ready" else "warming",
        "models": _WARMUP["state"],
        "error": _WARMUP["error"],
    }


def _speaker_for_segment(turns: list[dict], seg_start: float, seg_end: float) -> str | None:
    """Which diarization speaker slot was talking during [seg_start, seg_end].

    Scored by maximum time overlap rather than by whoever held the midpoint.
    Whisper's segment boundaries and pyannote's turn boundaries are drawn by
    different models and rarely line up, so a midpoint that lands a few tens of
    milliseconds inside a gap returned None and the whole segment fell to
    UNKNOWN — which the backend reads as an unidentified speaker and mutes.
    Overlap degrades gracefully where the midpoint did not; the two fallbacks
    below cover the case where a segment overlaps no turn at all.
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

    mid = (seg_start + seg_end) / 2
    for turn in turns:
        if turn["start"] <= mid <= turn["end"]:
            return turn["speaker_id"]

    return min(
        turns,
        key=lambda t: min(abs(t["start"] - seg_end), abs(t["end"] - seg_start)),
    )["speaker_id"]


def _map_pii_span_to_time(seg, span: dict) -> tuple[float, float]:
    """Presidio's span is a character offset local to seg.text; map it to word
    timestamps when available, else fall back to the whole segment's time range
    so nothing gets silently dropped for lack of word-level alignment.

    faster-whisper's Word carries `word`, `start` and `end` but no character
    offsets, so the offsets are recovered by walking seg.text and locating each
    word in order. An earlier version read `w.start_char`/`w.end_char`, which
    never exist — every PII span silently widened to its whole segment, muting
    far more speech than the detection asked for.
    """
    words = getattr(seg, "words", None) or []
    seg_text = getattr(seg, "text", "") or ""
    if not words or not seg_text:
        return seg.start, seg.end

    span_start = span["start"]
    span_end = span["end"]

    word_spans = []
    curr_idx = 0
    for w in words:
        w_text = getattr(w, "word", "").strip()
        if not w_text:
            continue
        idx = seg_text.find(w_text, curr_idx)
        if idx == -1:
            idx = curr_idx
        w_end_char = idx + len(w_text)
        curr_idx = w_end_char
        word_spans.append((idx, w_end_char, w.start, w.end))

    matching = [
        (ws, we)
        for w_sc, w_ec, ws, we in word_spans
        if not (w_ec <= span_start or w_sc >= span_end)
    ]
    if matching:
        return matching[0][0], matching[-1][1]

    return seg.start, seg.end


@app.post(f"{settings.API_V1_STR}/embed", response_model=EmbedResponse)
def embed(audio: UploadFile = File(...)):
    """One clip in, one 192-d speaker vector out. The enrollment path.

    Deliberately says nothing about identity: it does not know whose voice
    this is, does not compare it to anything, and has no way to. The backend
    seals what comes back under the subject's own DEK and stores it as a
    SubjectVoiceEnrollment — see backend/src/modules/enrollment/
    voiceEnrollment.service.js.
    """
    with tempfile.TemporaryDirectory() as tmp:
        ext = os.path.splitext(audio.filename or "")[1] or ".wav"
        path = os.path.join(tmp, f"clip{ext}")
        with open(path, "wb") as f:
            shutil.copyfileobj(audio.file, f)

        try:
            duration = audio_duration_sec(path)
        except Exception as exc:
            raise HTTPException(
                status_code=400, detail=f"Unreadable audio: {exc}"
            ) from exc

        if duration <= 0:
            raise HTTPException(status_code=400, detail="Clip contains no audio")

        try:
            vector = extract_voice_vector(path)
        except Exception as exc:
            # 502, not 400: the clip was readable, so this is the model
            # failing, not the caller. The distinction matters because the
            # backend turns 400 into "re-record" advice for the subject and
            # 502 into an operational error — telling someone to re-record
            # because a model crashed wastes their time and hides an outage.
            logger.exception("Voice embedding failed")
            raise HTTPException(
                status_code=502, detail=f"Voice embedding failed: {exc}"
            ) from exc

    return EmbedResponse(embedding=vector, dim=len(vector), duration_sec=duration)


@app.post(f"{settings.API_V1_STR}/analyze", response_model=AnalyzeResponse)
def analyze(
    main_audio: UploadFile = File(...),
    min_speakers: int | None = Form(default=None),
    max_speakers: int | None = Form(default=None),
):
    """Detection only — no consent lookups, no redaction decisions, and as of
    the gallery migration, no identity decisions either.

    This endpoint used to accept `voice_snippets` + `snippet_muids`: reference
    clips uploaded alongside every request and re-embedded on every call. That
    made speaker identity depend on whoever remembered to attach the right
    WAVs, and meant the worker was matching people. Now it returns one
    embedding per diarized speaker slot and the backend searches its own
    gallery of enrolled subjects, which is where consent lives.
    """
    with tempfile.TemporaryDirectory() as tmp:
        audio_ext = os.path.splitext(main_audio.filename or "")[1] or ".wav"
        upload_path = os.path.join(tmp, f"upload{audio_ext}")
        with open(upload_path, "wb") as f:
            shutil.copyfileobj(main_audio.file, f)

        # Decode once, here, rather than four-plus times downstream. The
        # extension is not evidence of anything: a Chrome MediaRecorder emits
        # WebM/Opus whatever the caller names the file, so this normalises by
        # content and everything below reads plain 16 kHz PCM. See
        # audio_io.to_wav16k.
        audio_path = os.path.join(tmp, "main16k.wav")
        try:
            to_wav16k(upload_path, audio_path)
        except Exception as exc:
            raise HTTPException(
                status_code=400, detail=f"Unreadable audio: {exc}"
            ) from exc

        try:
            turns = diarize(
                audio_path,
                min_speakers=min_speakers or settings.MIN_SPEAKERS,
                max_speakers=max_speakers or settings.MAX_SPEAKERS,
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

        speaker_embeddings: list[SpeakerEmbedding] = []
        for speaker_id, turn in best_turn_by_speaker.items():
            duration = turn["end"] - turn["start"]
            if duration < settings.MIN_UTTERANCE_DURATION:
                speaker_embeddings.append(
                    SpeakerEmbedding(
                        speaker_id=speaker_id,
                        embedding=None,
                        longest_turn_sec=duration,
                        reason="TURN_TOO_SHORT",
                    )
                )
                continue
            try:
                vector = extract_voice_vector(audio_path, turn["start"], turn["end"])
            except Exception as exc:
                # One slot failing must not fail the whole analysis: the other
                # speakers' results are still valid and still needed. This slot
                # comes back with no embedding, which the backend reads as
                # unidentifiable and therefore mutes.
                logger.warning("Speaker embedding failed for %s: %s", speaker_id, exc)
                speaker_embeddings.append(
                    SpeakerEmbedding(
                        speaker_id=speaker_id,
                        embedding=None,
                        longest_turn_sec=duration,
                        reason="EMBEDDING_FAILED",
                    )
                )
                continue
            speaker_embeddings.append(
                SpeakerEmbedding(
                    speaker_id=speaker_id, embedding=vector, longest_turn_sec=duration
                )
            )

        segments_out: list[DiarizedSegment] = []
        pii_spans_out: list[PiiSpan] = []
        for seg in transcript_segments:
            speaker_id = _speaker_for_segment(turns, seg.start, seg.end) or "UNKNOWN"
            segments_out.append(
                DiarizedSegment(
                    start=seg.start, end=seg.end, speaker_id=speaker_id, transcript=seg.text
                )
            )

            for span in find_pii_spans(seg.text):
                word_start, word_end = _map_pii_span_to_time(seg, span)
                pii_spans_out.append(
                    PiiSpan(start=word_start, end=word_end, type=span["type"], speaker_id=speaker_id)
                )

        return AnalyzeResponse(
            segments=segments_out,
            speaker_embeddings=speaker_embeddings,
            pii_spans=pii_spans_out,
        )


@app.post(f"{settings.API_V1_STR}/redact")
def redact(
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
        output_path = os.path.join(tmp, f"output{audio_ext}")
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
