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

export function listSubjects(params = {}) {
  const query = new URLSearchParams(params).toString()
  return request(`/api/v1/subjects${query ? `?${query}` : ''}`)
}

// Agent-assisted verification reads the code the subject received by email and
// submits it through the same endpoint user-portal's self-service login uses.
export function verifySubjectOtp(email, otp) {
  return request('/auth/subject/verify', { method: 'POST', body: JSON.stringify({ email, otp }) })
}

export function login(email, password) {
  return request('/auth/admin/login', { method: 'POST', body: JSON.stringify({ email, password }) })
}

export function getMe() {
  return request('/auth/admin/me')
}

export function refreshSession() {
  return request('/auth/admin/refresh', { method: 'POST' })
}

export function logout() {
  return request('/auth/admin/logout', { method: 'POST' })
}

export function inviteAdmin(email, role) {
  return request('/auth/admin/invite', { method: 'POST', body: JSON.stringify({ email, role }) })
}

export function acceptInvite(token, password) {
  return request('/auth/admin/accept-invite', { method: 'POST', body: JSON.stringify({ token, password }) })
}

export function requestPasswordReset(email) {
  return request('/auth/admin/request-reset', { method: 'POST', body: JSON.stringify({ email }) })
}

export function resetPassword(token, newPassword) {
  return request('/auth/admin/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, newPassword }),
  })
}

// --- Collection sessions -----------------------------------------------------

export function listProjects() {
  return request('/api/v1/projects')
}

export function searchProjectSubjects(projectId, q) {
  const query = new URLSearchParams({ ...(q ? { q } : {}), limit: '25' }).toString()
  return request(`/api/v1/projects/${projectId}/subjects?${query}`)
}

export function createSession(payload) {
  return request('/api/v1/sessions', { method: 'POST', body: JSON.stringify(payload) })
}

export function listSessions(params = {}) {
  const query = new URLSearchParams(params).toString()
  return request(`/api/v1/sessions${query ? `?${query}` : ''}`)
}

export function getSession(sessionId) {
  return request(`/api/v1/sessions/${sessionId}`)
}

export function addParticipant(sessionId, subjectId) {
  return request(`/api/v1/sessions/${sessionId}/participants`, {
    method: 'POST',
    body: JSON.stringify({ subjectId }),
  })
}

export function removeParticipant(sessionId, subjectId) {
  return request(`/api/v1/sessions/${sessionId}/participants/${subjectId}`, { method: 'DELETE' })
}

// Multipart — the shared request() helper always sets a JSON content-type, which
// would stop the browser from generating the multipart boundary.
export async function uploadPhotos(sessionId, files, cameraSource) {
  const form = new FormData()
  for (const file of files) form.append('photos', file)
  form.append('cameraSource', cameraSource)

  const res = await fetch(`${BASE_URL}/api/v1/sessions/${sessionId}/photos`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  })

  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const error = new Error(body?.error ?? `Upload failed with status ${res.status}`)
    error.status = res.status
    throw error
  }
  return body
}

export function deletePhoto(sessionId, photoId) {
  return request(`/api/v1/sessions/${sessionId}/photos/${photoId}`, { method: 'DELETE' })
}

export function endSession(sessionId) {
  return request(`/api/v1/sessions/${sessionId}/end`, { method: 'POST' })
}

export function getClusters(sessionId) {
  return request(`/api/v1/sessions/${sessionId}/clusters`)
}

export function tagCluster(sessionId, clusterId, payload) {
  return request(`/api/v1/sessions/${sessionId}/clusters/${clusterId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export function finalizeSession(sessionId) {
  return request(`/api/v1/sessions/${sessionId}/finalize`, { method: 'POST' })
}

export const mediaUrl = {
  photo: (sessionId, photoId) => `${BASE_URL}/api/v1/sessions/${sessionId}/photos/${photoId}/file`,
  faceCrop: (sessionId, faceId) => `${BASE_URL}/api/v1/sessions/${sessionId}/faces/${faceId}/crop`,
}
