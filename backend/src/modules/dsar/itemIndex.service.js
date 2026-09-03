import { Prisma } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { isResolved } from '../../lib/photoState.js'

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
  // One item per (subject, recording), NOT per segment. A person audible in a
  // ten-minute conversation is one thing we hold about them, not forty; the
  // individual utterances are how it gets redacted, not what gets listed.
  RECORDING: 'recordings',
  VOICE_ENROLLMENT: 'subject_voice_enrollments',
  // One item per (subject, clip), keyed on the consent LINK rather than on the
  // clip — the same shape as PHOTO_SUBJECT, and for the same reason: the link is
  // what makes holding this person's face lawful, and it is what erasure
  // deletes. Keying on the clip would leave the item pointing at a row that
  // legitimately survives for the other people in it.
  VIDEO_SUBJECT: 'video_subjects',
}

// Source tables this walk owns. The tombstone sweep is scoped to them so a
// future indexer for another source cannot delete rows it never looked at.
const WALKED_SOURCES = [
  SOURCE.PHOTO_SUBJECT,
  SOURCE.ENROLLMENT,
  SOURCE.RECORDING,
  SOURCE.VOICE_ENROLLMENT,
  SOURCE.VIDEO_SUBJECT,
]

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

const RECORDING_SELECT = {
  id: true,
  sessionId: true,
  storagePath: true,
  redactedPath: true,
  status: true,
  sha256: true,
  durationSec: true,
  createdAt: true,
  session: { select: { projectId: true } },
  segments: {
    select: { id: true, subjectId: true, consentId: true, startSec: true, endSec: true, action: true },
  },
}

/**
 * How many distinct identified people are on a recording. Unidentified speaker
 * slots are deliberately NOT counted: an unmatched voice is not evidence that a
 * second consenting principal is present, and inflating this number would
 * downgrade a lawful DELETE to a REDACT and leave data the principal asked us to
 * destroy. Erring the other way — counting a real second speaker as absent —
 * is prevented by the analysis step writing a subjectId for every match.
 */
function distinctSpeakers(segments) {
  return new Set(segments.map((s) => s.subjectId).filter(Boolean)).size
}

/**
 * Same rule `listSubjectMedia()` uses. A derivative whose PII mask was never
 * confirmed is not "available" — serving it is the reportable failure mode.
 *
 * Delegates to lib/photoState.js rather than restating the rule: the previous
 * inline form enumerated DEFERRED and FAILED and so treated a PENDING photo,
 * whose redaction never ran at all, as available.
 */
/**
 * The lawful basis for holding one link, in the shape the item grid reads.
 *
 * `recordingItem` has asserted this since audio shipped; the photo and video
 * forms never did, so every captured frame and clip rendered a blank basis in
 * the DSAR item grid while the audio row beside it said "Consent" — thirteen of
 * sixteen items blank on a subject whose PhotoSubject rows all carried a
 * consentId. An operator reading "on what basis do we hold this" got no answer
 * for the two largest item classes.
 *
 * Returned as `createMeta`, not `meta`, and the distinction is load-bearing.
 * `writeItem` refreshes `meta` on every rebuild; the import path asserts its own
 * `IMPORT_UNVERIFIED` / `PROJECT_CONSENT` once at ingest and must survive one.
 * See the note on writeItem.
 */
function lawfulBasisMeta(consentId) {
  return { lawfulBasis: consentId ? 'CONSENT' : 'UNVERIFIED' }
}

export function isRedactedAvailable(photo) {
  return isResolved(photo)
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
    createMeta: lawfulBasisMeta(link.consentId),
  }
}

/**
 * Same fail-closed rule as `isRedactedAvailable`. A recording whose analysis
 * never completed (DEFERRED) has no trustworthy muted derivative, so it counts
 * as having none — serving it would release voices the consent gate never
 * cleared.
 */
export function isRecordingRedactedAvailable(recording) {
  return Boolean(recording.redactedPath) && recording.status === 'REDACTED'
}

