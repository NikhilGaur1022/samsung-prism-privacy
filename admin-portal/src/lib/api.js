const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000'

// ---------------------------------------------------------------------------
// Lightweight in-memory GET cache — makes page navigations instant on revisit.
// Mutations automatically bust related entries by path prefix.
// ---------------------------------------------------------------------------
const _cache = new Map()
const CACHE_TTL = 60_000 // 60 seconds

function cacheGet(key) {
  const entry = _cache.get(key)
  if (!entry) return undefined
  if (Date.now() > entry.expires) { _cache.delete(key); return undefined }
  return entry.data
}

function cacheSet(key, data) {
  _cache.set(key, { data, expires: Date.now() + CACHE_TTL })
}

// Bust every cached key whose path starts with the given prefix.
// e.g. writing to /sessions/abc/clusters/x invalidates /sessions/abc/*
function cacheBust(path) {
  // Walk up to the second-to-last segment to get the parent scope
  const parts = path.split('/').filter(Boolean)
  const prefix = '/' + parts.slice(0, Math.max(parts.length - 1, 2)).join('/')
  for (const key of _cache.keys()) {
    if (key.startsWith(prefix)) _cache.delete(key)
  }
}

/** Clear entire API cache — useful after session-ending mutations. */
export function clearApiCache() { _cache.clear() }

