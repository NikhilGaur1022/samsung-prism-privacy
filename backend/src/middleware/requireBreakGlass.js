import { createHash } from 'node:crypto'
import { prisma } from '../config/prisma.js'
import { ApiError } from './errorHandler.js'
import { writeAuditLog } from '../lib/auditLog.js'
import { recordAccess, recordDenied } from '../lib/accessLog.js'
import { logger } from '../lib/logger.js'

// Matrix §C. Raw media reaching a dataAdmin requires ALL FOUR of:
//   1. an open DsarRequest in DISCOVERY or EXECUTING naming that subject;
//   2. an explicit dsarRequestId plus a written justification (≥20 chars);
//   3. an AccessEvent{breakGlass:true} written BEFORE the blob is decrypted —
//      if the log write fails, the read fails;
//   4. a notification landing with the DPO inside the same request.
//
// The point of the design is that break-glass is *possible* — a DSAR erasure
// genuinely requires an operator to see what is being erased — but never quiet.
// Every use leaves a request-bound, justified, DPO-visible record.

const OPEN_STATUSES = ['DISCOVERY', 'EXECUTING']
const MIN_JUSTIFICATION = 20

// Roles that may break glass at all. collectionAgent, dataOwner and dpo are
// absent by design: their basis for raw media is either operational-and-expired
// or was never granted.
const BREAK_GLASS_ROLES = ['dataAdmin', 'super_admin']

function readClaim(req, key) {
  return req.body?.[key] ?? req.query?.[key] ?? req.headers?.[`x-${key.toLowerCase()}`] ?? null
}

// DPO must learn of the access within the same request, not on a nightly digest.
// The DsarEvidence row is the durable half — it is attached to the request the
// operator invoked, so it surfaces on the DPO's oversight screen and survives in
// the evidence pack. Email, where configured, is the timely half and is
// best-effort: a mail outage must not become a way to block lawful DSAR work,
// nor a way to access data with no record.
async function notifyDpo({ request, admin, justification, objectType, objectId }) {
  const payload = {
    event: 'BREAK_GLASS_ACCESS',
    dsarRequestId: request.id,
    subjectId: request.subjectId,
    adminId: admin.id,
    adminRole: admin.role,
    objectType,
    objectId: String(objectId),
    justification,
    at: new Date().toISOString(),
  }

  const contentHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')

  await prisma.dsarEvidence.create({
    data: {
      dsarRequestId: request.id,
      kind: 'CORRESPONDENCE',
      label: `Break-glass access to ${objectType} by ${admin.role}`,
      payload,
      contentHash,
      createdByAdminId: admin.id,
    },
  })

  await writeAuditLog({
    entityType: 'DsarRequest',
    entityId: request.id,
    action: 'BREAK_GLASS_NOTIFIED_DPO',
    actorId: admin.id,
    payload,
  })
}

export function requireBreakGlass(objectType, resolveSubjectId, options = {}) {
  return async (req, _res, next) => {
    const objectId = options.resolveObjectId
      ? options.resolveObjectId(req)
      : (req.params.photoId ?? req.params.id ?? 'unknown')

    try {
      if (!req.admin) throw new ApiError(401, 'Not authenticated')

      if (!BREAK_GLASS_ROLES.includes(req.admin.role)) {
        await recordDenied({ objectType, objectId, purpose: 'BREAK_GLASS', req })
        throw new ApiError(403, 'This role may not break glass for raw media')
      }

      const dsarRequestId = readClaim(req, 'dsarRequestId')
      const justification = (readClaim(req, 'justification') ?? '').trim()

      if (!dsarRequestId) {
        await recordDenied({ objectType, objectId, purpose: 'BREAK_GLASS', req })
        throw new ApiError(400, 'Break-glass access requires dsarRequestId')
      }
      if (justification.length < MIN_JUSTIFICATION) {
        await recordDenied({ objectType, objectId, purpose: 'BREAK_GLASS', req })
        throw new ApiError(
          400,
          `Break-glass access requires a written justification of at least ${MIN_JUSTIFICATION} characters`,
        )
      }

      const request = await prisma.dsarRequest.findUnique({ where: { id: dsarRequestId } })
      if (!request) {
        await recordDenied({ objectType, objectId, purpose: 'BREAK_GLASS', req })
        throw new ApiError(404, 'DSAR request not found')
      }
      if (!OPEN_STATUSES.includes(request.status)) {
        await recordDenied({ objectType, objectId, purpose: 'BREAK_GLASS', req })
        throw new ApiError(
          403,
          `DSAR request is ${request.status} — break-glass is only open during ${OPEN_STATUSES.join(' or ')}`,
        )
      }

      // The binding that stops one open DSAR from becoming a skeleton key: the
      // object must belong to the subject the request actually names. A photo can
      // lawfully hold several subjects, so the resolver returns all of them and
      // the check is membership, not equality.
      const resolved = await resolveSubjectId(req)
      const subjectIds = Array.isArray(resolved) ? resolved : [resolved].filter(Boolean)
      if (subjectIds.length === 0) {
        await recordDenied({ objectType, objectId, purpose: 'BREAK_GLASS', req })
        throw new ApiError(404, 'Could not resolve the subject this object belongs to')
      }
      if (!subjectIds.includes(request.subjectId)) {
        await recordDenied({ objectType, objectId, purpose: 'BREAK_GLASS', req })
        throw new ApiError(403, 'This object does not belong to the subject named on that DSAR request')
      }

      // super_admin follows the same protocol minus the DSAR requirement in the
      // matrix — but where a DSAR *is* cited, it is held to it, and it carries
      // the extra second-approver check.
      if (req.admin.role === 'super_admin' && !request.dpoAdminId) {
        await recordDenied({ objectType, objectId, purpose: 'BREAK_GLASS', req })
        throw new ApiError(403, 'Root break-glass requires a DPO second approver on the request')
      }

      // Step 3, before anything is decrypted. recordAccess throws on failure.
      await recordAccess({
        objectType,
        objectId,
        action: 'DECRYPT',
        purpose: 'BREAK_GLASS',
        dsarRequestId: request.id,
        breakGlass: true,
        justification,
        req,
      })

      // Step 4, same request.
      await notifyDpo({ request, admin: req.admin, justification, objectType, objectId })

      req.breakGlass = { dsarRequestId: request.id, justification, subjectId: request.subjectId }
      next()
    } catch (err) {
      if (!(err instanceof ApiError)) {
        logger.error({ err, objectType, objectId }, 'Break-glass check failed unexpectedly')
      }
      next(err)
    }
  }
}
