import { ApiError } from './errorHandler.js'

// Validation that runs BEFORE anything else in the route chain, including
// logAccess.
//
// The bug this exists for: logAccess resolves the object id off req.params and
// writes the AccessEvent, and the handler is where uuid.parse() runs. So the row
// was written first and the 400 raised second, and AccessEvent.objectId is plain
// text — which meant a single GET with a junk id permanently recorded that an
// agent had viewed a photograph that does not exist. It was also an unbounded,
// unauthenticated-shaped INSERT primitive (one row per HTTP GET) against the
// append-only table DPDP accountability rests on, and it poisoned the
// [objectType, objectId] index that DSAR discovery reads.
//
// Why router.param() and not a router.use() guard: Express does not populate
// req.params for router.use() middleware — only mount-path params are visible
// there — so a use()-based validator would silently see nothing. A param
// callback fires whenever a matched route declares that param, ahead of the
// route's own middleware, which is exactly the ordering required.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// Every route param in the application that is a database uuid. `:token` is
// deliberately absent — join and invite tokens are opaque hex, not uuids.
export const UUID_PARAM_NAMES = [
  'id',
  'adminId',
  'batchId',
  'clusterId',
  'documentId',
  'faceId',
  'photoId',
  'projectId',
  'purgeJobId',
  'recordingId',
  'requestId',
  'sessionId',
  'subjectId',
  'templateId',
  'trackId',
  'videoId',
]

/**
 * Registers uuid validation for every known id param on a router.
 *
 * Called from app.js against every mounted router rather than from inside each
 * route module, so a new router picks it up by being mounted and a new route
 * picks it up by naming its param the same way everything else does. Registering
 * a name a router never uses is inert.
 */
export function installUuidParams(router) {
  for (const name of UUID_PARAM_NAMES) {
    router.param(name, (req, _res, next, value) => {
      if (!UUID_RE.test(value)) {
        return next(new ApiError(400, 'Validation failed', { field: name, reason: 'not a uuid' }))
      }
      next()
    })
  }
  return router
}

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value)
}
