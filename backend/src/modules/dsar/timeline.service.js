import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { coarseStatus } from './lifecycle.js'
import { pseudonymise } from './dsar.service.js'

// "What happened on this request, in order, and who did it."
//
// The stated core pain point, and the one question the audit chain cannot answer
// on its own. `AuditLog` stores a hash of the payload and never the payload —
// excellent tamper-evidence, useless as a narrative. So the narrative is built
// from the TYPED tables, which kept the content, and the chain is attached
// alongside as evidence that the narrative was not edited afterwards.
//
// One shape for every entry, because a timeline that renders six different
// shapes is six different components and they drift:
//   { at, kind, actor, summary, refId, hash? , detail }

const READ_ROLES = ['dpo', 'dataAdmin', 'super_admin']

// Audit actions that represent a lifecycle transition and have no typed row of
// their own. Everything else in the chain is either duplicated by a typed table
// (and rendered from there, with the content) or is not a timeline event.
const TRANSITION_ACTIONS = {
  DSAR_RAISED: 'Request raised',
  DSAR_ASSIGNED: 'Assigned to a handler',
  DSAR_CLOSED: 'Request closed',
  DSAR_REJECTED: 'Request rejected',
  DSAR_DISCOVERY_RUN: 'Discovery walk run',
  PURGE_EXHAUSTED_RETRIES: 'Erasure exhausted its retries',
  DSAR_ITEM_ACTION_EXHAUSTED_RETRIES: 'An item action exhausted its retries',
  ACCESS_PACKAGE_TOKEN_REISSUED: 'Download link re-issued to the data principal',
}

function entry(at, kind, summary, { actor = null, refId = null, hash = null, detail = null } = {}) {
  return { at: new Date(at).toISOString(), kind, summary, actor, refId, hash, detail }
}

/**
 * Merged, time-ordered history of one request.
 *
 * Pseudonymous: the subject is `SUB-xxxxxxxx` throughout, so a dpo can read the
 * whole history of a request without learning whose it is.
 */
