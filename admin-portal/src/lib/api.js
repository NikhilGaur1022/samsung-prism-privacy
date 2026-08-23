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

// ---------------------------------------------------------------------------
// Silent session refresh
// ---------------------------------------------------------------------------
// The admin access token lives 15 minutes. The API has always issued a refresh
// token alongside it and exposed POST /auth/admin/refresh to trade it in — and
// nothing in this client ever called that endpoint. So every admin was signed
// out fifteen minutes after signing in, mid-task, with no warning: the next
// request 401'd, RequireRole saw no admin and bounced them to /login.
//
// One in-flight refresh at a time, shared by every caller. Without the shared
// promise a screen that fires six requests on mount answers a 401 with six
// concurrent refreshes, five of which race against the rotating refresh token
// and lose.
let refreshInFlight = null

export function refreshAdminSession() {
  refreshInFlight ??= fetch(`${BASE_URL}/auth/admin/refresh`, {
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

async function request(path, options = {}) {
  const method = (options.method ?? 'GET').toUpperCase()
  const isRead = method === 'GET'

  // Serve from cache for GET requests
  if (isRead) {
    const cached = cacheGet(path)
    if (cached) return cached
  }

  const send = () =>
    fetch(`${BASE_URL}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      ...options,
    })

  let res = await send()

  // Exactly one retry, and only for an expired access token. The refresh
  // endpoint itself is excluded — a 401 from it means the refresh token is gone
  // too, and retrying that is an infinite loop, not a recovery.
  if (res.status === 401 && !path.startsWith('/auth/admin/refresh')) {
    if (await refreshAdminSession()) res = await send()
  }

  const body = await res.json().catch(() => null)

  if (!res.ok) {
    // The API answers with one envelope — {error, code, details, correlationId}
    // — enforced by a contract test. Before that there were five shapes, two of
    // them HTML, and this line produced a bare "Request failed with status N"
    // for anything that was not the canonical one.
    const error = new Error(body?.error ?? `Request failed with status ${res.status}`)
    error.status = res.status
    error.code = body?.code ?? null
    error.details = body?.details
    error.correlationId = body?.correlationId ?? null
    error.masterUserId = body?.details?.masterUserId
    // Field-level validation errors. Zod used to report `path: []` for every
    // param failure, so the client could only ever say "Validation failed" with
    // no field named; the server now folds the path into a dotted name.
    error.fields = body?.details?.fields ?? null
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

export function listAdmins(role) {
  const query = new URLSearchParams(role ? { role } : {}).toString()
  return request(`/auth/admin/users${query ? `?${query}` : ''}`)
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

// --- Voice enrollment --------------------------------------------------------

// These answer 503 unless AUDIO_CAPTURE_ENABLED is on, which is why the panel
// treats that one status as "voice capture is off here" rather than an error to
// shout about — and only that one, so a real fault still surfaces.
//
// There is deliberately no voiceEnrollmentAudioUrl to match enrollmentImageUrl:
// the backend exposes playback only to the subject themselves. An agent confirms
// a capture worked from its duration, not by listening to it.
export async function addVoiceEnrollment(subjectId, blob) {
  const form = new FormData()
  // Named from the blob's real type, never a fixed '.webm'. VoiceCapture hands
  // this a genuine 16 kHz WAV (lib/audioWav.js), and a filename that disagrees
  // with the bytes is the same mislabelling that broke the session recorder.
  const ext = (blob.type || '').includes('wav') ? 'wav' : 'webm'
  form.append('audio', blob, blob.name ?? `voice.${ext}`)

  const res = await fetch(`${BASE_URL}/api/v1/subjects/${subjectId}/voice-enrollments`, {
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
  clearApiCache()
  return body
}

export function listVoiceEnrollments(subjectId) {
  return request(`/api/v1/subjects/${subjectId}/voice-enrollments`)
}

export function deleteVoiceEnrollment(subjectId, id) {
  return request(`/api/v1/subjects/${subjectId}/voice-enrollments/${id}`, { method: 'DELETE' })
}

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

// The frame index for a role that may read a session's redacted derivatives but
// not the session record itself (dataOwner own-project, dataAdmin). Pair with
// mediaUrl.redacted — getSession would 403 for these roles.
export function listSessionPhotos(sessionId) {
  return request(`/api/v1/sessions/${sessionId}/photos`)
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

// --- DSAR item search, actions, timeline (PLAN Phases 4–7) -------------------

// Identity lookup. Exact + prefix only server-side — never fuzzy — so a UI that
// "helpfully" widens a term here would be widening it past what the server will
// answer, not past what it should.
export function searchDsarSubjects(params = {}) {
  const query = new URLSearchParams(params).toString()
  return request(`/api/v1/dsar/subjects/search${query ? `?${query}` : ''}`)
}

// One page of the request subject's item index, plus `totals`. `totals.all`
// ignores the filters — it is the completeness claim ("we hold N things about
// this person"), and rendering `items.length` in its place would turn a filtered
// view into a false "this is everything".
export function listDsarItems(requestId, params = {}) {
  const query = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== '' && v !== undefined && v !== null),
  ).toString()
  return request(`/api/v1/dsar/${requestId}/items${query ? `?${query}` : ''}`)
}

// `body` is `{ kind, reason, itemIds }` OR `{ kind, reason, filter }` — never
// both; the server rejects the pair. "Select all matching" must send the FILTER,
// not a harvested id list: the set is resolved server-side against the request's
// own subject and capped there.
export function requestDsarItemActions(requestId, body) {
  return request(`/api/v1/dsar/${requestId}/items/actions`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function listDsarItemActions(requestId, params = {}) {
  const query = new URLSearchParams(params).toString()
  return request(`/api/v1/dsar/${requestId}/items/actions${query ? `?${query}` : ''}`)
}

export function getDsarTimeline(requestId) {
  return request(`/api/v1/dsar/${requestId}/timeline`)
}

// selection: 'ALL' | 'SELECTED' | { itemIds } | { filter }
export function buildDsarPackage(requestId, selection = 'ALL') {
  return request(`/api/v1/dsar/${requestId}/package`, {
    method: 'POST',
    body: JSON.stringify({ selection }),
  })
}

// 409 while any item action is still REQUESTED or RUNNING. The caller should
// surface that as "work is still in flight", not as a generic failure.
export function closeDsar(requestId, note) {
  return request(`/api/v1/dsar/${requestId}/close`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  })
}

// --- Import (PLAN Phase 3) ---------------------------------------------------

export function createImportBatch(payload) {
  return request('/api/v1/imports', { method: 'POST', body: JSON.stringify(payload) })
}

export function listImportBatches(params = {}) {
  const query = new URLSearchParams(params).toString()
  return request(`/api/v1/imports${query ? `?${query}` : ''}`)
}

export function getImportBatch(batchId) {
  return request(`/api/v1/imports/${batchId}`)
}

export function closeImportBatch(batchId, note) {
  return request(`/api/v1/imports/${batchId}/close`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  })
}

// Multipart, so it bypasses `request()` for the same reason uploadPhotos does:
// setting Content-Type by hand stops the browser generating the boundary.
export async function uploadImportItems(batchId, files) {
  const form = new FormData()
  for (const file of files) form.append('photos', file)

  const res = await fetch(`${BASE_URL}/api/v1/imports/${batchId}/items`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  })

  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const error = new Error(body?.error ?? `Import upload failed with status ${res.status}`)
    error.status = res.status
    error.details = body?.details
    throw error
  }
  clearApiCache()
  return body
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

// --- Recordings (audio) -------------------------------------------------------
// Add this block after the Face enrollment section, or anywhere alongside
// the other session-scoped functions — order doesn't matter, grouping does.

export function listRecordings(sessionId) {
  return request(`/api/v1/sessions/${sessionId}/recordings`)
}

// Multipart, same reasoning as uploadPhotos: bypasses request() because that
// helper always sets a JSON content-type, which would stop the browser from
// generating the multipart boundary.
/**
 * Uploads one recording or a batch of them.
 *
 * `file` may be a File or an array of them. The field name is the same either
 * way — the route takes `main_audio` as a repeated part — so a single-file call
 * behaves exactly as it always did and gets the same `{recording, duplicate}`
 * response; a batch gets the per-file `{added, duplicates, failed, accepted,
 * rejected}` shape the photo batch route already returns.
 */
export async function uploadRecording(sessionId, file) {
  const form = new FormData()
  for (const one of Array.isArray(file) ? file : [file]) form.append('main_audio', one)

  const res = await fetch(`${BASE_URL}/api/v1/sessions/${sessionId}/recordings`, {
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
  clearApiCache()
  return body
}

// No body. This used to upload reference clips as `voice_snippets` paired with
// `snippet_muids`, and the comment here was about getting that pairing right —
// the UI built it from explicit (subject, file) objects so a positional bug
// could not mismatch them. That whole problem is gone: speaker identity now
// comes from the subjects' persisted voice enrollments, which the backend loads
// into a per-recording gallery itself. The client cannot influence who gets
// recognised, which is a stronger guarantee than pairing carefully.
//
// Returns { segments, gallery }. `gallery` reports how the roster was covered —
// `notEnrolled` are people with no voice print (an agent can fix that by
// enrolling them), `broken` are people who have one that could not be loaded (a
// fault, not a gap). Both end up muted, so the UI has to be able to tell the
// operator which happened.
export async function analyzeRecording(sessionId, recordingId) {
  const res = await fetch(
    `${BASE_URL}/api/v1/sessions/${sessionId}/recordings/${recordingId}/analyze`,
    { method: 'POST', credentials: 'include' },
  )

  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const error = new Error(body?.error ?? `Analysis failed with status ${res.status}`)
    error.status = res.status
    throw error
  }
  clearApiCache()
  return body
}

export function redactRecording(sessionId, recordingId) {
  return request(`/api/v1/sessions/${sessionId}/recordings/${recordingId}/redact`, {
    method: 'POST',
  })
}

export function getRecording(sessionId, recordingId) {
  return request(`/api/v1/sessions/${sessionId}/recordings/${recordingId}`)
}

export function updateRecordingSegments(sessionId, recordingId, segments) {
  return request(`/api/v1/sessions/${sessionId}/recordings/${recordingId}/segments`, {
    method: 'PUT',
    body: JSON.stringify({ segments }),
  })
}

// --- Text Documents (Collection Agent) ---------------------------------------

export function listDocuments(sessionId) {
  return request(`/api/v1/sessions/${sessionId}/documents`)
}

export function getDocument(sessionId, documentId) {
  return request(`/api/v1/sessions/${sessionId}/documents/${documentId}`)
}

export async function uploadDocument(sessionId, payload) {
  return request(`/api/v1/sessions/${sessionId}/documents`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function uploadDocumentFile(sessionId, file, name) {
  const form = new FormData()
  form.append('file', file, name || file.name)
  if (name) form.append('name', name)

  const res = await fetch(`${BASE_URL}/api/v1/sessions/${sessionId}/documents`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  })

  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const error = new Error(body?.error ?? `Document upload failed with status ${res.status}`)
    error.status = res.status
    throw error
  }
  clearApiCache()
  return body
}

export function updateDocumentSpans(sessionId, documentId, spans) {
  return request(`/api/v1/sessions/${sessionId}/documents/${documentId}/spans`, {
    method: 'PUT',
    body: JSON.stringify({ spans }),
  })
}

export function analyzeDocument(sessionId, documentId) {
  return request(`/api/v1/sessions/${sessionId}/documents/${documentId}/analyze`, {
    method: 'POST',
  })
}

export function redactDocument(sessionId, documentId) {
  return request(`/api/v1/sessions/${sessionId}/documents/${documentId}/redact`, {
    method: 'POST',
  })
}

export const mediaUrl = {
  photo: (sessionId, photoId) => `${BASE_URL}/api/v1/sessions/${sessionId}/photos/${photoId}/file`,
  faceCrop: (sessionId, faceId) => `${BASE_URL}/api/v1/sessions/${sessionId}/faces/${faceId}/crop`,
  redacted: (sessionId, photoId) =>
    `${BASE_URL}/api/v1/sessions/${sessionId}/photos/${photoId}/redacted`,
  // Grid-sized variants. Same authorisation as their full-size counterparts —
  // they exist to stop a gallery pulling 2816x1584 frames into 250px tiles,
  // which is several megabytes to paint a few hundred kilobytes of pixels.
  redactedThumb: (sessionId, photoId) =>
    `${BASE_URL}/api/v1/sessions/${sessionId}/photos/${photoId}/redacted/thumb`,
  photoThumb: (sessionId, photoId) =>
    `${BASE_URL}/api/v1/sessions/${sessionId}/photos/${photoId}/file/thumb`,
  personRedacted: (sessionId, subjectId, photoId) =>
    `${BASE_URL}/api/v1/sessions/${sessionId}/people/${subjectId}/photos/${photoId}/redacted`,
  rawRecording: (sessionId, recordingId) =>
    `${BASE_URL}/api/v1/sessions/${sessionId}/recordings/${recordingId}/raw`,
  redactedRecording: (sessionId, recordingId) =>
    `${BASE_URL}/api/v1/sessions/${sessionId}/recordings/${recordingId}/redacted`,
  rawDocument: (sessionId, documentId) =>
    `${BASE_URL}/api/v1/sessions/${sessionId}/documents/${documentId}/raw`,
  redactedDocument: (sessionId, documentId) =>
    `${BASE_URL}/api/v1/sessions/${sessionId}/documents/${documentId}/redacted`,
  // Video. There is deliberately no `rawVideo` here: the original clip is the
  // one thing no admin screen streams. The blurred derivative is what review
  // and handoff look at, and an unblurred clip on screen is a bystander's face
  // shown to someone with no lawful basis for it.
  redactedVideo: (sessionId, videoId) =>
    `${BASE_URL}/api/v1/sessions/${sessionId}/videos/${videoId}/redacted`,
  videoTrackCrop: (sessionId, trackId) =>
    `${BASE_URL}/api/v1/sessions/${sessionId}/video-tracks/${trackId}/crop`,
}

export function listVideos(sessionId) {
  return request(`/api/v1/sessions/${sessionId}/videos`)
}

export function getVideo(sessionId, videoId) {
  return request(`/api/v1/sessions/${sessionId}/videos/${videoId}`)
}

// Multipart, for the same reason uploadPhotos is: the shared request() helper
// always sets a JSON content-type, which would stop the browser generating the
// multipart boundary.
/** Uploads one clip or a batch. See uploadRecording for the response shapes. */
export async function uploadVideo(sessionId, file) {
  const form = new FormData()
  for (const one of Array.isArray(file) ? file : [file]) form.append('video', one)

  const res = await fetch(`${BASE_URL}/api/v1/sessions/${sessionId}/videos`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  })

  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const error = new Error(body?.error ?? `Upload failed with status ${res.status}`)
    error.status = res.status
    error.code = body?.code
    throw error
  }
  return body
}

export function splitTracks(sessionId, clusterId, trackIds) {
  return request(`/api/v1/sessions/${sessionId}/clusters/${clusterId}/split-tracks`, {
    method: 'POST',
    body: JSON.stringify({ trackIds }),
  })
}



// --- Project export ---------------------------------------------------------
// The requirement that had no route and no button. See
// backend/src/modules/projects/projectExport.service.js for the scope decision:
// redacted derivatives only, no approval workflow, dataOwner own-project, with a
// mandatory AccessEvent standing in for the approval gate.

export function requestProjectExport(projectId) {
  return request(`/api/v1/projects/${projectId}/exports`, { method: 'POST' })
}

export function listProjectExports(projectId) {
  return request(`/api/v1/projects/${projectId}/exports`)
}

export function getProjectExport(projectId, exportId) {
  return request(`/api/v1/projects/${projectId}/exports/${exportId}`)
}

/**
 * The download URL. Deliberately a URL rather than a fetch: the browser's own
 * download manager handles Range resumption and multi-gigabyte files, and
 * pulling an archive of that size through fetch() into a Blob would put it in
 * the tab's memory — the same mistake the server-side writer used to make.
 */
export function projectExportDownloadUrl(projectId, exportId) {
  return `${BASE_URL}/api/v1/projects/${projectId}/exports/${exportId}/download`
}

// --- Operations -------------------------------------------------------------

export function getQueueHealth() {
  return request('/api/v1/ops/queue-health')
}

export function requeueStalled(payload = {}) {
  return request('/api/v1/ops/requeue', { method: 'POST', body: JSON.stringify(payload) })
}
