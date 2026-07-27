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

function clientMeta(req) {
  if (!req) return { ip: null, userAgent: null }
  const forwarded = req.headers?.['x-forwarded-for']
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
  return {
    ip: ip || req.ip || req.socket?.remoteAddress || null,
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

export async function listAccessEvents({ actorId, objectType, objectId, dsarRequestId, since, limit = 100 }) {
  return prisma.accessEvent.findMany({
    where: {
      ...(actorId ? { actorId } : {}),
      ...(objectType ? { objectType } : {}),
      ...(objectId ? { objectId: String(objectId) } : {}),
      ...(dsarRequestId ? { dsarRequestId } : {}),
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
}
