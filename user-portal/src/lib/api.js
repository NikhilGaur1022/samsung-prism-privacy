const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000'

async function request(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...options,
  })

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

export function registerSubject(payload) {
  return request('/api/v1/subjects', { method: 'POST', body: JSON.stringify(payload) })
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

// --- Photos (DPDP §11) --------------------------------------------------------
// The subject's own record of photos they appear in, grouped by project. The
// server derives "appears in" from confirmed face-tag links against the
// session cookie's subject id, never from anything sent here.

export function getMyPhotos() {
  return request('/api/v1/me/photos')
}

// Binary, so it bypasses request(): everyone but the requesting principal is
// blurred server-side. A 409 means the redaction has not been confirmed yet —
// callers should check `viewable` on the photo entry before ever calling this.
export async function getMyRedactedPhoto(photoId) {
  const res = await fetch(`${BASE_URL}/api/v1/me/photos/${photoId}/redacted`, {
    credentials: 'include',
  })

  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const error = new Error(body?.error ?? `Photo fetch failed with status ${res.status}`)
    error.status = res.status
    throw error
  }

  return res.blob()
}