export async function getRequestTimeline(requestId, admin) {
  if (!READ_ROLES.includes(admin?.role)) {
    throw new ApiError(403, 'Not authorized to read a DSAR timeline')
  }

  const request = await prisma.dsarRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      subjectId: true,
      type: true,
      status: true,
      channel: true,
      autoRaised: true,
      assignedAdminId: true,
      slaDueAt: true,
      internalDueAt: true,
      resolutionNote: true,
      rejectionReason: true,
      closedAt: true,
      createdAt: true,
    },
  })
  if (!request) throw new ApiError(404, 'DSAR request not found')

  const [audit, evidence, actions, purgeJobs, accessEvents, certificate] = await Promise.all([
    prisma.auditLog.findMany({
      where: { entityType: 'DsarRequest', entityId: requestId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, action: true, actorId: true, payloadHash: true, prevHash: true, createdAt: true },
    }),
    prisma.dsarEvidence.findMany({
      where: { dsarRequestId: requestId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, kind: true, label: true, contentHash: true, createdByAdminId: true, createdAt: true },
    }),
    prisma.dsarItemAction.findMany({
      where: { dsarRequestId: requestId },
      orderBy: { requestedAt: 'asc' },
      select: {
        id: true,
        itemId: true,
        kind: true,
        status: true,
        batchId: true,
        reason: true,
        error: true,
        hashBefore: true,
        requestedByAdminId: true,
        requestedAt: true,
        completedAt: true,
      },
    }),
    prisma.purgeJob.findMany({
      where: { dsarRequestId: requestId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        scope: true,
        status: true,
        locationsTotal: true,
        locationsDone: true,
        keyDestroyedAt: true,
        startedAt: true,
        finishedAt: true,
        createdAt: true,
      },
    }),
    // Reads recorded against this request. Scoped by dsarRequestId rather than by
    // the subject: a search that named the subject but was booked to a different
    // request belongs on that request's timeline, not this one.
    prisma.accessEvent.findMany({
      where: { dsarRequestId: requestId },
      orderBy: { createdAt: 'asc' },
      take: 500,
      select: {
        id: true,
        actorType: true,
        actorId: true,
        objectType: true,
        action: true,
        purpose: true,
        breakGlass: true,
        createdAt: true,
      },
    }),
    prisma.deletionCertificate.findUnique({
      where: { dsarRequestId: requestId },
      // issuedAt, not createdAt — DeletionCertificate names its own clock.
      select: { id: true, payloadHash: true, signingKeyId: true, issuedByAdminId: true, issuedAt: true },
    }),
  ])

  const entries = []

  // ---- lifecycle transitions (from the chain; content lives in the row) ------
  for (const row of audit) {
    const label = TRANSITION_ACTIONS[row.action]
    if (!label) continue
    entries.push(
      entry(row.createdAt, 'TRANSITION', label, {
        actor: row.actorId ? { type: 'ADMIN', id: row.actorId } : { type: 'SYSTEM', id: null },
        refId: row.id,
        // The chain hash, carried so a reader can check the entry against
        // GET /api/v1/audit/verify. It is evidence, not content.
        hash: row.payloadHash,
        detail: { action: row.action },
      }),
    )
  }

  // ---- batched item actions -------------------------------------------------
  // One entry per batch, not per item: a 200-item bulk delete is one decision an
  // operator made, and 200 rows would bury every other event on the timeline.
  const batches = new Map()
  for (const a of actions) {
    const key = a.batchId ?? `single:${a.id}`
    if (!batches.has(key)) {
      batches.set(key, {
        batchId: a.batchId,
        at: a.requestedAt,
        actor: a.requestedByAdminId,
        kinds: {},
        statuses: {},
        reason: a.reason,
        total: 0,
        lastCompletedAt: null,
      })
    }
    const b = batches.get(key)
    b.total += 1
    b.kinds[a.kind] = (b.kinds[a.kind] ?? 0) + 1
    b.statuses[a.status] = (b.statuses[a.status] ?? 0) + 1
    if (new Date(a.requestedAt) < new Date(b.at)) b.at = a.requestedAt
    if (a.completedAt && (!b.lastCompletedAt || new Date(a.completedAt) > new Date(b.lastCompletedAt))) {
      b.lastCompletedAt = a.completedAt
    }
  }
  for (const b of batches.values()) {
    const kinds = Object.entries(b.kinds)
      .map(([k, n]) => `${n} ${k.toLowerCase()}`)
      .join(', ')
    entries.push(
      entry(b.at, 'ITEM_ACTION_BATCH', `Item actions requested — ${kinds}`, {
        actor: b.actor ? { type: 'ADMIN', id: b.actor } : { type: 'SYSTEM', id: null },
        refId: b.batchId,
        detail: {
          total: b.total,
          kinds: b.kinds,
          statuses: b.statuses,
          reason: b.reason,
          lastCompletedAt: b.lastCompletedAt,
          // The downgrade, surfaced on the timeline rather than buried in a row:
          // a handler who asked for a delete and got a redaction should see that
          // on the record of what happened.
          downgradedToRedact: Object.entries(b.kinds).length > 1 && (b.statuses.SKIPPED ?? 0) > 0,
        },
      }),
    )
  }

  // ---- evidence -------------------------------------------------------------
  for (const e of evidence) {
    entries.push(
      entry(e.createdAt, 'EVIDENCE', `${e.kind.replace(/_/g, ' ').toLowerCase()} — ${e.label}`, {
        actor: e.createdByAdminId ? { type: 'ADMIN', id: e.createdByAdminId } : { type: 'SYSTEM', id: null },
        refId: e.id,
        hash: e.contentHash,
        detail: { kind: e.kind },
      }),
    )
  }

  // ---- purge jobs -----------------------------------------------------------
  for (const j of purgeJobs) {
    const what = j.scope === 'PARTIAL' ? 'Scoped item deletion' : 'Whole-subject erasure'
    entries.push(
      entry(j.createdAt, 'PURGE_PLANNED', `${what} planned — ${j.locationsTotal} location(s)`, {
        refId: j.id,
        detail: { scope: j.scope, locationsTotal: j.locationsTotal },
      }),
    )
    if (j.finishedAt || ['COMPLETED', 'PARTIAL', 'FAILED'].includes(j.status)) {
      entries.push(
        entry(j.finishedAt ?? j.startedAt ?? j.createdAt, 'PURGE_RESULT', `${what} ${j.status.toLowerCase()} — ${j.locationsDone}/${j.locationsTotal} location(s)`, {
          refId: j.id,
          detail: {
            scope: j.scope,
            status: j.status,
            locationsDone: j.locationsDone,
            locationsTotal: j.locationsTotal,
            keyDestroyedAt: j.keyDestroyedAt,
          },
        }),
      )
    }
  }

  // ---- reads ----------------------------------------------------------------
  for (const a of accessEvents) {
    entries.push(
      entry(a.createdAt, a.breakGlass ? 'BREAK_GLASS' : 'ACCESS', `${a.action} on ${a.objectType}`, {
        actor: { type: a.actorType, id: a.actorId },
        refId: a.id,
        detail: { purpose: a.purpose, breakGlass: a.breakGlass },
      }),
    )
  }

  if (certificate) {
    entries.push(
      entry(certificate.issuedAt, 'CERTIFICATE', 'Signed deletion certificate issued', {
        actor: certificate.issuedByAdminId ? { type: 'ADMIN', id: certificate.issuedByAdminId } : { type: 'SYSTEM', id: null },
        refId: certificate.id,
        hash: certificate.payloadHash,
        detail: { signingKeyId: certificate.signingKeyId },
      }),
    )
  }

  entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))

  return {
    requestId: request.id,
    subjectRef: pseudonymise(request.subjectId),
    type: request.type,
    status: request.status,
    coarseStatus: coarseStatus(request.status),
    channel: request.channel,
    autoRaised: request.autoRaised,
    assignedAdminId: request.assignedAdminId,
    raisedAt: request.createdAt,
    closedAt: request.closedAt,
    slaDueAt: request.slaDueAt,
    internalDueAt: request.internalDueAt,
    resolutionNote: request.resolutionNote,
    rejectionReason: request.rejectionReason,
    entries,
    // The chain is reported as a whole rather than event by event: its guarantee
    // is over the sequence, and per-entry hashes above are pointers into it.
    integrity: {
      auditEntries: audit.length,
      firstHash: audit[0]?.payloadHash ?? null,
      lastHash: audit[audit.length - 1]?.payloadHash ?? null,
      verifyWith: '/api/v1/audit/verify',
      note: 'audit_log stores a hash of each payload and never the payload. Content above is read from the typed tables; the hashes are what prove those rows were not edited after the fact.',
    },
  }
}

