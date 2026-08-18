import { ApiError } from '../middleware/errorHandler.js'

// The audio kill switch, shared by every route that captures or processes voice.
//
// Lives here rather than in recording.routes.js because voice ENROLLMENT is
// gated by it too, and enrollment has no business importing a route module to
// read a flag. Both gates must move together: enrollment that stayed open with
// capture off would collect voice prints — §2 sensitive personal data — for a
// pipeline that cannot use them, which is collection without a purpose.
//
// Exactly the string "on". Anything else, including "true", "1" and "ON", is
// off: a kill switch that accepts near-misses is one typo away from being on in
// an environment nobody meant to enable.
export function audioCaptureEnabled() {
  return process.env.AUDIO_CAPTURE_ENABLED === 'on'
}

// Read per request, never captured at module load. Routers are constructed once
// at import time, so a module-level const would freeze whatever the environment
// held before the app was built — and make the flag untestable.
export function requireAudioEnabled(_req, _res, next) {
  if (!audioCaptureEnabled()) {
    return next(
      new ApiError(
        503,
        'Audio capture is not enabled in this environment. Set AUDIO_CAPTURE_ENABLED=on once the audio worker is provisioned.',
      ),
    )
  }
  next()
}