/**
 * One index row per subject per recording.
 *
 * `segments` are this subject's segments only; `speakerCount` is the number of
 * DISTINCT identified subjects across the whole recording, which is the audio
 * analogue of `photo.subjects.length` and drives the same server-side downgrade:
 * >1 means a DELETE becomes a mute-this-speaker REDACT, because the other
 * speakers' consent to their own voice survives this subject's erasure.
 */
function recordingItem({ recording, subjectId, segments, speakerCount }) {
  const consentId = segments.find((s) => s.consentId)?.consentId ?? null
  return {
    subjectId,
    type: 'AUDIO',
    origin: 'COLLECTION_SESSION',
    sourceTable: SOURCE.RECORDING,
    sourceId: recording.id,
    projectId: recording.session?.projectId ?? null,
    sessionId: recording.sessionId,
    storagePath: recording.storagePath,
    contentHash: recording.sha256 || null,
    capturedAt: recording.createdAt,
    sharedSubjectCount: Math.max(speakerCount, 1),
    redactedAvailable: isRecordingRedactedAvailable(recording),
    meta: {
      segments: segments.length,
      audibleSeconds: Number(
        segments.reduce((n, s) => n + Math.max(0, s.endSec - s.startSec), 0).toFixed(2),
      ),
      durationSec: recording.durationSec ?? null,
      recordingStatus: recording.status,
      // Recorded per-row for the same reason the import path records its lawful
      // basis: a KEEP segment with no consent id is a gap that must be visible
      // in the item grid, not smoothed over.
      lawfulBasis: consentId ? 'CONSENT' : 'UNVERIFIED',
    },
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
 * The audio twin of `enrollmentItem`.
 *
 * type AUDIO / origin ENROLLMENT, which is a combination nothing produced before
 * — a reference clip is not collection-session material and is not a photo. The
 * grid's type filter and the item-action `filter.type` both go through the same
 * enum, so this row is reachable and batch-selectable exactly like any other.
 *
 * `sharedSubjectCount: 1` for the same reason a selfie is 1: an enrollment clip
 * is one person's voice by construction, so it is never downgraded to a REDACT
 * and is always fully deletable. Recordings are the multi-speaker case, and they
 * come through `recordingItem`.
 */
function voiceEnrollmentItem(enrollment) {
  return {
    subjectId: enrollment.subjectId,
    type: 'AUDIO',
    origin: 'ENROLLMENT',
    sourceTable: SOURCE.VOICE_ENROLLMENT,
    sourceId: enrollment.id,
    projectId: null,
    sessionId: null,
    storagePath: enrollment.audioPath,
    contentHash: enrollment.sha256,
    capturedAt: enrollment.createdAt,
    sharedSubjectCount: 1,
    // There is no muted derivative of a reference clip and there should not be:
    // the whole clip is the biometric, so there is nothing to keep after the
    // voice is removed.
    redactedAvailable: false,
    meta: {
      durationSec: enrollment.durationSec ?? null,
      segments: null,
      audibleSeconds: null,
      recordingStatus: null,
    },
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
/**
 * `createMeta` is asserted, never refreshed. `meta` is refreshed.
 *
 * The two exist because the table carries two kinds of fact under one column.
 * `recordingItem` returns `meta`: segment counts and audible seconds, derived
 * from the transcript and wrong the moment they go stale, so a rebuild must
 * overwrite them. The lawful basis is the opposite kind of fact — asserted once,
 * about the state of the world when the row was made, and the import path
 * (import.service.ingestItem) creates its row itself precisely so its
 * `IMPORT_UNVERIFIED` survives the index refresh that follows. That refresh was
 * safe only by accident: `photoItem` returned no `meta` at all, so Prisma saw
 * `undefined` and skipped the column. Adding a basis to `photoItem` under the
 * old shape would have quietly rewritten every imported photo's basis to
 * CONSENT on the next rebuild.
 */
async function writeItem(item, { at, deletedAt = null }, client = prisma) {
  const { subjectId, type, sourceTable, sourceId, origin, createMeta, ...fields } = item
  const row = await client.subjectDataItem.upsert({
    where: { subjectId_type_sourceTable_sourceId: { subjectId, type, sourceTable, sourceId } },
    create: {
      subjectId,
      type,
      sourceTable,
      sourceId,
      origin,
      ...fields,
      ...(createMeta ? { meta: createMeta } : {}),
      deletedAt,
      indexedAt: at,
    },
    update: { ...fields, deletedAt, indexedAt: at },
  })
  return { row, createMeta: createMeta ?? null }
}

/**
 * Fills in `createMeta` on rows that have no meta yet.
 *
 * `meta IS NULL` is the whole guard, and it is what makes this assert-once
 * rather than overwrite: an import row always has meta, so it is never matched;
 * a row created by this pass already has it; only a row that predates the basis
 * being asserted at all is touched. That last case is the backfill — the index
 * held 126 photo and 4 video rows with a null basis before this shipped, and
 * without it the fix would only apply to frames collected in future.
 *
 * Grouped by the JSON value so a subject with forty frames costs two statements,
 * not forty.
 */
async function assertCreateMeta(written, client = prisma) {
  const byMeta = new Map()
  for (const { row, createMeta } of written) {
    if (!createMeta) continue
    const key = JSON.stringify(createMeta)
    const bucket = byMeta.get(key)
    if (bucket) bucket.ids.push(row.id)
    else byMeta.set(key, { meta: createMeta, ids: [row.id] })
  }

  for (const { meta, ids } of byMeta.values()) {
    await client.subjectDataItem.updateMany({
      where: { id: { in: ids }, meta: { equals: Prisma.DbNull } },
      data: { meta },
    })
  }
}

async function writeAll(entries, at, client = prisma) {
  const written = []
  for (let i = 0; i < entries.length; i += WRITE_CHUNK) {
    const chunk = entries.slice(i, i + WRITE_CHUNK)
    written.push(
      ...(await Promise.all(
        chunk.map(({ item, deletedAt }) => writeItem(item, { at, deletedAt }, client)),
      )),
    )
  }
  await assertCreateMeta(written, client)
  return written
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
const VIDEO_LINK_SELECT = {
  id: true,
  subjectId: true,
  consentId: true,
  consent: { select: { projectId: true } },
  video: {
    select: {
      id: true,
      sessionId: true,
      storagePath: true,
      redactedPath: true,
      status: true,
      sha256: true,
      durationSec: true,
      createdAt: true,
      session: { select: { projectId: true } },
      subjects: { select: { subjectId: true } },
    },
  },
}

/**
 * Same fail-closed rule as the photo and recording forms.
 *
 * A clip is only "redacted available" when a derivative exists AND the status
 * says the blur confirmed. A DEFERRED clip has no trustworthy derivative — its
 * analysis may have produced no track boxes at all, in which case a redaction
 * pass would have blurred nothing while still writing a file. Serving that is
 * the reportable failure.
 */
export function isVideoRedactedAvailable(video) {
  return Boolean(video.redactedPath) && video.status === 'REDACTED'
}

/**
 * One index row per subject per clip.
 *
 * `sharedSubjectCount` counts the DISTINCT linked subjects on the whole clip,
 * the video analogue of `photo.subjects.length`, and it drives the same
 * server-side downgrade: more than one means a DELETE becomes a blur-this-person
 * REREDACT, because the others' consent to their own footage survives this
 * subject's erasure.
 */
function videoItem(link) {
  const video = link.video
  return {
    subjectId: link.subjectId,
    type: 'VIDEO',
    origin: 'COLLECTION_SESSION',
    sourceTable: SOURCE.VIDEO_SUBJECT,
    sourceId: link.id,
    projectId: video.session?.projectId ?? link.consent?.projectId ?? null,
    sessionId: video.sessionId,
    storagePath: video.storagePath,
    contentHash: video.sha256 || null,
    capturedAt: video.createdAt,
    sharedSubjectCount: Math.max(video.subjects.length, 1),
    redactedAvailable: isVideoRedactedAvailable(video),
    createMeta: lawfulBasisMeta(link.consentId),
  }
}

export async function indexSubject(subjectId, { at = new Date() } = {}) {
  const [links, enrollments, voiceEnrollments, recordings, videoLinks] = await Promise.all([
    prisma.photoSubject.findMany({ where: { subjectId }, select: PHOTO_LINK_SELECT }),
    prisma.subjectFaceEnrollment.findMany({
      where: { subjectId },
      select: { id: true, subjectId: true, imagePath: true, sha256: true, createdAt: true, deletedAt: true },
    }),
    prisma.subjectVoiceEnrollment.findMany({
      where: { subjectId },
      select: {
        id: true,
        subjectId: true,
        audioPath: true,
        sha256: true,
        durationSec: true,
        createdAt: true,
        deletedAt: true,
      },
    }),
    // Every recording this subject is audible in, with the full segment set so
    // the shared-speaker count is derived from the recording rather than from
    // this subject's slice of it.
    prisma.recording.findMany({
      where: { segments: { some: { subjectId } } },
      select: RECORDING_SELECT,
    }),
    prisma.videoSubject.findMany({ where: { subjectId }, select: VIDEO_LINK_SELECT }),
  ])

  const entries = [
    ...links.map((link) => ({ item: photoItem(link), deletedAt: null })),
    // A soft-deleted enrollment is already gone as far as the principal is
    // concerned; it enters the index as a tombstone rather than as live data.
    ...enrollments.map((e) => ({ item: enrollmentItem(e), deletedAt: e.deletedAt ?? null })),
    ...voiceEnrollments.map((e) => ({
      item: voiceEnrollmentItem(e),
      deletedAt: e.deletedAt ?? null,
    })),
    ...recordings.map((recording) => ({
      item: recordingItem({
        recording,
        subjectId,
        segments: recording.segments.filter((s) => s.subjectId === subjectId),
        speakerCount: distinctSpeakers(recording.segments),
      }),
      deletedAt: null,
    })),
    ...videoLinks.map((link) => ({ item: videoItem(link), deletedAt: null })),
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
  // Same assert-once pass the bulk path runs. Import calls this straight after
  // creating its own row, so the null-meta guard inside is what stops it
  // rewriting an IMPORT_UNVERIFIED basis to CONSENT.
  await assertCreateMeta([written], prisma)

  const siblings = row.photo.subjects.filter((s) => s.id !== row.id).map((s) => s.id)
  if (siblings.length > 0) {
    await prisma.subjectDataItem.updateMany({
      where: { sourceTable: SOURCE.PHOTO_SUBJECT, sourceId: { in: siblings }, deletedAt: null },
      data: { sharedSubjectCount: row.photo.subjects.length },
    })
  }

  return written.row
}

/**
 * Incremental path for audio: one recording was just analysed or re-analysed.
 *
 * Writes (or refreshes) one item per identified speaker and tombstones items for
 * speakers a re-analysis no longer places on the recording — a person removed
 * from the transcript must stop being listed as data we hold about them.
 *
 * Unlike `photoItem`, `recordingItem` returns `meta`, so a rebuild refreshes the
 * segment counts. That is deliberate and does not contradict the create-only
 * rule in `writeItem`: `meta` there protects the import path's `lawfulBasis`,
 * which is asserted once and must survive; these counts are derived from the
 * segments and are wrong the moment they go stale.
 */
export async function indexRecording(recordingId, { at = new Date() } = {}) {
  const recording = await prisma.recording.findUnique({
    where: { id: recordingId },
    select: RECORDING_SELECT,
  })
  if (!recording) return null

  const speakerCount = distinctSpeakers(recording.segments)
  const bySubject = new Map()
  for (const segment of recording.segments) {
    if (!segment.subjectId) continue
    if (!bySubject.has(segment.subjectId)) bySubject.set(segment.subjectId, [])
    bySubject.get(segment.subjectId).push(segment)
  }

  const entries = [...bySubject].map(([subjectId, segments]) => ({
    item: recordingItem({ recording, subjectId, segments, speakerCount }),
    deletedAt: null,
  }))

  await writeAll(entries, at)

  // A re-analysis that no longer hears someone. Scoped to this recording, so it
  // can never touch another recording's rows.
  const { count: tombstoned } = await prisma.subjectDataItem.updateMany({
    where: {
      sourceTable: SOURCE.RECORDING,
      sourceId: recordingId,
      deletedAt: null,
      indexedAt: { lt: at },
    },
    data: { deletedAt: at },
  })

  return { recordingId, indexed: entries.length, tombstoned }
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
