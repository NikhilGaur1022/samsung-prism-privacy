import { prisma } from '../config/prisma.js'
import { ApiError } from '../middleware/errorHandler.js'
import { logger } from './logger.js'

// AuditLog records mutations; this records *reads*. DPDP §8(4) makes "who looked
// at this person's face, when, and under what purpose" a question the fiduciary
// must be able to answer, and a mutation log cannot answer it.
//
// The contract that makes it worth having: recordAccess THROWS. A read whose
// access log failed to write is a read with no record, and an unrecorded read of
// biometric data is exactly the thing the obligation exists to prevent. Callers
// must not wrap this in a try/catch that swallows — fail the request instead.

export const ACTOR_TYPE = { ADMIN: 'ADMIN', SUBJECT: 'SUBJECT', SERVICE: 'SERVICE' }

// Derives who is acting from whatever auth middleware ran. Kept here so no route
// hand-rolls it and quietly logs `actorId: undefined`.
export function actorFromRequest(req) {
  if (req?.admin?.id) return { actorType: ACTOR_TYPE.ADMIN, actorId: req.admin.id }
  if (req?.subject?.masterUserId) {
    return { actorType: ACTOR_TYPE.SUBJECT, actorId: req.subject.masterUserId }
  }
  return { actorType: ACTOR_TYPE.SERVICE, actorId: null }
}

// The IP written here is evidence: it appears in the access ledger a DPO reads
// back when answering "who looked at this". Reading X-Forwarded-For directly, as
// this did, meant any client could choose what that evidence said by sending the
// header itself — the ledger recorded the attacker's claim, not the connection.
//
// req.ip is the same value only when Express has been told how many proxy hops
// to trust (see `trust proxy` in app.js). With that set, Express walks the
// forwarded chain from the right and stops at the first hop it does not trust,
// which is the only way to read the header safely. Without it req.ip is the
// socket address, which is wrong behind a proxy but not forgeable — a
// conservative failure, unlike the previous one.
function clientMeta(req) {
  if (!req) return { ip: null, userAgent: null }
  return {
    ip: req.ip || req.socket?.remoteAddress || null,
    userAgent: req.headers?.['user-agent']?.slice(0, 512) ?? null,
  }
}

export async function recordAccess({
  actorType,
  actorId,
  objectType,
  objectId,
  action = 'VIEW',
  purpose = null,
  dsarRequestId = null,
  projectId = null,
  breakGlass = false,
  justification = null,
  req = null,
}) {
  const resolved = actorType ? { actorType, actorId: actorId ?? null } : actorFromRequest(req)
  const { ip, userAgent } = clientMeta(req)

  if (!objectType || !objectId) {
    throw new Error('recordAccess requires objectType and objectId')
  }
  if (breakGlass && (!justification || justification.trim().length < 20)) {
    throw new ApiError(400, 'Break-glass access requires a written justification of at least 20 characters')
  }

  try {
    return await prisma.accessEvent.create({
      data: {
        actorType: resolved.actorType,
        actorId: resolved.actorId,
        objectType,
        objectId: String(objectId),
        action,
        purpose,
        dsarRequestId,
        projectId,
        ip,
        userAgent,
        breakGlass,
        justification,
      },
    })
  } catch (err) {
    // Deliberately loud and deliberately fatal. If this table is unwritable the
    // system has lost its ability to account for reads, and the correct posture
    // is to stop serving data rather than to serve it unaccountably.
    logger.error(
      { err, objectType, objectId, action, actorId: resolved.actorId },
      'ACCESS LOG WRITE FAILED — refusing the read',
    )
    throw new ApiError(503, 'Access could not be recorded; the read was refused')
  }
}

// A denied attempt is evidence too — repeated 403s on one subject's media is the
// signal an insider probe looks like. Denials must never fail the response they
// annotate, so this one swallows and logs.
export async function recordDenied({ objectType, objectId, purpose = null, req = null }) {
  try {
    await recordAccess({ objectType, objectId, action: 'DENIED', purpose, req })
  } catch (err) {
    logger.error({ err, objectType, objectId }, 'Failed to record DENIED access event')
  }
}

// Returns { items, nextCursor }. Before the cursor existed this took the most
// recent `limit` rows and stopped, so 93% of the access ledger was unreachable
// through the only route that reads it — a compliance record you cannot page
// through is a compliance record you do not have.
export async function listAccessEvents({
  actorId,
  objectType,
  objectId,
  dsarRequestId,
  since,
  limit = 100,
  cursor,
}) {
  const rows = await prisma.accessEvent.findMany({
    where: {
      ...(actorId ? { actorId } : {}),
      ...(objectType ? { objectType } : {}),
      ...(objectId ? { objectId: String(objectId) } : {}),
      ...(dsarRequestId ? { dsarRequestId } : {}),
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  })

  // take: limit + 1 rather than a second count query — the presence of the extra
  // row is the whole answer to "is there more", and it costs one row.
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null }
}
