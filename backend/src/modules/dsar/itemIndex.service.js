import { prisma } from '../../config/prisma.js'

// The item index (`subject_data_items`) is a PROJECTION, never an authority.
// `PhotoSubject` / `Photo` / `SubjectFaceEnrollment` remain the source of truth;
// this table exists so "everything we hold about this person" is one paged,
// filterable, countable query instead of a walk. Every write here is an
// idempotent upsert keyed on (subjectId, type, sourceTable, sourceId), so the
// index can be thrown away and rebuilt at any time — which is the whole reason
// it is safe to keep a second copy of erasure-critical bookkeeping.
//
// Two rules the rest of the system depends on:
//   * a row is never hard-deleted here. When the source row disappears the item
//     is tombstoned (`deletedAt`), because a DSAR timeline has to be able to
//     prove an item existed and was destroyed.
//   * `sharedSubjectCount` counts every principal on the frame, including this
//     one. >1 is what downgrades a DELETE to a REDACT server-side.

export const SOURCE = {
  PHOTO_SUBJECT: 'photo_subjects',
  ENROLLMENT: 'subject_face_enrollments',
}

// Source tables this walk owns. The tombstone sweep is scoped to them so a
// future indexer for another source cannot delete rows it never looked at.
const WALKED_SOURCES = [SOURCE.PHOTO_SUBJECT, SOURCE.ENROLLMENT]

const WRITE_CHUNK = 20

const PHOTO_LINK_SELECT = {
  id: true,
  photoId: true,
  subjectId: true,
  consentId: true,
  // The only route back to a project for an IMPORT link: there is no session to
  // read one off. Without it a rebuild would null the projectId an import wrote,
  // and the item would fall out of every project-filtered view of the subject's
  // data — silently narrowing a completeness claim.
  consent: { select: { projectId: true } },
  photo: {
    select: {
      id: true,
      sessionId: true,
      storagePath: true,
      redactedPath: true,
      piiStatus: true,
      sha256: true,
      takenAt: true,
      createdAt: true,
      session: { select: { projectId: true } },
      subjects: { select: { id: true, subjectId: true } },
    },
  },
}

/**
 * Same rule `listSubjectMedia()` uses. A derivative whose PII mask was never
 * confirmed is not "available" — serving it is the reportable failure mode, so
 * DEFERRED/FAILED counts as no redacted copy at all.
 */
export function isRedactedAvailable(photo) {
  return Boolean(photo.redactedPath) && !['DEFERRED', 'FAILED'].includes(photo.piiStatus)
}

function photoItem(link) {
  const photo = link.photo
  return {
    subjectId: link.subjectId,
    type: 'PHOTO',
    origin: 'COLLECTION_SESSION',
    sourceTable: SOURCE.PHOTO_SUBJECT,
    sourceId: link.id,
    projectId: photo.session?.projectId ?? link.consent?.projectId ?? null,
    sessionId: photo.sessionId,
    storagePath: photo.storagePath,
    contentHash: photo.sha256,
    capturedAt: photo.takenAt ?? photo.createdAt,
    sharedSubjectCount: photo.subjects.length,
    redactedAvailable: isRedactedAvailable(photo),
  }
}

function enrollmentItem(enrollment) {
  return {
    subjectId: enrollment.subjectId,
    type: 'PHOTO',
    origin: 'ENROLLMENT',
    sourceTable: SOURCE.ENROLLMENT,
    sourceId: enrollment.id,
    projectId: null,
    sessionId: null,
    storagePath: enrollment.imagePath,
    contentHash: enrollment.sha256,
    capturedAt: enrollment.createdAt,
    // A selfie is of exactly one person by construction, so it is always solely
    // this subject's and always deletable.
    sharedSubjectCount: 1,
    redactedAvailable: false,
  }
}

/**
 * Idempotent write of one item.
 *
 * `origin` and `meta` are set on create and never on update, deliberately: an
 * IMPORT-origin photo (Phase 3) also carries a real `PhotoSubject` row, so this
 * walk sees it too and would otherwise relabel it COLLECTION_SESSION and wipe
 * its `meta.lawfulBasis` on the next rebuild.
 */
async function writeItem(item, { at, deletedAt = null }, client = prisma) {
  const { subjectId, type, sourceTable, sourceId, origin, ...fields } = item
  return client.subjectDataItem.upsert({
    where: { subjectId_type_sourceTable_sourceId: { subjectId, type, sourceTable, sourceId } },
    create: { subjectId, type, sourceTable, sourceId, origin, ...fields, deletedAt, indexedAt: at },
    update: { ...fields, deletedAt, indexedAt: at },
  })
}

async function writeAll(entries, at, client = prisma) {
  for (let i = 0; i < entries.length; i += WRITE_CHUNK) {
    const chunk = entries.slice(i, i + WRITE_CHUNK)
    await Promise.all(chunk.map(({ item, deletedAt }) => writeItem(item, { at, deletedAt }, client)))
  }
}

