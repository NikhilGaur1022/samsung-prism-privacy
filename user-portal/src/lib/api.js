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
