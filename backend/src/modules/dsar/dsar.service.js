import { createHash } from 'node:crypto'
import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { logger } from '../../lib/logger.js'
import { runDiscovery } from './discovery.service.js'
import { createPurgeJob, executePurgeJob } from './purge.service.js'
import { buildAccessPackage } from './export.service.js'
import { issueCertificate, getCertificateForRequest } from './certificate.service.js'
import { coarseStatus, statusesFor } from './lifecycle.js'
import { isResolved } from '../../lib/photoState.js'

// Request lifecycle and SLA clock.
//
//   RECEIVED → TRIAGE → DISCOVERY → EXECUTING → REVIEW → CLOSED
//                  └──────────────────────────────────→ REJECTED
//
// Two deadlines, deliberately. slaDueAt is the statutory 30 days and is the one
// that carries legal consequence. internalDueAt is 7 days and is what the SLA
// board reports against, so that missing the real deadline is never the first
// warning anyone gets.

export const SLA_DAYS = Number(process.env.DSAR_SLA_DAYS ?? 30)
export const INTERNAL_SLA_DAYS = Number(process.env.DSAR_INTERNAL_SLA_DAYS ?? 7)

const TRANSITIONS = {
  RECEIVED: ['TRIAGE', 'REJECTED'],
  TRIAGE: ['DISCOVERY', 'REJECTED'],
  DISCOVERY: ['EXECUTING', 'REVIEW', 'REJECTED'],
  EXECUTING: ['REVIEW', 'REJECTED'],
  REVIEW: ['CLOSED', 'EXECUTING'],
  CLOSED: [],
  REJECTED: [],
}

function assertTransition(from, to) {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new ApiError(409, `Cannot move a DSAR request from ${from} to ${to}`)
  }
}

// What a DPO or an auditor sees instead of a name. Matrix §D withholds subject
// identity from the DPO entirely, and an SLA board is exactly the screen where
// that leaks by accident.
export function pseudonymise(subjectId) {
  return `SUB-${createHash('sha256').update(subjectId).digest('hex').slice(0, 8)}`
}

const REQUEST_FIELDS = {
  id: true,
  subjectId: true,
  projectId: true,
  type: true,
  status: true,
  channel: true,
  description: true,
  autoRaised: true,
  assignedAdminId: true,
  dpoAdminId: true,
  slaDueAt: true,
  internalDueAt: true,
  resolutionNote: true,
  rejectionReason: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
}

function withSla(request, { pseudonymous = false } = {}) {
  const now = Date.now()
  const due = new Date(request.slaDueAt).getTime()
  const internalDue = request.internalDueAt ? new Date(request.internalDueAt).getTime() : null
  const closed = ['CLOSED', 'REJECTED'].includes(request.status)

  const shaped = {
    ...request,
    // The Open / In Progress / Closed projection, computed in one place so the
    // dashboard tabs and the API can never disagree about which tab a request
    // belongs in.
    coarseStatus: coarseStatus(request.status),
    sla: {
      dueAt: request.slaDueAt,
      internalDueAt: request.internalDueAt,
      daysRemaining: Math.ceil((due - now) / 86_400_000),
      breached: !closed && due < now,
      internalBreached: !closed && internalDue !== null && internalDue < now,
    },
  }

  if (pseudonymous) {
    shaped.subjectRef = pseudonymise(request.subjectId)
    delete shaped.subjectId
  }
  return shaped
}

/**
 * Raised by the data principal, or by the platform on a consent withdrawal.
 *
 * One open request per type per subject: a principal clicking "erase" three times
 * should get one erasure, not three purge jobs racing each other over the same
 * rows.
 */
