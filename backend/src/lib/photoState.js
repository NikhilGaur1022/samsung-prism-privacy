// One definition of "this photo is not finished with redaction yet".
//
// Nine separate places used to answer this question, and eight of them answered
// it by listing the states they considered bad:
//
//     piiStatus: { in: ['DEFERRED', 'FAILED'] }
//
// PENDING is the schema default. It is the state every photo starts in and the
// state a photo is left in when redaction never ran at all — which is the actual
// failure this system suffers from. It was in none of those lists. The live
// database held 0 DEFERRED, 0 FAILED and 27 PENDING, so every "needs attention"
// count in the product was reporting zero while a two-week-old unredacted frame
// sat in an archived session.
//
// The fix is to invert the test. Enumerate the states that ARE finished, and
// treat everything else as unfinished. A new enum value then fails safe: it
// shows up as needing attention until someone deliberately adds it to the
// terminal list, instead of silently disappearing from every dashboard.
//
// tests/unit/photoState.test.js asserts the inversion holds for every value of
// the PiiStatus enum, and tests/contract/no-enumerated-pii-states.test.js greps
// the source for the old form so it cannot come back.

/**
 * The states in which redaction is genuinely done with a photo.
 *
 *   CLEAN  — nothing needed masking.
 *   MASKED — something did, and a redacted derivative was written.
 *
 * DEFERRED and FAILED are not terminal: they are "we could not do this now",
 * and both must be retried. PENDING is not terminal either — it means redaction
 * has not run.
 */
export const TERMINAL_PII_STATUSES = Object.freeze(['CLEAN', 'MASKED'])

/**
 * A Prisma `where` fragment selecting photos that still need redaction work.
 *
 * `redactedPath: null` is part of the test, not decoration: a photo can carry a
 * terminal status while its derivative was never written (the finalize path
 * committed the status before the file landed), and a photo in that state must
 * never enter an export or a handoff.
 */
export const UNRESOLVED_PHOTO_WHERE = Object.freeze({
  OR: [{ piiStatus: { notIn: TERMINAL_PII_STATUSES } }, { redactedPath: null }],
})

/** The complement — safe to hand off, export, or serve as a derivative. */
export const RESOLVED_PHOTO_WHERE = Object.freeze({
  piiStatus: { in: TERMINAL_PII_STATUSES },
  redactedPath: { not: null },
})

/**
 * In-memory form, for code that already holds the row.
 * Accepts anything with `piiStatus` and `redactedPath`.
 */
export function isUnresolved(photo) {
  if (!photo) return true
  if (!TERMINAL_PII_STATUSES.includes(photo.piiStatus)) return true
  if (!photo.redactedPath) return true
  return false
}

export function isResolved(photo) {
  return !isUnresolved(photo)
}

/**
 * Counts unresolved photos for a set of sessions in one grouped query.
 *
 * Every dashboard that wants "how many frames still need attention" goes through
 * here rather than writing its own predicate — which is the whole point of the
 * module. Returns a Map of sessionId → count, with absent sessions meaning zero.
 */
export async function countUnresolvedBySession(prisma, sessionIds) {
  if (!sessionIds?.length) return new Map()

  const rows = await prisma.photo.groupBy({
    by: ['sessionId'],
    where: { sessionId: { in: sessionIds }, ...UNRESOLVED_PHOTO_WHERE },
    _count: { _all: true },
  })

  return new Map(rows.map((r) => [r.sessionId, r._count._all]))
}

/**
 * Throws unless every photo in the session is finished.
 *
 * The single gate used by finalize, handoff and export — three paths that each
 * had their own near-miss version of this check. The error names the frames, so
 * an operator has something to act on instead of a count.
 */
export async function assertAllPhotosResolved(prisma, sessionId, { limit = 25 } = {}) {
  const unresolved = await prisma.photo.findMany({
    where: { sessionId, ...UNRESOLVED_PHOTO_WHERE },
    select: { id: true, piiStatus: true, redactedPath: true },
    take: limit + 1,
  })

  if (unresolved.length === 0) return { resolved: true, count: 0 }

  const total = await prisma.photo.count({
    where: { sessionId, ...UNRESOLVED_PHOTO_WHERE },
  })

  return {
    resolved: false,
    count: total,
    sample: unresolved.slice(0, limit).map((p) => ({
      id: p.id,
      piiStatus: p.piiStatus,
      hasDerivative: Boolean(p.redactedPath),
    })),
  }
}

// ---------------------------------------------------------------------------
/**
 * How many frames in a `groupBy piiStatus` tally are NOT finished.
 *
 * The reporting counterpart to `isUnresolved`. Written as the inverse for the
 * same reason: the additive spelling — `(PENDING ?? 0) + (DEFERRED ?? 0) +
 * (FAILED ?? 0)` — has to be edited every time the enum grows, and until
 * somebody remembers to, a whole state is missing from every dashboard that
 * decides whether a project can hand anything off.
 *
 * @param {Record<string, number>|null|undefined} piiStatusCounts
 * @returns {number}
 */
export function countBlockedFrames(piiStatusCounts) {
  if (!piiStatusCounts) return 0
  let total = 0
  for (const [status, count] of Object.entries(piiStatusCounts)) {
    if (!TERMINAL_PII_STATUSES.includes(status)) total += count ?? 0
  }
  return total
}

// Video and audio derivatives
// ---------------------------------------------------------------------------
// Same inversion, different enums. A VideoAsset carries two independent state
// columns — VideoStatus (has the clip been through the redactor) and PiiStatus
// (did the mask confirm) — and a Recording carries RecordingStatus. Both are
// only "finished" in exactly one combination, so both are written as that
// combination rather than as a list of the failures.

/** The only VideoStatus that means a masked derivative exists. */
export const TERMINAL_VIDEO_STATUS = 'REDACTED'

export function isVideoUnresolved(video) {
  if (!video) return true
  if (video.status !== TERMINAL_VIDEO_STATUS) return true
  if (!video.redactedPath) return true
  if (!TERMINAL_PII_STATUSES.includes(video.piiStatus)) return true
  return false
}

export const UNRESOLVED_VIDEO_WHERE = Object.freeze({
  NOT: {
    AND: [
      { status: TERMINAL_VIDEO_STATUS },
      { redactedPath: { not: null } },
      { piiStatus: { in: TERMINAL_PII_STATUSES } },
    ],
  },
})

/** The only RecordingStatus that means a muted derivative exists. */
export const TERMINAL_RECORDING_STATUS = 'REDACTED'

export function isRecordingUnresolved(recording) {
  if (!recording) return true
  if (recording.status !== TERMINAL_RECORDING_STATUS) return true
  if (!recording.redactedPath) return true
  return false
}

export const UNRESOLVED_RECORDING_WHERE = Object.freeze({
  NOT: { AND: [{ status: TERMINAL_RECORDING_STATUS }, { redactedPath: { not: null } }] },
})
