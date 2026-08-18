# audio-worker

Stateless HTTP service: audio in, diarized/transcribed/PII-flagged detection
data out — or a mute-interval list in, redacted audio out. Nothing is stored
here and nothing is looked up here; it holds no database connection and makes
no consent decisions. The backend calls `/analyze`, joins the result against
real `project_consent_matrix` rows, and calls `/redact` with the final
interval list it computed — the same two-step shape used for photo
bystander/PII redaction (`face-worker` + `image-pii-worker`).

## Endpoints

- `GET /health` -> `{"status": "ok"}`
- `POST /api/v1/analyze` (multipart: `main_audio` file — nothing else) ->
  ```json
  {
    "segments": [{"start": 12.4, "end": 15.1, "speaker_id": "SPEAKER_00", "transcript": "..."}],
    "speaker_embeddings": [
      {"speaker_id": "SPEAKER_00", "embedding": [0.0121, -0.0407, "…192 floats"], "longest_turn_sec": 6.2, "reason": null},
      {"speaker_id": "SPEAKER_01", "embedding": null, "longest_turn_sec": 0.9, "reason": "TURN_TOO_SHORT"}
    ],
    "pii_spans": [{"start": 13.0, "end": 13.6, "type": "PHONE_NUMBER", "speaker_id": "SPEAKER_00"}]
  }
  ```
  Detection only, and **no identity**. This endpoint used to take
  `voice_snippets` + `snippet_muids` and return `speaker_matches` with a
  `matched_muid` — it no longer does either. Whoever uploaded the request
  decided who could be recognised, and nothing downstream could tell that the
  wrong person's clip had been attached. Matching now happens in the backend
  against a Qdrant gallery built from persisted `SubjectVoiceEnrollment` rows
  (`backend/src/lib/voiceGallery.js`), for the same reason face matching does:
  this worker holds no state, sees no consent, and must not be a second place
  where "is this person X" gets decided.

  `embedding` is `null` when no embedding could be produced, with `reason`
  saying which case it was (`TURN_TOO_SHORT` below `MIN_UTTERANCE_DURATION`,
  `EMBEDDING_FAILED` for a model error). The caller must treat a speaker it
  cannot identify as an unconsented bystander and mute them — never as
  "probably the closest one".
- `POST /api/v1/embed` (multipart: `audio` file) ->
  ```json
  {"embedding": ["…192 floats"], "dim": 192, "duration_sec": 6.4}
  ```
  One speaker embedding for one enrollment clip, used when a subject enrolls
  their voice. 400 means the audio was unreadable or had no usable speech —
  advice for the person is to re-record. 502 means the model failed — that is
  an operational fault, not something the subject can fix, and the two are kept
  distinct so the backend can say which happened. `duration_sec` is read from
  the file header so the backend enforces its minimum enrollment length against
  what actually arrived, not against a client-supplied form field.
- `POST /api/v1/redact` (multipart: `main_audio` file, `intervals` JSON array
  of `{"start": float, "end": float}`) -> redacted `audio/wav` bytes. Pure
  execution — no identity or consent knowledge, just muting.

## Where the matching threshold lives

Not here. `SIMILARITY_THRESHOLD` was removed from `config.py` and
`.env.example` when matching moved to the backend — set
`VOICE_MATCH_THRESHOLD` in `backend/.env` instead. The value carried over
unchanged (0.10, a cosine *similarity*, higher being a closer match), and it
is not calibrated: it sits well below published ECAPA operating points, and a
threshold that low fails towards accepting a stranger as an enrolled subject
and leaving their voice unmuted. Measure it on real session audio before
trusting this pipeline.

## Why detect and execute are two calls, not one

The original prototype did diarization, speaker matching, PII detection,
*and* the consent decision in a single `/sessions/redact` call, with the
consent lookup hardcoded to two fake users (`bob`/`alice`). Splitting it
means:
- this service never needs a database credential or knowledge of
  `ProjectConsent`,
- the backend can log/audit the *decision* step separately from the
  *detection* step,
- and a bug in consent logic can't hide inside an ML microservice's blast
  radius.

## Run with Docker (preferred)

    docker compose up audio-worker    # from backend/

## Run locally without Docker

    uv sync
    uv run uvicorn main:app --port 8003

Requires `HF_TOKEN` (see `.env.example`) — `pyannote/speaker-diarization-3.1`
is a gated model and the diarization pipeline raises on first use without it,
not at import time (see `diarization.py`).

GPU is not required but strongly recommended; see the note at the top of
`Dockerfile` for the CPU fallback.

## Tests

    uv run pytest tests/

Only `redact.py` has pure-function unit tests today — everything else wraps
a real ML model and is better covered by an integration test against a short
fixture audio clip once this is wired into the backend.