export async function createRequest({ subjectId, type, description, projectId, channel = 'PORTAL', autoRaised = false }) {
  const open = await prisma.dsarRequest.findFirst({
    where: { subjectId, type, status: { notIn: ['CLOSED', 'REJECTED'] } },
  })
  if (open) return open

  const now = Date.now()
  const request = await prisma.dsarRequest.create({
    data: {
      subjectId,
      projectId: projectId ?? null,
      type,
      description: description ?? null,
      channel,
      autoRaised,
      status: 'RECEIVED',
      slaDueAt: new Date(now + SLA_DAYS * 86_400_000),
      internalDueAt: new Date(now + INTERNAL_SLA_DAYS * 86_400_000),
    },
    select: REQUEST_FIELDS,
  })

  await writeAuditLog({
    entityType: 'DsarRequest',
    entityId: request.id,
    action: 'DSAR_RAISED',
    actorId: autoRaised ? null : subjectId,
    payload: { type, projectId: projectId ?? null, autoRaised, channel },
  })

  return request
}

export async function getRequest(requestId, actor) {
  const request = await prisma.dsarRequest.findUnique({
    where: { id: requestId },
    select: { ...REQUEST_FIELDS, evidence: { select: { id: true, kind: true, label: true, createdAt: true } } },
  })
  if (!request) throw new ApiError(404, 'DSAR request not found')

  if (actor.subject) {
    if (request.subjectId !== actor.subject.masterUserId) {
      throw new ApiError(403, 'This request belongs to another data principal')
    }
    return withSla(request)
  }

  const role = actor.admin?.role
  if (role === 'dpo') return withSla(request, { pseudonymous: true })
  if (role === 'dataOwner' && request.assignedAdminId !== actor.admin.id) {
    throw new ApiError(403, 'You are not assigned to this request')
  }
  if (!['dpo', 'dataOwner', 'dataAdmin', 'super_admin'].includes(role)) {
    throw new ApiError(403, 'Not authorized to read DSAR requests')
  }
  return withSla(request)
}

// Keyset over (slaDueAt asc, id asc). Offset paging over a queue that reorders
// as deadlines pass would skip and repeat rows; the SLA order is exactly the
// order that changes under the reader's feet.
function encodeQueueCursor(row) {
  return Buffer.from(JSON.stringify({ slaDueAt: row.slaDueAt, id: row.id }), 'utf8').toString('base64url')
}

function decodeQueueCursor(cursor) {
  if (!cursor) return null
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'))
    if (typeof parsed?.id !== 'string' || !parsed.slaDueAt) throw new Error('shape')
    return parsed
  } catch {
    throw new ApiError(400, 'Malformed cursor')
  }
}

/**
 * Per-request counters for one page of the queue.
 *
 * Two grouped queries for the whole page rather than four per row. The item grid
 * is the screen this feeds and it is the screen most likely to be opened against
 * a subject with thousands of items.
 */
async function queueCounters(rows) {
  if (rows.length === 0) return new Map()

  const requestIds = rows.map((r) => r.id)
  const subjectIds = [...new Set(rows.map((r) => r.subjectId))]

  const [found, done] = await Promise.all([
    prisma.subjectDataItem.groupBy({
      by: ['subjectId'],
      where: { subjectId: { in: subjectIds }, deletedAt: null },
      _count: { _all: true },
    }),
    prisma.dsarItemAction.groupBy({
      by: ['dsarRequestId', 'kind'],
      where: { dsarRequestId: { in: requestIds }, status: 'DONE' },
      _count: { _all: true },
    }),
  ])

  const foundBySubject = new Map(found.map((f) => [f.subjectId, f._count._all]))
  const counters = new Map()
  for (const row of rows) {
    counters.set(row.id, {
      itemsFound: foundBySubject.get(row.subjectId) ?? 0,
      itemsRedacted: 0,
      itemsDeleted: 0,
      itemsExported: 0,
    })
  }
  for (const d of done) {
    const c = counters.get(d.dsarRequestId)
    if (!c) continue
    if (d.kind === 'REDACT') c.itemsRedacted = d._count._all
    if (d.kind === 'DELETE') c.itemsDeleted = d._count._all
    if (d.kind === 'EXPORT') c.itemsExported = d._count._all
  }
  return counters
}

/**
 * The queue behind the DSAR dashboard.
 *
 * Returns `{ items, nextCursor, counts }`. `counts` is over the whole filtered
 * set, not the page — it feeds the Open / In Progress / Closed tab badges, and a
 * badge that counted only the visible page would be worse than no badge.
 */