// ---------------------------------------------------------------------------
// The data principal's own view (PLAN Phase 9)
// ---------------------------------------------------------------------------

// Milestones a principal is entitled to see, and the plain words for each. The
// map is an ALLOWLIST, not a redaction pass over the operator timeline: a
// timeline built by removing fields leaks the next field somebody forgets to
// remove, whereas one built by naming what may appear cannot.
const SUBJECT_MILESTONES = {
  DSAR_RAISED: 'We received your request',
  DSAR_ASSIGNED: 'A handler was assigned to your request',
  DSAR_DISCOVERY_RUN: 'We searched our systems for your data',
  DSAR_CLOSED: 'Your request was closed',
  DSAR_REJECTED: 'Your request was rejected',
  ACCESS_PACKAGE_TOKEN_REISSUED: 'Your download link was re-issued',
}

/**
 * Same history, told to the person it is about.
 *
 * Four things are deliberately absent and must stay absent:
 *   * every internal actor identity — which employee touched a request is our
 *     staffing record, not the principal's data, and naming them turns a rights
 *     surface into a target list;
 *   * `AccessEvent` rows — "who looked at your face" is answerable under §8(4)
 *     through a DPO request, not streamed live into a portal where it would also
 *     name the handler working the case;
 *   * evidence content hashes and the audit chain — tamper-evidence for an
 *     auditor, noise here;
 *   * per-item ids. Counts, not a manifest.
 */