/**
 * Rebuilds the whole index for one subject from the source tables.
 *
 * Idempotent: running it twice changes no row count. Anything the walk did not
 * touch this pass is a source row that no longer exists, and is tombstoned
 * rather than removed.
 *
 * `at` is a single JS timestamp used for every row written in the pass and as
 * the sweep boundary — taking it from the DB clock instead would make the sweep
 * depend on app-vs-DB clock skew and could tombstone rows written seconds ago.
 */
export async function indexSubject(subjectId, { at = new Date() } = {}) {
  const [links, enrollments] = await Promise.all([
    prisma.photoSubject.findMany({ where: { subjectId }, select: PHOTO_LINK_SELECT }),
    prisma.subjectFaceEnrollment.findMany({
      where: { subjectId },
      select: { id: true, subjectId: true, imagePath: true, sha256: true, createdAt: true, deletedAt: true },
    }),
  ])

  const entries = [
    ...links.map((link) => ({ item: photoItem(link), deletedAt: null })),
    // A soft-deleted enrollment is already gone as far as the principal is
    // concerned; it enters the index as a tombstone rather than as live data.
    ...enrollments.map((e) => ({ item: enrollmentItem(e), deletedAt: e.deletedAt ?? null })),
  ]

  await writeAll(entries, at)

  const { count: tombstoned } = await prisma.subjectDataItem.updateMany({
    where: {
      subjectId,
      deletedAt: null,
      sourceTable: { in: WALKED_SOURCES },
      indexedAt: { lt: at },
    },
    data: { deletedAt: at },
  })

  return {
    subjectId,
    indexed: entries.length,
    live: entries.filter((e) => !e.deletedAt).length,
    tombstoned,
  }
}

/**
 * Incremental path: one photo↔subject link was just written.
 *
 * Also refreshes `sharedSubjectCount` on every other principal's item for the
 * same frame — tagging a second person onto a photo changes what the FIRST
 * person is allowed to have deleted, and that guard is only as good as this
 * number.
 */
export async function indexPhotoSubject(link, { at = new Date() } = {}) {
  const id = typeof link === 'string' ? link : link?.id
  if (!id) throw new TypeError('indexPhotoSubject requires a PhotoSubject row or id')

  const row = await prisma.photoSubject.findUnique({ where: { id }, select: PHOTO_LINK_SELECT })
  // The link was deleted between the write and this call (revocation races
  // finalize). Nothing to index; the next indexSubject() tombstones it.
  if (!row) return null

  const written = await writeItem(photoItem(row), { at }, prisma)

  const siblings = row.photo.subjects.filter((s) => s.id !== row.id).map((s) => s.id)
  if (siblings.length > 0) {
    await prisma.subjectDataItem.updateMany({
      where: { sourceTable: SOURCE.PHOTO_SUBJECT, sourceId: { in: siblings }, deletedAt: null },
      data: { sharedSubjectCount: row.photo.subjects.length },
    })
  }

  return written
}

/** Bulk incremental path — one finalize writes many links at once. */
export async function indexPhotoSubjects(links, { at = new Date() } = {}) {
  let indexed = 0
  for (const link of links) {
    const written = await indexPhotoSubject(link, { at })
    if (written) indexed += 1
  }
  return { indexed, requested: links.length }
}

/**
 * Tombstone one item. Not a delete: the row is the proof the item existed and
 * was acted on. Re-tombstoning is a no-op, so an at-least-once worker is safe.
 */
export async function markItemDeleted(itemId, { at = new Date() } = {}) {
  const item = await prisma.subjectDataItem.findUnique({ where: { id: itemId } })
  if (!item) return null
  if (item.deletedAt) return item
  return prisma.subjectDataItem.update({ where: { id: itemId }, data: { deletedAt: at } })
}

/**
 * Full backfill. Keyset-paginated over subjects so a 10k-subject database never
 * loads more than one batch, and resumable from any subject id.
 */
export async function rebuildAll({ batchSize = 100, after = null, onSubject = null } = {}) {
  let cursor = after
  const totals = { subjects: 0, indexed: 0, live: 0, tombstoned: 0, lastSubjectId: cursor }

  for (;;) {
    const subjects = await prisma.subject.findMany({
      where: cursor ? { masterUserId: { gt: cursor } } : undefined,
      orderBy: { masterUserId: 'asc' },
      take: batchSize,
      select: { masterUserId: true },
    })
    if (subjects.length === 0) break

    for (const { masterUserId } of subjects) {
      const result = await indexSubject(masterUserId)
      totals.subjects += 1
      totals.indexed += result.indexed
      totals.live += result.live
      totals.tombstoned += result.tombstoned
      totals.lastSubjectId = masterUserId
      cursor = masterUserId
      if (onSubject) await onSubject(result)
    }
  }

  return totals
}