export async function listQueue(actor, { status, type, overdue, coarse, assignedAdminId, cursor, limit = 50 } = {}) {
  if (actor.subject) {
    const rows = await prisma.dsarRequest.findMany({
      where: { subjectId: actor.subject.masterUserId },
      orderBy: { createdAt: 'desc' },
      select: REQUEST_FIELDS,
    })
    return { items: rows.map((r) => withSla(r)), nextCursor: null, counts: null }
  }

  const role = actor.admin?.role
  if (!['dpo', 'dataOwner', 'dataAdmin', 'super_admin'].includes(role)) {
    throw new ApiError(403, 'Not authorized to read the DSAR queue')
  }

  const coarseStatuses = coarse ? statusesFor(coarse) : null
  if (coarse && !coarseStatuses) throw new ApiError(400, `Unknown lifecycle stage ${coarse}`)

  const where = {
    ...(status ? { status } : {}),
    ...(coarseStatuses && !status ? { status: { in: coarseStatuses } } : {}),
    ...(type ? { type } : {}),
    ...(overdue ? { slaDueAt: { lt: new Date() }, status: { notIn: ['CLOSED', 'REJECTED'] } } : {}),
    ...(assignedAdminId ? { assignedAdminId } : {}),
    // A data owner sees only what was routed to them, never the whole queue.
    ...(role === 'dataOwner' ? { assignedAdminId: actor.admin.id } : {}),
  }

  const take = Math.min(Math.max(Number(limit) || 50, 1), 200)
  const after = decodeQueueCursor(cursor)

  const rows = await prisma.dsarRequest.findMany({
    where: {
      AND: [
        where,
        after
          ? {
              OR: [
                { slaDueAt: { gt: new Date(after.slaDueAt) } },
                { slaDueAt: new Date(after.slaDueAt), id: { gt: after.id } },
              ],
            }
          : {},
      ],
    },
    orderBy: [{ slaDueAt: 'asc' }, { id: 'asc' }],
    take: take + 1,
    select: REQUEST_FIELDS,
  })

  const page = rows.slice(0, take)
  const hasMore = rows.length > take

  const [counters, byStatus] = await Promise.all([
    queueCounters(page),
    // Tab badges over the filtered set minus the coarse filter itself — a tab
    // that only counted its own contents could never show the other two.
    prisma.dsarRequest.groupBy({
      by: ['status'],
      where: {
        ...(type ? { type } : {}),
        ...(assignedAdminId ? { assignedAdminId } : {}),
        ...(role === 'dataOwner' ? { assignedAdminId: actor.admin.id } : {}),
      },
      _count: { _all: true },
    }),
  ])

  const counts = { OPEN: 0, IN_PROGRESS: 0, CLOSED: 0, byStatus: {} }
  for (const s of byStatus) {
    counts.byStatus[s.status] = s._count._all
    counts[coarseStatus(s.status)] += s._count._all
  }

  return {
    items: page.map((r) => ({
      ...withSla(r, { pseudonymous: role === 'dpo' }),
      counters: counters.get(r.id) ?? null,
    })),
    nextCursor: hasMore ? encodeQueueCursor(page[page.length - 1]) : null,
    counts,
  }
}

export async function assign(requestId, { assignedAdminId }, admin) {
  const request = await prisma.dsarRequest.findUnique({ where: { id: requestId } })
  if (!request) throw new ApiError(404, 'DSAR request not found')

  const assignee = await prisma.adminUser.findUnique({ where: { id: assignedAdminId } })
  if (!assignee) throw new ApiError(404, 'Admin user not found')
  if (!['dataOwner', 'dataAdmin'].includes(assignee.role)) {
    throw new ApiError(400, `A DSAR can only be assigned to a dataOwner or dataAdmin, not ${assignee.role}`)
  }

  if (request.status === 'RECEIVED') assertTransition('RECEIVED', 'TRIAGE')

  const updated = await prisma.dsarRequest.update({
    where: { id: requestId },
    data: {
      assignedAdminId,
      // The assigning DPO becomes the second approver of record, which is what
      // super_admin break-glass later checks for.
      dpoAdminId: admin.role === 'dpo' ? admin.id : request.dpoAdminId,
      status: request.status === 'RECEIVED' ? 'TRIAGE' : request.status,
    },
    select: REQUEST_FIELDS,
  })

  await writeAuditLog({
    entityType: 'DsarRequest',
    entityId: requestId,
    action: 'DSAR_ASSIGNED',
    actorId: admin.id,
    payload: { assignedAdminId, previousStatus: request.status },
  })

  return withSla(updated)
}