async function request(path, options = {}) {
  const method = (options.method ?? 'GET').toUpperCase()
  const isRead = method === 'GET'

  // Serve from cache for GET requests
  if (isRead) {
    const cached = cacheGet(path)
    if (cached) return cached
  }

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

  // Cache successful GET responses; bust cache on mutations
  if (isRead) {
    cacheSet(path, body)
  } else {
    cacheBust(path)
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

// The 60s GET cache would freeze the roster exactly when it matters — while
// people are walking up and scanning. Poll through this, not getSession.
export function getSessionFresh(sessionId) {
  clearApiCache()
  return request(`/api/v1/sessions/${sessionId}`)
}

// --- QR session join ---------------------------------------------------------

export function getInvite(sessionId) {
  return request(`/api/v1/sessions/${sessionId}/invite`)
}

export function createInvite(sessionId) {
  return request(`/api/v1/sessions/${sessionId}/invite`, { method: 'POST' })
}

export function revokeInvite(sessionId) {
  return request(`/api/v1/sessions/${sessionId}/invite`, { method: 'DELETE' })
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

export function getPhotosForReview(sessionId) {
  return request(`/api/v1/sessions/${sessionId}/photos/review`)
}

export function getPeople(sessionId) {
  return request(`/api/v1/sessions/${sessionId}/people`)
}

export function getPersonPhotos(sessionId, subjectId) {
  return request(`/api/v1/sessions/${sessionId}/people/${subjectId}/photos`)
}

export function mergeClusters(sessionId, clusterIds) {
  return request(`/api/v1/sessions/${sessionId}/clusters/merge`, {
    method: 'POST',
    body: JSON.stringify({ clusterIds }),
  })
}

export function splitFaces(sessionId, clusterId, faceIds) {
  return request(`/api/v1/sessions/${sessionId}/clusters/${clusterId}/split`, {
    method: 'POST',
    body: JSON.stringify({ faceIds }),
  })
}

export function acceptSuggestions(sessionId, clusterIds) {
  return request(`/api/v1/sessions/${sessionId}/clusters/accept-suggestions`, {
    method: 'POST',
    body: JSON.stringify({ clusterIds }),
  })
}

// --- Face enrollment ---------------------------------------------------------

// Multipart, so it bypasses request() for the same reason uploadPhotos does.
// Agent-side capture is free-form: in the field they may get one usable shot, so
// pose is optional here where it is mandatory in the subject's guided flow.
export async function addEnrollment(subjectId, blob, pose) {
  const form = new FormData()
  // Before the file: multer only exposes text fields on req.body if they arrived
  // ahead of it in the multipart stream.
  if (pose) form.append('pose', pose)
  form.append('selfie', blob, 'selfie.jpg')

  const res = await fetch(`${BASE_URL}/api/v1/subjects/${subjectId}/enrollments`, {
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
  clearApiCache()
  return body
}

export function listEnrollments(subjectId) {
  return request(`/api/v1/subjects/${subjectId}/enrollments`)
}

export function deleteEnrollment(subjectId, id) {
  return request(`/api/v1/subjects/${subjectId}/enrollments/${id}`, { method: 'DELETE' })
}

export const enrollmentImageUrl = (subjectId, id) =>
  `${BASE_URL}/api/v1/subjects/${subjectId}/enrollments/${id}/image`

// --- Handoffs (data admin) ---------------------------------------------------

export function listHandoffs(params = {}) {
  const query = new URLSearchParams(params).toString()
  return request(`/api/v1/handoffs${query ? `?${query}` : ''}`)
}

export function getHandoff(id) {
  return request(`/api/v1/handoffs/${id}`)
}

export function ingestHandoff(id) {
  return request(`/api/v1/handoffs/${id}/ingest`, { method: 'POST' })
}

export function getLineage(params = {}) {
  const query = new URLSearchParams(params).toString()
  return request(`/api/v1/handoffs/lineage${query ? `?${query}` : ''}`)
}

// --- Dashboard ----------------------------------------------------------------

export function getDashboardSummary() {
  return request('/api/v1/dashboard/summary')
}

// from/to are optional ISO dates; the backend defaults to the trailing 90 days.
export function getComplianceReport(params = {}) {
  const query = new URLSearchParams(params).toString()
  return request(`/api/v1/dashboard/compliance-report${query ? `?${query}` : ''}`)
}

// --- Projects (governance lifecycle) ------------------------------------------

export function createProject(payload) {
  return request('/api/v1/projects', { method: 'POST', body: JSON.stringify(payload) })
}

export function getProject(projectId) {
  return request(`/api/v1/projects/${projectId}`)
}

export function updateProject(projectId, payload) {
  return request(`/api/v1/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify(payload) })
}

export function submitProject(projectId) {
  return request(`/api/v1/projects/${projectId}/submit`, { method: 'POST' })
}

export function approveProject(projectId) {
  return request(`/api/v1/projects/${projectId}/approve`, { method: 'POST' })
}

export function rejectProject(projectId, reason) {
  return request(`/api/v1/projects/${projectId}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  })
}

export function closeProject(projectId) {
  return request(`/api/v1/projects/${projectId}/close`, { method: 'POST' })
}

export function listProjectAssignments(projectId) {
  return request(`/api/v1/projects/${projectId}/assignments`)
}

// --- Project oversight (sessions/handoffs/report roll-ups) -------------------

export function listProjectSessions(projectId) {
  return request(`/api/v1/projects/${projectId}/sessions`)
}

export function listProjectHandoffs(projectId) {
  return request(`/api/v1/projects/${projectId}/handoffs`)
}

export function getProjectReport(projectId) {
  return request(`/api/v1/projects/${projectId}/report`)
}

export function addProjectAssignment(projectId, adminId) {
  return request(`/api/v1/projects/${projectId}/assignments`, {
    method: 'POST',
    body: JSON.stringify({ adminId }),
  })
}

export function removeProjectAssignment(projectId, adminId) {
  return request(`/api/v1/projects/${projectId}/assignments/${adminId}`, { method: 'DELETE' })
}

// --- Consent templates ---------------------------------------------------------

export function listConsentTemplates(params = {}) {
  const query = new URLSearchParams(params).toString()
  return request(`/api/v1/consent-templates${query ? `?${query}` : ''}`)
}

export function createConsentTemplate(payload) {
  return request('/api/v1/consent-templates', { method: 'POST', body: JSON.stringify(payload) })
}

export function getConsentTemplate(templateId) {
  return request(`/api/v1/consent-templates/${templateId}`)
}

export function updateConsentTemplate(templateId, payload) {
  return request(`/api/v1/consent-templates/${templateId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export function publishConsentTemplate(templateId) {
  return request(`/api/v1/consent-templates/${templateId}/publish`, { method: 'POST' })
}

export function renderConsentTemplate(templateId, locale = 'en') {
  const query = new URLSearchParams({ locale }).toString()
  return request(`/api/v1/consent-templates/${templateId}/render?${query}`)
}

// --- DSAR ------------------------------------------------------------------

export function listDsar(params = {}) {
  const query = new URLSearchParams(params).toString()
  return request(`/api/v1/dsar${query ? `?${query}` : ''}`)
}

// Vault-wide evidence listing, not scoped to a single request.
export function listDsarEvidence(params = {}) {
  const query = new URLSearchParams(params).toString()
  return request(`/api/v1/dsar/evidence${query ? `?${query}` : ''}`)
}

export function getDsarSla() {
  return request('/api/v1/dsar/sla')
}

export function getDsarSigningKey() {
  return request('/api/v1/dsar/signing-key')
}

export function getDsar(requestId) {
  return request(`/api/v1/dsar/${requestId}`)
}

export function assignDsar(requestId, assignedAdminId) {
  return request(`/api/v1/dsar/${requestId}/assign`, {
    method: 'POST',
    body: JSON.stringify({ assignedAdminId }),
  })
}

export function runDsarDiscovery(requestId) {
  return request(`/api/v1/dsar/${requestId}/discovery`, { method: 'POST' })
}

export function attachDsarEvidence(requestId, payload) {
  return request(`/api/v1/dsar/${requestId}/evidence`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function executeDsar(requestId, inline = true) {
  return request(`/api/v1/dsar/${requestId}/execute`, {
    method: 'POST',
    body: JSON.stringify({ inline }),
  })
}

export function approveDsar(requestId, note) {
  return request(`/api/v1/dsar/${requestId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  })
}

export function rejectDsar(requestId, reason) {
  return request(`/api/v1/dsar/${requestId}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  })
}

export function getDsarCertificate(requestId) {
  return request(`/api/v1/dsar/${requestId}/certificate`)
}

export function getPurgeJob(requestId, purgeJobId) {
  return request(`/api/v1/dsar/${requestId}/purge-jobs/${purgeJobId}`)
}

// --- Audit -----------------------------------------------------------------

export function listAudit(params = {}) {
  const query = new URLSearchParams(params).toString()
  return request(`/api/v1/audit${query ? `?${query}` : ''}`)
}

export function verifyAuditChain(params) {
  const query = new URLSearchParams(params).toString()
  return request(`/api/v1/audit/verify?${query}`)
}

export function listAccessEvents(params = {}) {
  const query = new URLSearchParams(params).toString()
  return request(`/api/v1/access-events${query ? `?${query}` : ''}`)
}

// Metadata-only picker for break-glass targets: the frames the request's own
// subject is linked to, so an operator can choose one instead of copying a
// sessionId/photoId out of a discovery result by hand.
export function getDsarMedia(requestId) {
  return request(`/api/v1/dsar/${requestId}/media`)
}

// --- Break-glass raw media ---------------------------------------------------
// Never cached, never left as a lingering blob URL — the caller is expected to
// revoke it once the modal or preview closes.
export async function requestRawMedia(sessionId, photoId, { dsarRequestId, justification }) {
  const query = new URLSearchParams({ dsarRequestId, justification }).toString()
  const res = await fetch(`${BASE_URL}/api/v1/sessions/${sessionId}/photos/${photoId}/raw?${query}`, {
    credentials: 'include',
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const error = new Error(body?.error ?? `Break-glass request failed with status ${res.status}`)
    error.status = res.status
    throw error
  }
  const blob = await res.blob()
  return URL.createObjectURL(blob)
}

export const mediaUrl = {
  photo: (sessionId, photoId) => `${BASE_URL}/api/v1/sessions/${sessionId}/photos/${photoId}/file`,
  faceCrop: (sessionId, faceId) => `${BASE_URL}/api/v1/sessions/${sessionId}/faces/${faceId}/crop`,
  redacted: (sessionId, photoId) =>
    `${BASE_URL}/api/v1/sessions/${sessionId}/photos/${photoId}/redacted`,
  personRedacted: (sessionId, subjectId, photoId) =>
    `${BASE_URL}/api/v1/sessions/${sessionId}/people/${subjectId}/photos/${photoId}/redacted`,
}
