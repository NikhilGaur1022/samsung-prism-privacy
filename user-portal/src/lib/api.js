const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000'

// ---------------------------------------------------------------------------
// Silent session refresh
// ---------------------------------------------------------------------------
// The subject access token is short-lived and the API issues a refresh token
// beside it, but `refreshSession()` below was exported and never called from
// anywhere — so a data principal reading their own record was signed out
// mid-page and bounced to the OTP screen, which for someone checking what is
// held about them reads as the portal losing their data.
//
// One shared in-flight refresh: a dashboard that fires four requests on mount
// must not answer four 401s with four competing refreshes against a token that
// rotates on use.
let refreshInFlight = null

function refreshTokens() {
  refreshInFlight ??= fetch(`${BASE_URL}/auth/subject/refresh`, {
    method: 'POST',
    credentials: 'include',
  })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      refreshInFlight = null
    })
  return refreshInFlight
}

// Endpoints where a 401 is an ANSWER rather than an expired access token, so a
// refresh-and-retry would be wrong:
//
//   login / register / verify — anonymous. A 401 from /verify means the code was
//     wrong, and refreshing on it would turn a clear "that code is not right"
//     into a silent failure. There is also no session to refresh yet.
//   refresh — a 401 from the refresh endpoint means the refresh token is gone
//     too, so retrying it is an infinite loop, not a recovery.
//
// This used to be `!path.startsWith('/auth/subject/')`, which over-matched: /me
// and /logout live under the same prefix but ARE authenticated calls. So the one
// request the dashboard makes on mount to read your own record — getMe() — was
// the single request in the app that could never recover from an expired access
// token. It 401'd, the refresh beside it was never attempted, and the portal
// bounced the principal to the OTP screen mid-session. That is the exact failure
// the comment at the top of this file describes; the retry existed, /me was just
// excluded from it.
const NO_REFRESH_RETRY = [
  '/auth/subject/login',
  '/auth/subject/register',
  '/auth/subject/verify',
  '/auth/subject/refresh',
]