/**
 * Runs the lineage walk and stores the result as evidence.
 *
 * The result is attached rather than merely returned: the DPO needs to see what
 * was searched, not just what was deleted, and a discovery nobody recorded is
 * indistinguishable from one nobody ran.
 */
export async function runDiscoveryForRequest(requestId, admin) {
  const request = await prisma.dsarRequest.findUnique({ where: { id: requestId } })
  if (!request) throw new ApiError(404, 'DSAR request not found')
  if (request.status === 'RECEIVED') assertTransition('RECEIVED', 'TRIAGE')
  if (!['RECEIVED', 'TRIAGE', 'DISCOVERY'].includes(request.status)) {
    throw new ApiError(409, `Discovery cannot run while the request is ${request.status}`)
  }

  const discovery = await runDiscovery(request.subjectId)
  const contentHash = createHash('sha256').update(JSON.stringify(discovery)).digest('hex')

  await prisma.dsarEvidence.create({
    data: {
      dsarRequestId: requestId,
      kind: 'DISCOVERY_RESULT',
      label: `Lineage walk — ${discovery.counts.total} locations`,
      payload: discovery,
      contentHash,
      createdByAdminId: admin.id,
    },
  })

  const updated = await prisma.dsarRequest.update({
    where: { id: requestId },
    data: { status: 'DISCOVERY' },
    select: REQUEST_FIELDS,
  })

  await writeAuditLog({
    entityType: 'DsarRequest',
    entityId: requestId,
    action: 'DSAR_DISCOVERY_RUN',
    actorId: admin.id,
    payload: { counts: discovery.counts, contentHash },
  })

  return { request: withSla(updated), discovery }
}

export async function attachEvidence(requestId, { kind, label, payload }, admin) {
  const request = await prisma.dsarRequest.findUnique({ where: { id: requestId } })
  if (!request) throw new ApiError(404, 'DSAR request not found')

  const contentHash = createHash('sha256').update(JSON.stringify(payload ?? {})).digest('hex')

  const evidence = await prisma.dsarEvidence.create({
    data: { dsarRequestId: requestId, kind, label, payload: payload ?? null, contentHash, createdByAdminId: admin.id },
  })

  await writeAuditLog({
    entityType: 'DsarRequest',
    entityId: requestId,
    action: 'DSAR_EVIDENCE_ATTACHED',
    actorId: admin.id,
    payload: { evidenceId: evidence.id, kind, contentHash },
  })

  return evidence
}

/**
 * Executes the fulfilment. ERASE runs the purge; ACCESS builds the package;
 * CORRECT and GRIEVANCE are resolved by a human and only move status.
 *
 * The purge is run inline here and is also safe to resume from the worker — both
 * call the same idempotent executor, so an operator hitting execute twice cannot
 * double-delete.
 */
