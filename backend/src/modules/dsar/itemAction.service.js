import { randomUUID } from 'node:crypto'
import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { logger } from '../../lib/logger.js'
import { enqueueRedaction } from '../../lib/redactionQueue.js'
import { enqueueItemAction } from '../../lib/itemActionQueue.js'
import { createPurgeJob, executePurgeJob } from './purge.service.js'
import { markItemDeleted } from './itemIndex.service.js'

// The action surface. The highest-risk file in the DSAR module, because one of
// the three verbs it exposes is irreversible.
//
// Four properties it exists to guarantee:
//
//   1. NOTHING HAPPENS THAT WAS NOT RECORDED FIRST. Every action is a
//      DsarItemAction row written before any side effect. An action with no row
//      is an action with no audit trail, and auditability is the product.
//   2. A DELETE NEVER DESTROYS ANOTHER PRINCIPAL'S DATA. An item shared with
//      other people is downgraded to a REDACT, server-side, from the index's own
//      sharedSubjectCount — never from a flag the client sent. The downgrade is
//      recorded as a SKIPPED delete PLUS a REDACT, never as a silent no-op: an
//      operator who asked for a deletion is owed the news that they did not get
//      one.
//   3. "SELECT ALL" IS RESOLVED ON THE SERVER. A client-supplied id list for a
//      bulk action is a list of ids a client chose. Filter-based selection is
//      re-run against the index inside this module, under the request's own
//      subject, and capped.
//   4. IDEMPOTENT. (dsarRequestId, itemId, kind) is unique, so a double-submitted
//      batch collapses onto the rows the first submission created rather than
//      queuing a second delete of the same object.

// Ceiling on one batch. Not a performance number — it is the blast radius of a
// single mis-click, and it is deliberately small enough that an operator
// deleting everything for a subject has to mean it more than once.
export const MAX_BATCH = Number(process.env.DSAR_ITEM_ACTION_MAX_BATCH ?? 500)

const ACTION_ROLES = ['dataAdmin', 'super_admin']
const READ_ROLES = ['dataAdmin', 'dpo', 'super_admin']

// Actions mutate a principal's data on the strength of an open request. Outside
// these three states there is no live obligation being worked: RECEIVED/TRIAGE
// have not established what is held, and CLOSED/REJECTED are finished.
const ACTIONABLE_STATUSES = ['DISCOVERY', 'EXECUTING', 'REVIEW']

const KINDS = ['REDACT', 'DELETE', 'EXPORT']

function assertRole(admin, roles, what) {
  if (!roles.includes(admin?.role)) throw new ApiError(403, `Not authorized to ${what}`)
}

async function loadRequest(dsarRequestId) {
  const request = await prisma.dsarRequest.findUnique({
    where: { id: dsarRequestId },
    select: { id: true, subjectId: true, status: true, type: true },
  })
  if (!request) throw new ApiError(404, 'DSAR request not found')
  return request
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Resolves what the operator selected into item rows, always scoped to the
 * request's own subject.
 *
 * The subject scope is the important part and it is not negotiable: an id list
 * naming another principal's items would otherwise let a handler working request
 * A delete data belonging to B, with A's paperwork as cover.
 */
async function resolveSelection(request, { itemIds = null, filter = null }) {
  if (Array.isArray(itemIds) && itemIds.length > 0) {
    const rows = await prisma.subjectDataItem.findMany({
      where: { id: { in: itemIds }, subjectId: request.subjectId },
    })
    const found = new Set(rows.map((r) => r.id))
    const foreign = itemIds.filter((id) => !found.has(id))
    if (foreign.length > 0) {
      // 403, not 404. "Not found" would confirm nothing; naming ids that do not
      // belong to this request's subject is an authorization failure and is
      // worth a distinct status in the logs.
      throw new ApiError(
        403,
        `${foreign.length} selected item(s) do not belong to this request's data principal`,
      )
    }
    return rows
  }

  if (filter) {
    const { type, origin, projectId, from, to } = filter
    return prisma.subjectDataItem.findMany({
      where: {
        subjectId: request.subjectId,
        // Filter-based selection never reaches tombstones. "Select all matching"
        // must not re-delete items that are already gone.
        deletedAt: null,
        ...(type ? { type } : {}),
        ...(origin ? { origin } : {}),
        ...(projectId ? { projectId } : {}),
        ...(from || to
          ? { capturedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
          : {}),
      },
      orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }],
      // One over the ceiling so an over-large selection is detectable rather than
      // silently truncated to exactly MAX_BATCH.
      take: MAX_BATCH + 1,
    })
  }

  throw new ApiError(400, 'An action requires either itemIds or a filter')
}

