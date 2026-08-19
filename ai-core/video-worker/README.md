# video-worker

Face detection, tracking and sparse embedding for session video, plus a separate
box-schedule execution step. Port **8005** — 8004 is the text worker.

Stateless. No database, no consent decision, no memory between calls — the same
contract `face-worker`, `image-pii-worker` and `audio-worker` hold.

## Why two calls

`/analyze` reports what is in the frame. `/redact` executes a rectangle list it
is handed. Between them, a human tags the clusters in the admin portal.

A single detect-and-blur endpoint would have to decide who is allowed to remain
visible, which is exactly the decision this service is built **not** to make.
The backend is the only component that reads `project_consent_matrix`.

## The detection strategy

Video is not "many photos". A 2-minute 30fps clip is 3,600 frames; detecting and
embedding every face on every frame is minutes of GPU for an answer that barely
changes frame to frame.

```
decode
  ├─ every DETECT_STRIDE-th frame → SCRFD detect
  ├─ IoU tracker + constant-velocity prediction links detections into tracks
  ├─ per track: the best EMBED_FRAMES_PER_TRACK frames get an ArcFace embedding
  └─ mean of those, re-normalised → ONE vector per track
```

Two consequences worth knowing:

- **A track is a stronger grouping signal than embedding similarity.** Spatial
  continuity establishes "same face" far more reliably than cosine distance. The
  backend still clusters tracks afterwards, because two tracks can be one person
  who left frame and came back — and only the backend can also see the session's
  stills.
- **A track's averaged embedding beats any single still.** Averaging five good
  views cancels the pose and lighting noise that one frame carries, so video
  tracks tend to match the gallery *better* than photographs do.

`buffalo_l` is loaded here because `face-worker` loads it. That is a correctness
requirement: the session gallery holds ArcFace vectors from that service, and a
track embedded with any other model gets compared against them by cosine
similarity and produces confident nonsense.

## Failing closed, in the time dimension

The stills pipeline fails closed in space: anything not affirmatively tagged is
blurred. Video adds a second axis, and the same rule applies to it.

- **Tracks coast.** When the detector loses a face it keeps its last box for
  `HOLD_SEC`. Without this, a face dropped for 8 frames during a head turn
  un-blurs for a quarter second inside a file stamped "redacted".
- **Boxes are held past the ends of a track**, not dropped, and dilated by
  `BOX_DILATION` to cover drift between detections.
- **A partial encode is deleted, never returned.** A truncated mp4 plays for a
  while and then stops, which reads as a corrupt download rather than an
  incomplete redaction — and the frames it does contain were never masked.
- **PII detection failure is a 503**, not an empty region list. `/analyze` raises
  `PiiUnavailableError` if `image-pii-worker` is unreachable; the backend maps
  that onto `DEFERRED` and requeues, exactly as the stills path does.

Short tracks below `MIN_TRACK_FRAMES` are dropped from the response. They are
still blurred — dropping the track only removes the agent's tagging card, and
anything without a card is not `TAGGED`, which the backend already treats as
blur.

## Audio

There is none. `/redact` passes `-an` and never copies the source audio track.

Video capture in this platform is muted by contract — the backend's upload route
rejects a file carrying an audio stream — so no voice-consent decision is
attached to these files. Copying a track nobody screened would smuggle one in.
Session audio is a separate object with its own consent path: see
`ai-core/audio-worker` and the `recordings` table.

## PII text

Reused over the network from `image-pii-worker` rather than reimplemented, so
there is one definition of "what counts as PII" for stills and video both. A
second copy would drift, and the copy that drifts is the one that stops masking
Aadhaar numbers.

Sampled at `PII_SAMPLE_FPS` (default 1/sec) and each region held until the next
sample. Printed text is static in the overwhelmingly common case — an ID card
lying on a table — so one look per second finds it and the hold covers it
continuously.

Only the entity **type** is lifted out of the detector's response. `entities`
also carries the matched text, which is the Aadhaar number itself; that must
never reach a span record, a database row or an audit payload.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /health` | status, plus which providers and encoder were probed |
| `POST /probe` | container facts only (fps, dims, duration, `has_audio`) — no decode, no models |
| `POST /analyze` | `file`, `scan_pii` → tracks with keyframed boxes, embeddings, rep crops, PII spans |
| `POST /redact` | `file`, `schedule` → re-encoded mp4 |

`schedule` is `{"blur": [...], "mosaic": [...]}`; each entry carries keyframed
boxes plus the frame range to hold them over.

## CPU and GPU

One image, two builds. Nothing in the code branches on it — `onnx_providers()`
probes what the runtime exposes and `video_encoder()` probes ffmpeg for NVENC.
`/health` reports which it picked.

```bash
# CPU (default)
docker compose build video-worker

# GPU
docker compose build \
  --build-arg BASE=nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04 \
  --build-arg ORT=onnxruntime-gpu video-worker
```

CPU-only, roughly: a 2-minute 1080p clip is 3–6 min to analyze and 2–4 min to
re-encode. This runs behind BullMQ after a session ends, never in a request path.

## Settings

| Env | Default | Notes |
|---|---|---|
| `DETECT_STRIDE` | `3` | biggest performance knob; cost is linear in `1/stride` |
| `HOLD_SEC` | `0.5` | how long a lost track keeps being blurred |
| `IOU_THRESHOLD` | `0.3` | loose on purpose — over-splitting is safe, over-merging is not |
| `EMBED_FRAMES_PER_TRACK` | `5` | frames averaged into a track's vector |
| `MIN_TRACK_FRAMES` | `4` | below this, no tagging card (still blurred) |
| `BOX_DILATION` | `0.15` | padding on every blur box |
| `PII_SAMPLE_FPS` | `1.0` | OCR sample rate |
| `PII_SERVICE_URL` | `http://image-pii-worker:8002` | fail-closed dependency |
| `BLUR_KERNEL` / `BLUR_SIGMA` | `99` / `30` | face blur, matches face-worker |
| `CRF` / `PRESET` | `23` / `veryfast` | libx264; NVENC maps to `-cq` / `p4` |

`DETECT_STRIDE` and `HOLD_SEC` are tuned together. Raising the stride without
raising the hold is what lets a fast head turn outrun the box dilation.