export async function execute(requestId, admin, { inline = true } = {}) {
  const request = await prisma.dsarRequest.findUnique({ where: { id: requestId } })
  if (!request) throw new ApiError(404, 'DSAR request not found')
  if (!['DISCOVERY', 'EXECUTING'].includes(request.status)) {
    throw new ApiError(409, `Execution requires the request to be in DISCOVERY or EXECUTING, not ${request.status}`)
  }

  if (request.status === 'DISCOVERY') assertTransition('DISCOVERY', 'EXECUTING')
  await prisma.dsarRequest.update({ where: { id: requestId }, data: { status: 'EXECUTING' } })

  if (['ERASE', 'WITHDRAWAL_ERASURE'].includes(request.type)) {
    const job = await createPurgeJob(requestId, admin)
    if (!inline) return { purgeJobId: job.id, status: 'QUEUED' }

    const finished = await executePurgeJob(job.id, { admin })

    if (finished.status === 'COMPLETED') {
      const certificate = await issueCertificate(finished.id, admin)
      const updated = await prisma.dsarRequest.update({
        where: { id: requestId },
        data: { status: 'REVIEW' },
        select: REQUEST_FIELDS,
      })
      return { request: withSla(updated), purgeJob: finished, certificateId: certificate.id }
    }

    // Partial: the request stays EXECUTING and the SLA clock keeps running, which
    // is the honest state — the principal's data is not fully gone.
    return { purgeJob: finished, status: finished.status }
  }

  if (request.type === 'ACCESS') {
    const pkg = await buildAccessPackage(requestId, admin)
    const updated = await prisma.dsarRequest.update({
      where: { id: requestId },
      data: { status: 'REVIEW' },
      select: REQUEST_FIELDS,
    })
    return { request: withSla(updated), package: pkg }
  }

  const updated = await prisma.dsarRequest.update({
    where: { id: requestId },
    data: { status: 'REVIEW' },
    select: REQUEST_FIELDS,
  })
  return { request: withSla(updated) }
}

export async function approveResolution(requestId, { note }, admin) {
  const request = await prisma.dsarRequest.findUnique({ where: { id: requestId } })
  if (!request) throw new ApiError(404, 'DSAR request not found')
  assertTransition(request.status, 'CLOSED')

  // An erasure cannot be closed without the certificate that proves it happened.
  if (['ERASE', 'WITHDRAWAL_ERASURE'].includes(request.type)) {
    const certificate = await getCertificateForRequest(requestId)
    if (!certificate) {
      throw new ApiError(409, 'Cannot close an erasure with no deletion certificate issued')
    }
  }

  const updated = await prisma.dsarRequest.update({
    where: { id: requestId },
    data: { status: 'CLOSED', resolutionNote: note ?? null, closedAt: new Date() },
    select: REQUEST_FIELDS,
  })

  await writeAuditLog({
    entityType: 'DsarRequest',
    entityId: requestId,
    action: 'DSAR_CLOSED',
    actorId: admin.id,
    payload: { type: request.type, note: note ?? null },
  })

  return withSla(updated)
}

/**
 * Explicit close, from the request workspace.
 *
 * Distinct from approveResolution() on purpose: approval is the DPO signing off
 * on the outcome, closing is the handler declaring the work finished. They are
 * the same transition and different acts, and the close is the one that has to
 * check that nothing is still running.
 *
 * The in-flight guard is the reason this exists. A request closed while a bulk
 * delete is still queued reports a completed obligation over data that is still
 * there, and the worker would then quietly finish deleting from a closed
 * request. 409 rather than a wait: the operator should see what is outstanding.
 */
