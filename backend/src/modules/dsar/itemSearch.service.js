import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { logger } from '../../lib/logger.js'
import { recordAccess } from '../../lib/accessLog.js'
import { indexSubject } from './itemIndex.service.js'
// dsar.service.js owns the pseudonym format; both surfaces must render the same
// SUB-xxxxxxxx for the same person or an operator cannot correlate two screens.
// Not a cycle — dsar.service.js does not import this module.
import { pseudonymise } from './dsar.service.js'

// "Search a person, get EVERYTHING we hold about them" — the surface that turns
// the Phase 2 projection into an answer a fiduciary can stand behind.
//
// Three properties this file exists to guarantee:
//
//   1. COMPLETENESS IS COUNTED, NOT INFERRED. `totals.all` is a count() over the
//      whole index for the subject, never `items.length`. That number is what an
//      operator reads as "this is all of it", so it must not be a page size.
//   2. IDENTITY MATCHING IS EXACT OR PREFIX, NEVER FUZZY. A fuzzy match on a DSAR
//      search shows one principal another principal's data — a breach, not a bad
//      search result. No `contains`, no trigram, no soundex, ever.
//   3. A DIVERGENT INDEX IS VISIBLE. Phase 2 could swallow an index-refresh
//      failure because nothing read the index. This file reads it, so every
//      listing cross-checks the projection against the source tables, repairs it
//      once, and reports `index.consistent` when it still disagrees.

const SEARCH_LIMIT_MAX = 50
const ITEM_LIMIT_MAX = 200
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Identity search returns names and emails, which §D of the role matrix withholds
// from dpo and dataOwner outright. Item listing is pseudonymous (SUB-xxxxxxxx) and
// follows /dsar/:id/media instead.
const IDENTITY_ROLES = ['dataAdmin', 'super_admin']
const ITEM_ROLES = ['dataAdmin', 'dpo', 'super_admin']

function assertRole(admin, roles, what) {
  if (!roles.includes(admin?.role)) throw new ApiError(403, `Not authorized to ${what}`)
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeCursor(cursor) {
  if (!cursor) return null
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string') throw new Error('shape')
    return parsed
  } catch {
    throw new ApiError(400, 'Malformed cursor')
  }
}

// ---------------------------------------------------------------------------
// Subject identity search
// ---------------------------------------------------------------------------

// email is citext, so `startsWith` there is already case-insensitive; the mode
// flag covers fullName and employeeRef. `startsWith` with the full value is an
// exact match, which is why exact needs no separate branch.
function identityWhere(q) {
  const clauses = [
    { fullName: { startsWith: q, mode: 'insensitive' } },
    { email: { startsWith: q } },
    { employeeRef: { startsWith: q, mode: 'insensitive' } },
  ]
  // An id is matched exactly or not at all — a prefix of a uuid is not evidence
  // about a person.
  if (UUID_RE.test(q)) clauses.push({ masterUserId: q })
  return { OR: clauses }
}

/**
 * Exact + prefix identity search over the subject register.
 *
 * Every returned principal gets an `AccessEvent{action:SEARCH}`: a handler
 * trawling the register for someone is precisely the insider pattern the read
 * log exists to answer for. Zero results write nothing — nobody's data was read.
 */
export async function searchSubjects({ q, limit = 20, cursor = null }, { admin, req = null } = {}) {
  assertRole(admin, IDENTITY_ROLES, 'search the subject register')

  const term = String(q ?? '').trim()
  if (term.length < 2) throw new ApiError(400, 'Search term must be at least 2 characters')

  const take = Math.min(Math.max(Number(limit) || 20, 1), SEARCH_LIMIT_MAX)
  const after = decodeCursor(cursor)

  const where = {
    AND: [
      identityWhere(term),
      after
        ? {
            OR: [
              { fullName: { gt: after.fullName } },
              { fullName: after.fullName, masterUserId: { gt: after.id } },
            ],
          }
        : {},
    ],
  }

  const rows = await prisma.subject.findMany({
    where,
    orderBy: [{ fullName: 'asc' }, { masterUserId: 'asc' }],
    take: take + 1,
    select: {
      masterUserId: true,
      fullName: true,
      email: true,
      employeeRef: true,
      group: true,
      status: true,
      createdAt: true,
    },
  })

  const page = rows.slice(0, take)
  const hasMore = rows.length > take

  // One grouped count instead of a per-row count — the item grid's "N items"
  // badge must not be N+1 queries wide.
  const counts = page.length
    ? await prisma.subjectDataItem.groupBy({
        by: ['subjectId'],
        where: { subjectId: { in: page.map((s) => s.masterUserId) }, deletedAt: null },
        _count: { _all: true },
      })
    : []
  const countBySubject = new Map(counts.map((c) => [c.subjectId, c._count._all]))

  // Fail-closed and sequential: recordAccess throws, and a search whose read log
  // could not be written must not return the people it found.
  for (const s of page) {
    await recordAccess({
      objectType: 'SUBJECT_PII',
      objectId: s.masterUserId,
      action: 'SEARCH',
      purpose: 'DSAR subject search',
      req,
    })
  }

  return {
    items: page.map((s) => ({
      subjectId: s.masterUserId,
      fullName: s.fullName,
      email: s.email,
      employeeRef: s.employeeRef,
      group: s.group,
      status: s.status,
      registeredAt: s.createdAt,
      itemCount: countBySubject.get(s.masterUserId) ?? 0,
    })),
    nextCursor: hasMore
      ? encodeCursor({ fullName: page[page.length - 1].fullName, id: page[page.length - 1].masterUserId })
      : null,
  }
}

