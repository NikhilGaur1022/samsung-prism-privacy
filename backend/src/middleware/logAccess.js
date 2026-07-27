import { recordAccess } from '../lib/accessLog.js'

// Route-level wrapper for invariant 6: every media read writes an AccessEvent
// BEFORE anything is decrypted or streamed.
//
// It is middleware rather than a call inside each handler for one reason — a
// handler that forgets the call still returns a correct-looking image, so the
// omission is invisible in review and in manual testing. Sitting in the route
// chain, its absence is visible in the route definition itself.
//
// Ordering matters and is not negotiable: mount this AFTER the auth and
// authorization middleware (so the actor is known and a 403 never produces a
// misleading "VIEW" row) and BEFORE the handler that reads the blob.
export function logAccess(objectType, resolveId, options = {}) {
  return async (req, _res, next) => {
    try {
      const objectId = typeof resolveId === 'function' ? resolveId(req) : req.params[resolveId]
      if (!objectId) {
        return next(new Error(`logAccess(${objectType}): could not resolve the object id from the request`))
      }

      await recordAccess({
        objectType,
        objectId,
        action: options.action ?? 'VIEW',
        purpose: typeof options.purpose === 'function' ? options.purpose(req) : (options.purpose ?? null),
        projectId: options.resolveProjectId ? options.resolveProjectId(req) : null,
        // Populated by requireBreakGlass when it ran earlier in the chain.
        dsarRequestId: req.breakGlass?.dsarRequestId ?? null,
        breakGlass: Boolean(req.breakGlass),
        justification: req.breakGlass?.justification ?? null,
        req,
      })

      next()
    } catch (err) {
      // recordAccess throws on write failure by design. Propagating it is the
      // fail-closed behaviour: no log, no read.
      next(err)
    }
  }
}