async function request(path, options = {}) {
  const send = () =>
    fetch(`${BASE_URL}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      ...options,
    })

  let res = await send()

  // One retry, for an expired access token only.
  if (res.status === 401 && !NO_REFRESH_RETRY.some((p) => path.startsWith(p))) {
    if (await refreshTokens()) res = await send()
  }

  const body = await res.json().catch(() => null)

  if (!res.ok) {
    const error = new Error(body?.error ?? `Request failed with status ${res.status}`)
    error.status = res.status
    error.details = body?.details
    error.masterUserId = body?.details?.masterUserId
    throw error
  }

  return body
}

// NOT /api/v1/subjects — that router is gated to collection agents and platform
// root because it also lists and mutates other people's identity. This page is
// used by someone who has no account at all, so it goes to the public auth
// router's one anonymous-safe operation.
export function registerSubject(payload) {
  return request('/auth/subject/register', { method: 'POST', body: JSON.stringify(payload) })
}

export function requestLoginOtp(email) {
  return request('/auth/subject/login', { method: 'POST', body: JSON.stringify({ email }) })
}

export function verifyLoginOtp(email, otp) {
  return request('/auth/subject/verify', { method: 'POST', body: JSON.stringify({ email, otp }) })
}

export function getMe() {
  return request('/auth/subject/me')
}

// Sessions a collection agent has added this subject to — the subject's own
// "where am I being collected" view, distinct from the project catalogue.
export function getMyParticipations() {
  return request('/api/v1/me/participations')
}

export function refreshSession() {
  return request('/auth/subject/refresh', { method: 'POST' })
}

export function logout() {
  return request('/auth/subject/logout', { method: 'POST' })
}

// --- Project consent ---------------------------------------------------------
// Consent is project-wide and all-or-nothing: granting covers everything the
// project collects, faces included. Collection agents can only read the result.

export function listConsentProjects() {
  return request('/api/v1/consent/projects')
}

export function grantConsent(projectId) {
  return request(`/api/v1/consent/projects/${projectId}/grant`, { method: 'POST' })
}

export function revokeConsent(projectId) {
  return request(`/api/v1/consent/projects/${projectId}/revoke`, { method: 'POST' })
}

// --- Face enrollment ---------------------------------------------------------
// The photo and its embedding are both stored, the embedding encrypted at rest,
// and both go when consent does. The server takes the subject id from the session
// cookie, never from anything sent here.

export function getEnrollmentStatus() {
  return request('/api/v1/me/enrollment-status')
}

export function setBiometricConsent(accepted) {
  return request('/api/v1/me/biometric-consent', {
    method: 'PATCH',
    body: JSON.stringify({ accepted }),
  })
}

// Multipart, so it bypasses request() — that helper forces a JSON content-type,
// which would stop the browser generating the multipart boundary.
export async function addEnrollment(blob, pose) {
  const form = new FormData()
  // pose goes in FIRST: multer streams the parts in order and only exposes text
  // fields on req.body if they arrived before the file.
  if (pose) form.append('pose', pose)
  form.append('selfie', blob, 'selfie.jpg')

  const res = await fetch(`${BASE_URL}/api/v1/me/enrollments`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  })

  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const error = new Error(body?.error ?? `Enrollment failed with status ${res.status}`)
    error.status = res.status
    throw error
  }
  return body
}

export function listEnrollments() {
  return request('/api/v1/me/enrollments')
}

export function deleteEnrollment(id) {
  return request(`/api/v1/me/enrollments/${id}`, { method: 'DELETE' })
}

export const enrollmentImageUrl = (id) => `${BASE_URL}/api/v1/me/enrollments/${id}/image`

// --- Voice enrollment --------------------------------------------------------
// The same shape as above and the same consent gate — a voice print is biometric
// data on exactly the same footing as a face embedding. All of these 503 when
// AUDIO_CAPTURE_ENABLED is off, which the UI reads as "not offered here" rather
// than as a failure.

export function getVoiceEnrollmentStatus() {
  return request('/api/v1/me/voice-enrollments/status')
}

export async function addVoiceEnrollment(blob) {
  const form = new FormData()
  form.append('audio', blob, blob.name ?? 'voice.wav')

  const res = await fetch(`${BASE_URL}/api/v1/me/voice-enrollments`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  })

  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const error = new Error(body?.error ?? `Voice enrollment failed with status ${res.status}`)
    error.status = res.status
    throw error
  }
  return body
}

export function listVoiceEnrollments() {
  return request('/api/v1/me/voice-enrollments')
}

export function deleteVoiceEnrollment(id) {
  return request(`/api/v1/me/voice-enrollments/${id}`, { method: 'DELETE' })
}

// Playback of your own clip — the one voice playback route in the system, and
// the reason it exists is §11 access, not review. no-store on the response, so
// this URL is safe to hand straight to an <audio> element.
export const voiceEnrollmentAudioUrl = (id) =>
  `${BASE_URL}/api/v1/me/voice-enrollments/${id}/audio`

// --- QR session join ---------------------------------------------------------
// The lookup is public — a phone that has scanned the code but has not signed in
// yet still needs to see what it is being asked to agree to. Accepting is not.

export function getJoinInvite(token) {
  return request(`/api/v1/join/${token}`)
}

export function acceptJoinInvite(token) {
  return request(`/api/v1/join/${token}/accept`, { method: 'POST' })
}

// --- Consent notices (DPDP §5) ------------------------------------------------
// Rendered server-side and returned verbatim — never assembled or summarised
// on the client, or the text a principal signs stops matching what is stored.

export function renderConsentNotice(templateId, locale) {
  return request(`/api/v1/consent-templates/${templateId}/render?locale=${encodeURIComponent(locale)}`)
}

// --- Data principal rights (DPDP §11-§13) -------------------------------------
// The subject id never appears in any of these calls — the server reads it from
// the session cookie, so every response here is already scoped to "me".

export function raiseDsarRequest(payload) {
  return request('/api/v1/me/dsar', { method: 'POST', body: JSON.stringify(payload) })
}

export function listMyDsarRequests() {
  return request('/api/v1/me/dsar')
}

export function getMyDsarRequest(id) {
  return request(`/api/v1/me/dsar/${id}`)
}

// The principal's own milestones. Deliberately a separate, narrower shape than
// the operator timeline: no internal actor identities, no access-log rows, no
// evidence hashes, no per-item ids. The server builds it from an allowlist of
// milestone kinds rather than by redacting the operator view, so a new internal
// event type cannot leak here by default.
export function getMyDsarTimeline(id) {
  return request(`/api/v1/me/dsar/${id}/timeline`)
}

export function getMyDsarCertificate(id) {
  return request(`/api/v1/me/dsar/${id}/certificate`)
}

// Binary and single-use, so it bypasses request(): a 410 body still needs to be
// read as JSON for its message, but a 200 body is a zip, never JSON.
export async function downloadMyDsarPackage(id, token) {
  const res = await fetch(
    `${BASE_URL}/api/v1/me/dsar/${id}/package?token=${encodeURIComponent(token)}`,
    { credentials: 'include' },
  )

  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const error = new Error(body?.error ?? `Download failed with status ${res.status}`)
    error.status = res.status
    throw error
  }

  const disposition = res.headers.get('Content-Disposition') ?? ''
  const filename = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? 'dsar-package.zip'
  return { blob: await res.blob(), filename }
}

// Single-use, short-lived token that unlocks the download above. Never store
// or log the token this resolves to — the caller must use it once and drop it.
export function createDsarPackageToken(id) {
  return request(`/api/v1/me/dsar/${id}/package-token`, { method: 'POST' })
}

// --- Erasure review (before anything is destroyed) ----------------------------
//
// What an erasure actually covers, shown to the person asking for it. Every frame
// they appear in for the project, rendered with THEIR face visible and every other
// face blurred — the inverse of what the erasure itself produces, because the
// other people in those frames never asked for anything and must not be disclosed.
//
// Reachable only for an ERASE request that belongs to the caller and has been
// through discovery; the server re-checks all of that on every call.

export function getErasurePackage(id) {
  return request(`/api/v1/me/dsar/${id}/erasure-package`)
}

// No token needed, unlike the §11 package: this is a review of the caller's own
// pending request rather than a one-shot legal deliverable, and it stays readable
// until they decide. The route still writes an AccessEvent per frame.
export const erasurePhotoUrl = (id, photoId) =>
  `${BASE_URL}/api/v1/me/dsar/${id}/erasure-package/photos/${photoId}`

export async function downloadErasurePackage(id) {
  const res = await fetch(`${BASE_URL}/api/v1/me/dsar/${id}/erasure-package.zip`, {
    credentials: 'include',
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const error = new Error(body?.error ?? `Download failed with status ${res.status}`)
    error.status = res.status
    throw error
  }
  const disposition = res.headers.get('Content-Disposition') ?? ''
  const filename = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? 'erasure-review.zip'
  return { blob: await res.blob(), filename }
}

// The irreversible one. Nothing is destroyed until this resolves — and after it,
// the operator's Execute stops being refused.
export function confirmErasure(id) {
  return request(`/api/v1/me/dsar/${id}/confirm-erasure`, { method: 'POST' })
}

// --- Photo summary (DPDP §11) -------------------------------------------------
// Counts, purposes and consent state grouped by project — never the photographs
// themselves. getMyRedactedPhoto used to fetch frame bytes straight from a
// session cookie; the material now comes only from an approved ACCESS package,
// downloaded once through downloadDsarPackage() above.

export function getMyPhotoSummary() {
  return request('/api/v1/me/photos')
}
