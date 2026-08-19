import { ApiError } from '../middleware/errorHandler.js'

// The video kill switch, shared by every route that captures or processes video.
//
// Off by default, for the same reason AUDIO_CAPTURE_ENABLED is: enabling it is
// an operational decision, not a code one. The video worker is an opt-in compose
// profile (`docker compose --profile video up -d`) and a deployment without it
// would DEFER every clip — which is safe, but looks like a broken pipeline
// rather than an unprovisioned one.
//
// The recognition and finalize paths deliberately do NOT consult this flag. They
// key off whether any VideoAsset rows exist, so a session captured while video
// was enabled still finishes correctly if the flag is later turned off — the
// alternative would strand already-collected clips in a state with no redaction
// path, which is the one failure this platform cannot have.
//
// Exactly the string "on". Anything else, including "true", "1" and "ON", is
// off: a kill switch that accepts near-misses is one typo away from being on in
// an environment nobody meant to enable.
export function videoCaptureEnabled() {
  return process.env.VIDEO_CAPTURE_ENABLED === 'on'
}

// Read per request, never captured at module load. Routers are constructed once
// at import time, so a module-level const would freeze whatever the environment
// held before the app was built — and make the flag untestable.
export function requireVideoEnabled(_req, _res, next) {
  if (!videoCaptureEnabled()) {
    return next(
      new ApiError(
        503,
        'Video capture is not enabled in this environment. Set VIDEO_CAPTURE_ENABLED=on once the video worker is provisioned (docker compose --profile video up -d).',
      ),
    )
  }
  next()
}