/**
 * Decides what each selected item actually gets, before anything is written.
 *
 * Returns one entry per intended row. A DELETE on a shared frame produces two:
 * the refused delete and the redaction that replaces it.
 */
function planActions(items, kind, reason) {
  const planned = []
  const summary = { requested: items.length, delete: 0, redact: 0, export: 0, downgraded: 0, alreadyDeleted: 0 }

  for (const item of items) {
    if (item.deletedAt) {
      // Already a tombstone. Recorded as SKIPPED rather than dropped: an operator
      // who selected 40 items and got 38 actions deserves to see the other two.
      planned.push({
        item,
        kind,
        status: 'SKIPPED',
        reason: reason ?? null,
        error: 'Item was already deleted; nothing to act on',
      })
      summary.alreadyDeleted += 1
      continue
    }

    if (kind === 'DELETE' && item.sharedSubjectCount > 1) {
      // The rule from PLAN §0 decision 5, enforced here and nowhere else that
      // matters. The frame holds other principals whose copy of it is lawfully
      // held; it is rebuilt with this subject blurred instead of destroyed.
      planned.push({
        item,
        kind: 'DELETE',
        status: 'SKIPPED',
        reason: reason ?? null,
        error: `Refused: ${item.sharedSubjectCount - 1} other data principal(s) appear on this object. Downgraded to REDACT.`,
      })
      planned.push({
        item,
        kind: 'REDACT',
        status: 'REQUESTED',
        reason: `Automatic downgrade from DELETE — object is shared with ${item.sharedSubjectCount - 1} other principal(s)`,
      })
      summary.downgraded += 1
      summary.redact += 1
      continue
    }

    planned.push({ item, kind, status: 'REQUESTED', reason: reason ?? null })
    if (kind === 'DELETE') summary.delete += 1
    if (kind === 'REDACT') summary.redact += 1
    if (kind === 'EXPORT') summary.export += 1
  }

  return { planned, summary }
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Records a batch of per-item actions and hands them to the queue.
 *
 * The rows are written in one transaction and the side effects happen after it
 * commits. That order is load-bearing: a job that starts before its row is
 * visible can complete against a row that does not exist yet, and the retry
 * would then look like a second, unexplained deletion.
 *
 * `inline` runs the executor synchronously instead of enqueuing. It is the same
 * executor either way — two implementations of "delete this item" would
 * eventually disagree, silently.
 */
export async function requestActions(
  { dsarRequestId, itemIds = null, filter = null, kind, reason = null },
  admin,
  { inline = false } = {},
) {
  assertRole(admin, ACTION_ROLES, 'act on the data held for a request')
  if (!KINDS.includes(kind)) throw new ApiError(400, `Unknown action kind ${kind}`)

  const request = await loadRequest(dsarRequestId)
  if (!ACTIONABLE_STATUSES.includes(request.status)) {
    throw new ApiError(
      409,
      `Item actions require the request to be in ${ACTIONABLE_STATUSES.join(', ')} — it is ${request.status}`,
    )
  }
  if (kind === 'DELETE' && (!reason || reason.trim().length < 10)) {
    throw new ApiError(400, 'A deletion requires a written reason of at least 10 characters')
  }

  const items = await resolveSelection(request, { itemIds, filter })
  if (items.length === 0) throw new ApiError(400, 'The selection matched no items')
  if (items.length > MAX_BATCH) {
    throw new ApiError(
      400,
      `The selection matched more than ${MAX_BATCH} items. Narrow the filter and submit in batches — a bulk action is capped so one mis-click cannot reach a whole subject.`,
    )
  }

  const batchId = randomUUID()
  const { planned, summary } = planActions(items, kind, reason)

  await prisma.$transaction(async (tx) => {
    await tx.dsarItemAction.createMany({
      data: planned.map((p) => ({
        dsarRequestId,
        itemId: p.item.id,
        kind: p.kind,
        status: p.status,
        requestedByAdminId: admin.id,
        batchId,
        reason: p.reason,
        error: p.error ?? null,
        completedAt: p.status === 'SKIPPED' ? new Date() : null,
      })),
      // Idempotency, per the unique constraint. A resubmitted batch adds nothing
      // and the caller is handed the rows that already exist.
      skipDuplicates: true,
    })
  })

  // Read back rather than trusting createMany's count: skipDuplicates means the
  // rows that matter may predate this call, and the executor must run against
  // whatever is actually there.
  const rows = await prisma.dsarItemAction.findMany({
    where: {
      dsarRequestId,
      itemId: { in: [...new Set(planned.map((p) => p.item.id))] },
      kind: { in: [...new Set(planned.map((p) => p.kind))] },
    },
  })
  const pending = rows.filter((r) => r.status === 'REQUESTED')

  await writeAuditLog({
    entityType: 'DsarRequest',
    entityId: dsarRequestId,
    action: 'DSAR_ITEM_ACTIONS_REQUESTED',
    actorId: admin.id,
    payload: { batchId, kind, reason, summary, itemIds: items.map((i) => i.id) },
  })

  if (inline) {
    for (const action of pending) await executeAction(action.id)
  } else {
    for (const action of pending) {
      try {
        await enqueueItemAction(action.id)
      } catch (err) {
        // The row survives in REQUESTED, which is exactly what a replay needs, so
        // nothing is lost — but the operator is told, because an action nobody
        // ran while the UI said "queued" is the failure mode this system cannot
        // afford.
        logger.error(
          { alert: 'ITEM_ACTION_ENQUEUE_FAILED', err, actionId: action.id, batchId },
          'could not enqueue a DSAR item action — the row is recorded and replayable',
        )
        throw new ApiError(503, 'The action was recorded but could not be queued. Retry the batch.')
      }
    }
  }

  return {
    batchId,
    summary,
    actions: await prisma.dsarItemAction.findMany({
      where: { batchId },
      orderBy: [{ kind: 'asc' }, { requestedAt: 'asc' }],
    }),
  }
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

async function finish(actionId, status, { error = null, hashBefore = null } = {}) {
  return prisma.dsarItemAction.update({
    where: { id: actionId },
    data: { status, error, hashBefore, completedAt: new Date() },
  })
}

/**
 * Executes one recorded action. Safe to call twice — a terminal row is returned
 * untouched, which is what makes an at-least-once queue safe here.
 */
export async function executeAction(actionId) {
  const action = await prisma.dsarItemAction.findUnique({
    where: { id: actionId },
    include: { item: true, request: { select: { id: true, subjectId: true, type: true } } },
  })
  if (!action) throw new ApiError(404, 'Item action not found')
  if (['DONE', 'SKIPPED', 'FAILED'].includes(action.status)) return action

  await prisma.dsarItemAction.update({ where: { id: actionId }, data: { status: 'RUNNING' } })

  const item = action.item

  try {
    if (action.kind === 'EXPORT') {
      // No side effect by design. The row IS the selection — Phase 6 packages
      // whatever carries a DONE export action for the request.
      return await finish(actionId, 'DONE')
    }

    if (action.kind === 'REDACT') {
      if (item.sourceTable !== 'photo_subjects') {
        // An enrollment selfie has no bystanders to blur and no derivative to
        // rebuild. Refusing is honest; pretending to redact it would not be.
        return await finish(actionId, 'SKIPPED', {
          error: `Nothing to redact for a ${item.origin} item — redaction applies to session frames`,
        })
      }
      const link = await prisma.photoSubject.findUnique({
        where: { id: item.sourceId },
        select: { photoId: true, photo: { select: { sessionId: true } } },
      })
      if (!link) {
        return await finish(actionId, 'SKIPPED', { error: 'The source link no longer exists' })
      }
      await enqueueRedaction({ sessionId: link.photo.sessionId, photoId: link.photoId })
      return await finish(actionId, 'DONE')
    }

    // DELETE. Re-checked here rather than trusted from planning time: planning
    // and execution can be minutes apart and another principal could have been
    // tagged onto the frame in between, which changes what may be destroyed.
    const live = await prisma.subjectDataItem.findUnique({ where: { id: item.id } })
    if (!live || live.deletedAt) {
      return await finish(actionId, 'SKIPPED', { error: 'Item was already deleted' })
    }
    if (live.sharedSubjectCount > 1) {
      return await finish(actionId, 'SKIPPED', {
        error: `Refused at execution: ${live.sharedSubjectCount - 1} other data principal(s) appear on this object`,
      })
    }

    const job = await createPurgeJob(action.dsarRequestId, null, {
      items: [live],
      batchId: action.batchId,
    })
    const finished = await executePurgeJob(job.id)

    if (finished.status !== 'COMPLETED') {
      // Left FAILED rather than retried here. The purge job is resumable and its
      // per-location rows say exactly what did not go; a blind retry would
      // re-hash objects that are already gone and report them as missing.
      return await finish(actionId, 'FAILED', {
        error: `Scoped purge ${finished.status}: ${finished.error ?? 'incomplete'}`,
        // The content hash captured before deletion, mirroring PurgeJobLocation.
        hashBefore: live.contentHash,
      })
    }

    await markItemDeleted(item.id)

    await writeAuditLog({
      entityType: 'DsarRequest',
      entityId: action.dsarRequestId,
      action: 'DSAR_ITEM_DELETED',
      actorId: action.requestedByAdminId,
      payload: {
        actionId,
        itemId: item.id,
        purgeJobId: job.id,
        sourceTable: item.sourceTable,
        sourceId: item.sourceId,
        hashBefore: live.contentHash,
      },
    })

    return await finish(actionId, 'DONE', { hashBefore: live.contentHash })
  } catch (err) {
    logger.error({ err, actionId, kind: action.kind, itemId: item.id }, 'DSAR item action failed')
    await finish(actionId, 'FAILED', { error: String(err?.message ?? err) })
    throw err
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Batch progress. Pseudonymous by construction — an action row names an item and
 * a verb, never a person, so the dpo role floor matches the item grid's.
 */
export async function listActions(dsarRequestId, { batchId = null, status = null, limit = 500 } = {}, admin) {
  assertRole(admin, READ_ROLES, 'read the action log for a request')
  await loadRequest(dsarRequestId)

  const rows = await prisma.dsarItemAction.findMany({
    where: {
      dsarRequestId,
      ...(batchId ? { batchId } : {}),
      ...(status ? { status } : {}),
    },
    orderBy: [{ requestedAt: 'desc' }],
    take: Math.min(Math.max(Number(limit) || 500, 1), 1000),
    include: {
      item: {
        select: {
          id: true,
          type: true,
          origin: true,
          projectId: true,
          sessionId: true,
          capturedAt: true,
          sharedSubjectCount: true,
          deletedAt: true,
        },
      },
    },
  })

  const counts = await prisma.dsarItemAction.groupBy({
    by: ['status'],
    where: { dsarRequestId, ...(batchId ? { batchId } : {}) },
    _count: { _all: true },
  })

  return {
    requestId: dsarRequestId,
    batchId,
    items: rows.map((r) => ({
      actionId: r.id,
      itemId: r.itemId,
      kind: r.kind,
      status: r.status,
      batchId: r.batchId,
      reason: r.reason,
      error: r.error,
      hashBefore: r.hashBefore,
      requestedByAdminId: r.requestedByAdminId,
      requestedAt: r.requestedAt,
      completedAt: r.completedAt,
      item: r.item,
    })),
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    // What "can this request be closed" turns on. Computed here so the close
    // guard and the UI cannot disagree about what in-flight means.
    inFlight: (counts.find((c) => c.status === 'REQUESTED')?._count._all ?? 0) +
      (counts.find((c) => c.status === 'RUNNING')?._count._all ?? 0),
  }
}

/** Count of actions that have not reached a terminal state. Used by the close guard. */
export async function countInFlightActions(dsarRequestId) {
  return prisma.dsarItemAction.count({
    where: { dsarRequestId, status: { in: ['REQUESTED', 'RUNNING'] } },
  })
}
