import { logger } from '../lib/logger.js'

export class ApiError extends Error {
  constructor(statusCode, message, details = undefined) {
    super(message)
    this.statusCode = statusCode
    this.details = details
  }
}

// Stable machine-readable codes, so a client can branch on the failure without
// string-matching a human sentence. `code` is part of the envelope contract
// asserted by tests/contract/error-envelope.test.js.
const CODE_BY_STATUS = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  503: 'SERVICE_UNAVAILABLE',
}

// `details` is forwarded to the client, so only shapes we deliberately publish
// may cross the boundary. Everything else — Prisma `meta` naming physical
// constraint columns, a worker's `detail` string carrying
// `connect ECONNREFUSED 127.0.0.1:8001`, a Python traceback with a live heap
// address — is dropped and logged instead.
//
// The rule is an allowlist of KEYS, not a blanket "objects are fine": the
// interesting leaks were all objects.
const PUBLISHABLE_DETAIL_KEYS = new Set([
  'retryAfterSeconds',
  'fields', // zod field-level errors, shaped by zodDetails() below
  'masterUserId',
  'requiredRole',
  'allowedRoles',
  'limitBytes',
  'limitCount',
  'accepted',
  'rejected',
  'missingItems',
  'unresolvedPhotoIds',
  'unresolvedCount',
  'excludedCount',
  'reason',
  // One purpose-named key rather than generic 'summary'/'progress', which would
  // widen the envelope for every other error in the system — and the leaks this
  // allowlist exists to stop were all generically-named objects. Carries only
  // aggregate counts about the requester's own erasure, no object identifiers.
  'certificateUnavailable',
  'field',
  'state',
  'from',
  'to',
])

function sanitiseDetails(details) {
  if (details === undefined || details === null) return undefined
  if (Array.isArray(details)) return details
  if (typeof details !== 'object') return undefined

  const out = {}
  for (const [key, value] of Object.entries(details)) {
    if (PUBLISHABLE_DETAIL_KEYS.has(key)) out[key] = value
  }
  return Object.keys(out).length ? out : undefined
}

// Zod reports a param-schema failure with `path: []`, because the schema was
// handed a bare string rather than an object — which is why both portals could
// only ever say "Validation failed" with no field named. Fold the path into a
// dotted name and fall back to the param name the caller supplies.
export function zodDetails(issues, fallbackField) {
  return {
    fields: issues.map((issue) => ({
      field: issue.path?.length ? issue.path.join('.') : (fallbackField ?? '(request)'),
      message: issue.message,
      code: issue.code,
    })),
  }
}

export function errorHandler(err, req, res, _next) {
  if (err.name === 'ZodError') {
    return res.status(400).json({
      error: 'Validation failed',
      code: 'VALIDATION_FAILED',
      details: zodDetails(err.issues, err.prismField),
      correlationId: req.correlationId,
    })
  }

  // Safety net behind subject.service.js's own pre-insert dedupe check, in case
  // of a race between the check and the insert. `err.meta` is NOT forwarded —
  // it names the physical constraint and its columns.
  if (err.code === 'P2002') {
    logger.warn({ err, correlationId: req.correlationId }, 'unique constraint violation')
    return res.status(409).json({
      error: 'That value is already in use',
      code: 'CONFLICT',
      correlationId: req.correlationId,
    })
  }

  const statusCode = err.statusCode ?? 500

  if (statusCode >= 500) {
    // The real message, the stack, and every detail stay server-side. What went
    // over the wire before this was `err.message` verbatim: our own TypeErrors,
    // libvips internals, and a Python `BytesIO` repr complete with a heap
    // address. The correlation id is the client's handle on the log line.
    logger.error({ err, correlationId: req.correlationId }, 'unhandled error')
    return res.status(statusCode).json({
      error:
        statusCode === 503
          ? 'A dependency is unavailable — please retry shortly'
          : 'Internal server error',
      code: CODE_BY_STATUS[statusCode] ?? 'INTERNAL_ERROR',
      correlationId: req.correlationId,
    })
  }

  res.status(statusCode).json({
    error: err.message ?? 'Request failed',
    code: err.code ?? CODE_BY_STATUS[statusCode] ?? 'REQUEST_FAILED',
    details: sanitiseDetails(err.details),
    correlationId: req.correlationId,
  })
}