export async function closeRequest(requestId, { note }, admin) {
  if (!['dpo', 'dataAdmin', 'super_admin'].includes(admin?.role)) {
    throw new ApiError(403, 'Not authorized to close a DSAR request')
  }

  const request = await prisma.dsarRequest.findUnique({ where: { id: requestId } })
  if (!request) throw new ApiError(404, 'DSAR request not found')
  assertTransition(request.status, 'CLOSED')

  const inFlight = await prisma.dsarItemAction.groupBy({
    by: ['status'],
    where: { dsarRequestId: requestId, status: { in: ['REQUESTED', 'RUNNING'] } },
    _count: { _all: true },
  })
  const outstanding = inFlight.reduce((n, r) => n + r._count._all, 0)
  if (outstanding > 0) {
    throw new ApiError(
      409,
      `Cannot close: ${outstanding} item action(s) have not finished. A closed request would report an obligation as met while the work is still running.`,
    )
  }

  // Same rule approveResolution() enforces, restated rather than shared: an
  // erasure with no certificate has no proof it happened, and this is a second
  // door into the same transition.
  if (['ERASE', 'WITHDRAWAL_ERASURE'].includes(request.type)) {
    const certificate = await getCertificateForRequest(requestId)
    if (!certificate) {
      throw new ApiError(409, 'Cannot close an erasure with no deletion certificate issued')
    }
  }

  const failed = await prisma.dsarItemAction.count({
    where: { dsarRequestId: requestId, status: 'FAILED' },
  })

  const summary = {
    closedBy: admin.id,
    note: note ?? null,
    // Recorded, not blocking. A failed action is a fact about the outcome and
    // the operator closing with it on the record is a decision they are allowed
    // to make; hiding it is not.
    failedActions: failed,
    finalStatus: request.status,
  }
  const contentHash = createHash('sha256').update(JSON.stringify(summary)).digest('hex')

  const updated = await prisma.$transaction(async (tx) => {
    await tx.dsarEvidence.create({
      data: {
        dsarRequestId: requestId,
        kind: 'CORRESPONDENCE',
        label: `Closure — ${note ? note.slice(0, 120) : 'no note given'}`,
        payload: summary,
        contentHash,
        createdByAdminId: admin.id,
      },
    })
    return tx.dsarRequest.update({
      where: { id: requestId },
      data: { status: 'CLOSED', resolutionNote: note ?? null, closedAt: new Date() },
      select: REQUEST_FIELDS,
    })
  })

  await writeAuditLog({
    entityType: 'DsarRequest',
    entityId: requestId,
    action: 'DSAR_CLOSED',
    actorId: admin.id,
    payload: { type: request.type, note: note ?? null, failedActions: failed, via: 'close' },
  })

  return withSla(updated)
}

export async function rejectRequest(requestId, { reason }, admin) {
  const request = await prisma.dsarRequest.findUnique({ where: { id: requestId } })
  if (!request) throw new ApiError(404, 'DSAR request not found')
  assertTransition(request.status, 'REJECTED')

  const updated = await prisma.dsarRequest.update({
    where: { id: requestId },
    data: { status: 'REJECTED', rejectionReason: reason, closedAt: new Date() },
    select: REQUEST_FIELDS,
  })

  await writeAuditLog({
    entityType: 'DsarRequest',
    entityId: requestId,
    action: 'DSAR_REJECTED',
    actorId: admin.id,
    payload: { reason },
  })

  return withSla(updated)
}

// Feeds the DPO's SLA board. Pseudonymous by construction — there is no code path
// here that can return a name.
export async function slaSummary() {
  const open = await prisma.dsarRequest.findMany({
    where: { status: { notIn: ['CLOSED', 'REJECTED'] } },
    select: { id: true, type: true, status: true, slaDueAt: true, internalDueAt: true, subjectId: true, createdAt: true, assignedAdminId: true },
  })

  const now = new Date()
  const rows = open.map((r) => ({
    id: r.id,
    subjectRef: pseudonymise(r.subjectId),
    type: r.type,
    status: r.status,
    assignedAdminId: r.assignedAdminId,
    createdAt: r.createdAt,
    slaDueAt: r.slaDueAt,
    internalDueAt: r.internalDueAt,
    daysRemaining: Math.ceil((new Date(r.slaDueAt).getTime() - now.getTime()) / 86_400_000),
    breached: new Date(r.slaDueAt) < now,
    internalBreached: r.internalDueAt ? new Date(r.internalDueAt) < now : false,
  }))

  return {
    open: rows.length,
    breached: rows.filter((r) => r.breached).length,
    internalBreached: rows.filter((r) => r.internalBreached && !r.breached).length,
    statutoryDays: SLA_DAYS,
    internalTargetDays: INTERNAL_SLA_DAYS,
    requests: rows,
  }
}

// Called by lib/consentWithdrawal so a §6(4) withdrawal walks this same audited
// executor instead of a private deletion path nobody reviews.
export async function raiseWithdrawalErasure(subjectId, projectId) {
  const request = await createRequest({
    subjectId,
    projectId,
    type: 'WITHDRAWAL_ERASURE',
    channel: 'INTERNAL',
    autoRaised: true,
    description: `Automatic erasure raised by consent withdrawal on project ${projectId}`,
  })
  logger.info({ subjectId, projectId, dsarRequestId: request.id }, 'withdrawal erasure raised')
  return request
}

