import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { computeChainHash } from '../../lib/auditLog.js'
import { listAccessEvents } from '../../lib/accessLog.js'

// Read + verification surface over the two evidentiary tables. Both are
// append-only at the database level (see the RLS migration), so there is no write
// path here on purpose.

// Scoping rules, matrix §Audit. Enforced here rather than only in requireRole,
// because "which rows" is a service question and requireRole only answers
// "which roles".
async function scopeFilter(actor) {
  if (actor.subject) {
    // A principal sees entries about themselves. Their masterUserId appears as
    // the entityId on Subject-scoped rows and as the actorId on rows they caused.
    return {
      OR: [
        { entityType: 'Subject', entityId: actor.subject.masterUserId },
        { actorId: actor.subject.masterUserId },
      ],
    }
  }

  const role = actor.admin?.role
  if (role === 'dpo' || role === 'dataAdmin' || role === 'super_admin') return {}

  if (role === 'dataOwner') {
    // Own projects only, plus the sessions underneath them. Resolved to explicit
    // id lists rather than a join so that a future entityType cannot silently
    // widen the scope.
    const projects = await prisma.project.findMany({
      where: { ownerAdminId: actor.admin.id },
      select: { id: true, sessions: { select: { id: true } } },
    })
    const projectIds = projects.map((p) => p.id)
    const sessionIds = projects.flatMap((p) => p.sessions.map((s) => s.id))
    if (projectIds.length === 0) return { id: { in: [] } }
    return {
      OR: [
        { entityType: 'Project', entityId: { in: projectIds } },
        { entityType: 'Session', entityId: { in: sessionIds } },
      ],
    }
  }

  throw new ApiError(403, 'This role may not read the audit log')
}

export async function listAudit(actor, { entityType, entityId, action, limit = 100, cursor } = {}) {
  const scope = await scopeFilter(actor)

  return prisma.auditLog.findMany({
    where: {
      ...scope,
      ...(entityType ? { entityType } : {}),
      ...(entityId ? { entityId } : {}),
      ...(action ? { action } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      entityType: true,
      entityId: true,
      action: true,
      actorId: true,
      payloadHash: true,
      prevHash: true,
      createdAt: true,
      // payloadDigest is deliberately not selected: it is an integrity input, not
      // information a reader needs, and exposing it invites offline guessing of
      // small payloads.
    },
  })
}

/**
 * Recomputes the hash chain for one entity and reports exactly what holds.
 *
 * Two independent checks per row:
 *   - LINKAGE: prevHash equals the previous row's payloadHash. Catches insertion,
 *     deletion and reordering.
 *   - RECOMPUTE: payloadHash equals HMAC over the row's own stored fields. Catches
 *     an in-place edit of entityType, entityId, action, actorId or payloadDigest.
 *
 * Rows written before payloadDigest existed cannot be recomputed. They are
 * reported as `linkageOnly` and are NOT counted as verified — a verifier that
 * reports "OK" for rows it cannot actually check is worse than no verifier.
 */
export async function verifyChain(entityType, entityId) {
  const rows = await prisma.auditLog.findMany({
    where: { entityType, entityId },
    orderBy: { createdAt: 'asc' },
  })

  if (rows.length === 0) {
    return { entityType, entityId, entries: 0, valid: true, verified: 0, linkageOnly: 0, breaks: [] }
  }

  const breaks = []
  let verified = 0
  let linkageOnly = 0
  let expectedPrev = null

  for (const [index, row] of rows.entries()) {
    if (row.prevHash !== expectedPrev) {
      breaks.push({
        index,
        id: row.id,
        createdAt: row.createdAt,
        reason: 'LINKAGE_BROKEN',
        detail: `prevHash ${row.prevHash ?? 'null'} does not match the preceding entry's payloadHash ${expectedPrev ?? 'null'}`,
      })
    }

    if (row.payloadDigest) {
      const recomputed = computeChainHash({
        entityType: row.entityType,
        entityId: row.entityId,
        action: row.action,
        actorId: row.actorId,
        payloadDigest: row.payloadDigest,
        prevHash: row.prevHash,
      })
      if (recomputed !== row.payloadHash) {
        breaks.push({
          index,
          id: row.id,
          createdAt: row.createdAt,
          reason: 'HASH_MISMATCH',
          detail: 'the stored payloadHash is not the HMAC of this row — a field was edited in place',
        })
      } else {
        verified += 1
      }
    } else {
      linkageOnly += 1
    }

    expectedPrev = row.payloadHash
  }

  return {
    entityType,
    entityId,
    entries: rows.length,
    valid: breaks.length === 0,
    verified,
    linkageOnly,
    // Honest caveat rather than a silent one: the newest entry's own hash has no
    // successor pointing at it, so editing only that row's payloadHash is caught
    // by RECOMPUTE but not by LINKAGE. On legacy rows with no digest, it is not
    // caught at all.
    caveat:
      linkageOnly > 0
        ? `${linkageOnly} legacy entr${linkageOnly === 1 ? 'y' : 'ies'} predate payloadDigest and were checked by linkage only`
        : null,
    breaks,
  }
}

export async function getAccessEvents(actor, query) {
  if (actor.subject) {
    // A principal may read access events about their own objects. Scoping is by
    // the objects they own rather than by actorId — the interesting question for
    // them is "who looked at my face", not "what did I click".
    const [photoLinks, enrollments] = await Promise.all([
      prisma.photoSubject.findMany({
        where: { subjectId: actor.subject.masterUserId },
        select: { photoId: true },
      }),
      prisma.subjectFaceEnrollment.findMany({
        where: { subjectId: actor.subject.masterUserId },
        select: { id: true },
      }),
    ])

    const ownedIds = [
      ...photoLinks.map((p) => p.photoId),
      ...enrollments.map((e) => e.id),
      actor.subject.masterUserId,
    ]

    const limit = query?.limit ?? 100
    const rows = await prisma.accessEvent.findMany({
      where: { objectId: { in: ownedIds } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query?.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    })
    const hasMore = rows.length > limit
    const items = hasMore ? rows.slice(0, limit) : rows
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null }
  }

  const role = actor.admin?.role
  if (!['dpo', 'dataAdmin', 'super_admin'].includes(role)) {
    throw new ApiError(403, 'This role may not read access events')
  }
  return listAccessEvents(query ?? {})
}