// ---------------------------------------------------------------------------
// Per-item listing
// ---------------------------------------------------------------------------

function itemWhere({ subjectId, type, origin, projectId, from, to, includeDeleted }) {
  return {
    subjectId,
    ...(includeDeleted ? {} : { deletedAt: null }),
    ...(type ? { type } : {}),
    ...(origin ? { origin } : {}),
    ...(projectId ? { projectId } : {}),
    ...(from || to
      ? { capturedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
      : {}),
  }
}

// Keyset over (capturedAt DESC NULLS LAST, id DESC). Rows with a null capturedAt
// sort after every dated row, so once the cursor is in that tail the walk stays
// there; before it, the tail is still reachable via the third disjunct.
function afterCursor(after) {
  if (!after) return {}
  if (after.capturedAt === null) return { capturedAt: null, id: { lt: after.id } }
  const at = new Date(after.capturedAt)
  return {
    OR: [{ capturedAt: { lt: at } }, { capturedAt: at, id: { lt: after.id } }, { capturedAt: null }],
  }
}

function shapeItem(row) {
  return {
    itemId: row.id,
    type: row.type,
    origin: row.origin,
    sourceTable: row.sourceTable,
    sourceId: row.sourceId,
    projectId: row.projectId,
    sessionId: row.sessionId,
    capturedAt: row.capturedAt,
    contentHash: row.contentHash,
    // >1 means other principals are on the frame, so Phase 5 downgrades a DELETE
    // here to a REDACT. Surfaced so the UI can say so BEFORE the operator clicks.
    sharedSubjectCount: row.sharedSubjectCount,
    shared: row.sharedSubjectCount > 1,
    redactedAvailable: row.redactedAvailable,
    deletedAt: row.deletedAt,
    // Import items carry no capture-time consent. Never hidden: an unverified
    // lawful basis is a finding, not a footnote.
    lawfulBasis: row.meta?.lawfulBasis ?? null,
    // Audio rows are a time range with speakers, not a frame, and the grid has
    // to be able to say which it is looking at. Null on PHOTO rows. All four are
    // derived from AudioSegment counts — no transcript, no name, no storagePath,
    // so the endpoint stays pseudonymous by construction (matrix §D).
    durationSec: row.meta?.durationSec ?? null,
    audibleSeconds: row.meta?.audibleSeconds ?? null,
    segmentCount: row.meta?.segments ?? null,
    recordingStatus: row.meta?.recordingStatus ?? null,
    indexedAt: row.indexedAt,
  }
}

/**
 * How many items the SOURCE tables say this subject has, using the same rules
 * `indexSubject()` walks with: every photo link, every recording the subject is
 * audible in, plus face and voice enrollments that are not soft-deleted.
 *
 * This MUST enumerate exactly what `indexSubject()` writes a live row for. A
 * source missing here is not a harmless omission: `verifyIndex()` reads the
 * shortfall as a diverged index, rebuilds on every single listing, and then logs
 * ITEM_INDEX_INCOMPLETE against an index that was right all along — which trains
 * the operator to ignore the one alert that says the completeness claim is
 * unsound. Recordings were missing here until voice enrollments were added and
 * made the same mistake visible.
 */
async function sourceLiveCount(subjectId) {
  const [links, enrollments, voiceEnrollments, recordings] = await Promise.all([
    prisma.photoSubject.count({ where: { subjectId } }),
    prisma.subjectFaceEnrollment.count({ where: { subjectId, deletedAt: null } }),
    prisma.subjectVoiceEnrollment.count({ where: { subjectId, deletedAt: null } }),
    // One item per (subject, recording), matching recordingItem's granularity —
    // not one per segment.
    prisma.recording.count({ where: { segments: { some: { subjectId } } } }),
  ])
  return links + enrollments + voiceEnrollments + recordings
}

/**
 * Cross-checks the projection against the source tables and repairs it once.
 *
 * Phase 2 deliberately swallowed index-refresh failures because nothing read the
 * index. Phase 4 serves the completeness claim from it, so a divergence must
 * either be fixed or reported — never silently served as if it were the truth.
 */
async function verifyIndex(subjectId) {
  const expected = await sourceLiveCount(subjectId)
  let indexed = await prisma.subjectDataItem.count({ where: { subjectId, deletedAt: null } })
  let repaired = false

  if (indexed !== expected) {
    logger.warn(
      { alert: 'ITEM_INDEX_DIVERGED', subjectId, expected, indexed },
      'item index disagrees with the source tables — rebuilding before serving',
    )
    try {
      await indexSubject(subjectId)
      indexed = await prisma.subjectDataItem.count({ where: { subjectId, deletedAt: null } })
      repaired = true
    } catch (err) {
      logger.error(
        { alert: 'ITEM_INDEX_REPAIR_FAILED', err, subjectId },
        'item index rebuild failed while serving a DSAR item listing',
      )
    }
  }

  const consistent = indexed === expected
  if (!consistent) {
    logger.error(
      { alert: 'ITEM_INDEX_INCOMPLETE', subjectId, expected, indexed },
      'serving a DSAR item listing from an index that does not match the source tables',
    )
  }
  return { expected, indexed, consistent, repaired }
}

/**
 * One page of a subject's items plus the counts that make the page meaningful.
 *
 * `totals.all` ignores the filters on purpose. It is the completeness claim —
 * "this person has N items with us" — and a filtered page that reported its own
 * filtered total would let a narrowed view read as a complete one.
 */
export async function listSubjectItems({
  subjectId,
  type = null,
  origin = null,
  projectId = null,
  from = null,
  to = null,
  includeDeleted = false,
  cursor = null,
  limit = 50,
} = {}) {
  const take = Math.min(Math.max(Number(limit) || 50, 1), ITEM_LIMIT_MAX)
  const after = decodeCursor(cursor)
  const filters = { subjectId, type, origin, projectId, from, to, includeDeleted }

  const index = await verifyIndex(subjectId)

  const rows = await prisma.subjectDataItem.findMany({
    where: { AND: [itemWhere(filters), afterCursor(after)] },
    orderBy: [{ capturedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
    take: take + 1,
  })

  const page = rows.slice(0, take)
  const hasMore = rows.length > take

  const [matching, all, deleted, byTypeRows, byOriginRows] = await Promise.all([
    prisma.subjectDataItem.count({ where: itemWhere(filters) }),
    prisma.subjectDataItem.count({ where: { subjectId, deletedAt: null } }),
    prisma.subjectDataItem.count({ where: { subjectId, deletedAt: { not: null } } }),
    prisma.subjectDataItem.groupBy({
      by: ['type'],
      where: { subjectId, deletedAt: null },
      _count: { _all: true },
    }),
    prisma.subjectDataItem.groupBy({
      by: ['origin'],
      where: { subjectId, deletedAt: null },
      _count: { _all: true },
    }),
  ])

  return {
    items: page.map(shapeItem),
    nextCursor: hasMore
      ? encodeCursor({ capturedAt: page[page.length - 1].capturedAt, id: page[page.length - 1].id })
      : null,
    totals: {
      all,
      matching,
      deleted,
      byType: Object.fromEntries(byTypeRows.map((r) => [r.type, r._count._all])),
      byOrigin: Object.fromEntries(byOriginRows.map((r) => [r.origin, r._count._all])),
    },
    index,
  }
}

/**
 * Route-level entry point: resolve the request, log the read, list the items.
 *
 * Pseudonymous like `listSubjectMedia()` — the item grid names frames, never
 * people, so a dpo can work a request without ever seeing whose it is.
 */
export async function listItemsForRequest(requestId, admin, query = {}, { req = null } = {}) {
  assertRole(admin, ITEM_ROLES, 'enumerate the data held for a request')

  const request = await prisma.dsarRequest.findUnique({
    where: { id: requestId },
    select: { id: true, subjectId: true, status: true, type: true },
  })
  if (!request) throw new ApiError(404, 'DSAR request not found')

  await recordAccess({
    objectType: 'SUBJECT_DATA_ITEM',
    objectId: request.subjectId,
    action: 'SEARCH',
    purpose: 'DSAR item enumeration',
    dsarRequestId: request.id,
    req,
  })

  const result = await listSubjectItems({ ...query, subjectId: request.subjectId })

  return {
    requestId: request.id,
    requestStatus: request.status,
    requestType: request.type,
    subjectRef: pseudonymise(request.subjectId),
    ...result,
  }
}