// ---------------------------------------------------------------------------
// Vault-wide evidence listing
// ---------------------------------------------------------------------------
// EvidenceVault.jsx could only show evidence once a specific DSAR had been
// picked, which is the wrong way round for an auditor: the question is "show me
// every export package issued this month", not "show me request X".
//
// `payload` is never returned. It holds the download tokenHash for an
// EXPORT_PACKAGE row and discovery internals for others — a vault index needs
// the content hash, which is the tamper-evidence, and nothing else.
export async function listEvidenceVault(actor, { kind, dsarRequestId, limit = 100 } = {}) {
  const role = actor.admin?.role
  if (!['dpo', 'dataOwner', 'dataAdmin', 'super_admin'].includes(role)) {
    throw new ApiError(403, 'Not authorized to read the evidence vault')
  }

  const rows = await prisma.dsarEvidence.findMany({
    where: {
      ...(kind ? { kind } : {}),
      ...(dsarRequestId ? { dsarRequestId } : {}),
      // A data owner sees evidence only for the requests routed to them, matching
      // listQueue. Otherwise the vault is a way around that scope.
      ...(role === 'dataOwner' ? { request: { assignedAdminId: actor.admin.id } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      dsarRequestId: true,
      kind: true,
      label: true,
      contentHash: true,
      storagePath: true,
      createdByAdminId: true,
      createdAt: true,
      request: { select: { type: true, status: true, subjectId: true, projectId: true } },
    },
  })

  return rows.map(({ storagePath, request, ...e }) => ({
    ...e,
    // Presence, not location. A storage path in an API response is a map of the
    // media store handed to whoever can read the vault.
    hasFile: Boolean(storagePath),
    requestType: request.type,
    requestStatus: request.status,
    projectId: request.projectId,
    subjectRef: pseudonymise(request.subjectId),
  }))
}

// ---------------------------------------------------------------------------
// Break-glass targeting
// ---------------------------------------------------------------------------
// requireBreakGlass needs a sessionId and photoId, and dataAdmin had no route
// that could produce either — in practice they were copied out of a discovery
// response, which is only populated after discovery has run. This lists the
// frames the request's own subject is linked to, and nothing else: it is scoped
// by the DSAR, so it cannot be used to browse the corpus.
export async function listSubjectMedia(requestId, admin) {
  if (!['dataAdmin', 'dpo', 'super_admin'].includes(admin?.role)) {
    throw new ApiError(403, 'Not authorized to enumerate media for a request')
  }

  const request = await prisma.dsarRequest.findUnique({
    where: { id: requestId },
    select: { id: true, subjectId: true, status: true, type: true },
  })
  if (!request) throw new ApiError(404, 'DSAR request not found')

  const links = await prisma.photoSubject.findMany({
    where: { subjectId: request.subjectId },
    orderBy: { createdAt: 'desc' },
    select: {
      photo: {
        select: {
          id: true,
          sessionId: true,
          piiStatus: true,
          redactedPath: true,
          takenAt: true,
          createdAt: true,
          session: { select: { code: true, status: true, project: { select: { id: true, name: true } } } },
          // How many principals are on the frame. An operator about to break
          // glass on a photo shared with three other people should be able to
          // see that before they justify it.
          _count: { select: { subjects: true } },
        },
      },
    },
  })

  return {
    requestId: request.id,
    subjectRef: pseudonymise(request.subjectId),
    items: links.map(({ photo }) => ({
      photoId: photo.id,
      sessionId: photo.sessionId,
      sessionCode: photo.session.code,
      sessionStatus: photo.session.status,
      project: photo.session.project,
      takenAt: photo.takenAt ?? photo.createdAt,
      subjectsOnPhoto: photo._count.subjects,
      redactedAvailable: isResolved(photo),
    })),
  }
}