export async function getSubjectTimeline(requestId, subjectId) {
  const request = await prisma.dsarRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      subjectId: true,
      type: true,
      status: true,
      channel: true,
      slaDueAt: true,
      resolutionNote: true,
      rejectionReason: true,
      closedAt: true,
      createdAt: true,
    },
  })
  // 404 rather than 403 for another principal's request: confirming that a
  // request id exists is itself information about someone else.
  if (!request || request.subjectId !== subjectId) {
    throw new ApiError(404, 'Request not found')
  }

  const [audit, actions, purgeJobs, packages, certificate] = await Promise.all([
    prisma.auditLog.findMany({
      where: {
        entityType: 'DsarRequest',
        entityId: requestId,
        action: { in: Object.keys(SUBJECT_MILESTONES) },
      },
      orderBy: { createdAt: 'asc' },
      select: { action: true, createdAt: true },
    }),
    prisma.dsarItemAction.findMany({
      where: { dsarRequestId: requestId },
      orderBy: { requestedAt: 'asc' },
      select: { kind: true, status: true, batchId: true, requestedAt: true, completedAt: true },
    }),
    prisma.purgeJob.findMany({
      where: { dsarRequestId: requestId },
      orderBy: { createdAt: 'asc' },
      select: {
        scope: true,
        status: true,
        locationsTotal: true,
        locationsDone: true,
        finishedAt: true,
        createdAt: true,
      },
    }),
    prisma.dsarEvidence.findMany({
      where: { dsarRequestId: requestId, kind: 'EXPORT_PACKAGE' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
    prisma.deletionCertificate.findUnique({
      where: { dsarRequestId: requestId },
      select: { issuedAt: true },
    }),
  ])

  const entries = []
  const milestone = (at, kind, summary) => {
    entries.push({ at: new Date(at).toISOString(), kind, summary })
  }

  for (const row of audit) milestone(row.createdAt, 'MILESTONE', SUBJECT_MILESTONES[row.action])

  // Batched and counted. A principal is owed "what was done to my data and how
  // much of it", not a list of frame ids they cannot act on.
  const batches = new Map()
  for (const a of actions) {
    const key = a.batchId ?? 'single'
    if (!batches.has(key)) batches.set(key, { at: a.requestedAt, done: {}, total: 0 })
    const b = batches.get(key)
    b.total += 1
    if (new Date(a.requestedAt) < new Date(b.at)) b.at = a.requestedAt
    // SKIPPED is counted separately below rather than reported as an action that
    // happened: a downgraded delete did not delete anything.
    if (a.status === 'DONE') b.done[a.kind] = (b.done[a.kind] ?? 0) + 1
  }
  for (const b of batches.values()) {
    const done = Object.entries(b.done)
      .map(([kind, n]) => `${n} ${kind === 'REDACT' ? 'item(s) redacted' : kind === 'DELETE' ? 'item(s) deleted' : 'item(s) prepared for export'}`)
      .join(', ')
    milestone(
      b.at,
      'ITEMS',
      done ? `We acted on your data — ${done}` : `We began acting on ${b.total} item(s) of your data`,
    )
  }

  for (const j of purgeJobs) {
    const what = j.scope === 'PARTIAL' ? 'Selected items were deleted' : 'Your data was erased'
    if (j.finishedAt || ['COMPLETED', 'PARTIAL', 'FAILED'].includes(j.status)) {
      milestone(
        j.finishedAt ?? j.createdAt,
        'ERASURE',
        `${what} — ${j.locationsDone} of ${j.locationsTotal} location(s)`,
      )
    } else {
      milestone(j.createdAt, 'ERASURE', `${what} — erasure planned across ${j.locationsTotal} location(s)`)
    }
  }

  for (const p of packages) milestone(p.createdAt, 'PACKAGE', 'A copy of your data was prepared')
  if (certificate) {
    milestone(certificate.issuedAt, 'CERTIFICATE', 'A signed deletion certificate was issued to you')
  }

  entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))

  return {
    requestId: request.id,
    type: request.type,
    // The coarse status only. The 7-state internal enum describes our workflow,
    // not the principal's rights, and exposing it invites questions about a
    // process that is ours to run.
    coarseStatus: coarseStatus(request.status),
    raisedAt: request.createdAt,
    dueBy: request.slaDueAt,
    closedAt: request.closedAt,
    resolutionNote: request.resolutionNote,
    rejectionReason: request.rejectionReason,
    entries,
  }
}
