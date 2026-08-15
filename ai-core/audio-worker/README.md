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
- `POST /api/v1/analyze` (multipart: `main_audio` file, optional
  `voice_snippets` files, `snippet_muids` JSON array positionally aligned
  with `voice_snippets`) ->
  ```json
  {
    "segments": [{"start": 12.4, "end": 15.1, "speaker_id": "SPEAKER_00", "transcript": "..."}],
    "speaker_matches": [{"speaker_id": "SPEAKER_00", "matched_muid": "uuid-or-null", "score": 0.42}],
    "pii_spans": [{"start": 13.0, "end": 13.6, "type": "PHONE_NUMBER", "speaker_id": "SPEAKER_00"}]
  }
  ```
  Detection only. `matched_muid` is `null` when no snippet clears
  `SIMILARITY_THRESHOLD` — treat that speaker as an unconsented bystander,
  don't guess.
- `POST /api/v1/redact` (multipart: `main_audio` file, `intervals` JSON array
  of `{"start": float, "end": float}`) -> redacted `audio/wav` bytes. Pure
  execution — no identity or consent knowledge, just muting.

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
