import { prisma } from '../config/prisma.js'
import { logger } from './logger.js'
import { shredFile, fileExists } from './storage.js'

// Deleting a row that points at a blob, without deleting the blob.
//
// That single omission is the reason a signed DeletionCertificate could attest
// to an erasure that did not happen. The measurement: 1,353 files under
// ./storage/media, 396 of them referenced by any row — 1,123 orphans, 265 MB,
// including 383 cropped face images and 135 enrolment selfies. Both discovery
// (discovery.service.js) and purge (purge.service.js) enumerate blobs by walking
// database rows, so a file with no row is invisible to both. An erasure
// completes, a certificate is signed, and 518 biometric files remain on disk.
//
// Two manufacturing routes were confirmed:
//
//   1. recognition.service.js drops every FaceDetection on a re-run
//      (`deleteMany`) without touching their crops.
//   2. finalizeSession's revocation branch deletes the detections of a subject
//      who withdrew consent — leaving that person's cropped face on disk
//      indefinitely. That is the worst possible version of this bug: the
//      strongest signal of intent we ever receive, and it manufactures an
//      orphan.
//
// The rule this module enforces: collect the paths BEFORE deleting the rows, in
// the same transaction, then shred the files after the transaction commits. Not
// during — a shred inside a transaction that later rolls back destroys a file
// the database still references, which is the one failure worse than an orphan.

/**
 * Deletes rows and their blobs together.
 *
 * @param {object} options
 * @param {(tx: any) => Promise<string[]>} options.collectPaths
 *        Runs inside the transaction. Returns every storage path the rows about
 *        to be deleted point at. Collect first — after the delete the paths are
 *        unrecoverable, which is exactly how the orphans were made.
 * @param {(tx: any) => Promise<any>} options.deleteRows
 *        Runs inside the same transaction, after collectPaths.
 * @param {string} options.reason  recorded on the quarantine ledger row.
 * @returns {{result: any, shredded: number, failed: string[]}}
 */
export async function deleteRowsAndBlobs({ collectPaths, deleteRows, reason }) {
  const { paths, result } = await prisma.$transaction(async (tx) => {
    const collected = await collectPaths(tx)
    const deleted = await deleteRows(tx)
    return { paths: collected.filter(Boolean), result: deleted }
  })

  // Past the commit: the rows are gone, so these files are now unreferenced by
  // construction and shredding them cannot orphan anything.
  const failed = []
  let shredded = 0

  for (const path of new Set(paths)) {
    try {
      await shredFile(path)
      shredded += 1
    } catch (err) {
      // A file we could not delete is the dangerous direction, so it is recorded
      // rather than swallowed. The storage reaper picks these up.
      failed.push(path)
      logger.error({ err, path, reason }, 'blob delete failed — recording for the reaper')
    }
  }

  if (failed.length) {
    await recordUnreachableBlobs(failed, reason)
  }

  logger.info({ shredded, failed: failed.length, reason }, 'deleteRowsAndBlobs')
  return { result, shredded, failed }
}

/**
 * Records blobs that outlived their rows but could not be deleted.
 *
 * Written to the OrphanBlob table so the reaper has a work list and so an
 * auditor can see that the system knows about them. Best-effort: if this write
 * fails too, the filesystem sweep in the erasure-completeness test still finds
 * the file, which is the backstop that matters.
 */
export async function recordUnreachableBlobs(paths, reason) {
  try {
    await prisma.orphanBlob.createMany({
      data: paths.map((storagePath) => ({
        storagePath,
        reason: String(reason ?? 'DELETE_FAILED').slice(0, 200),
        state: 'PENDING_DELETE',
      })),
      skipDuplicates: true,
    })
  } catch (err) {
    logger.error({ err, count: paths.length }, 'could not record unreachable blobs')
  }
}

/**
 * Deletes one blob whose row is already gone or about to be.
 * Returns true if the file is no longer present afterwards — including the case
 * where it was already absent, which is a success, not a failure.
 */
export async function shredIfPresent(path, reason) {
  if (!path) return true
  try {
    if (!(await fileExists(path))) return true
    await shredFile(path)
    return true
  } catch (err) {
    logger.error({ err, path, reason }, 'blob shred failed')
    await recordUnreachableBlobs([path], reason)
    return false
  }
}

/**
 * Every schema column that stores a path into the media root.
 *
 * The reconciliation that found the orphans walked all fifteen of them, and the
 * storage reaper and the erasure-completeness sweep both need the same list.
 * Keeping it here means a new path column is added in one place rather than
 * being silently excluded from both.
 *
 * Each entry: the Prisma model delegate name, and the path-bearing fields on it.
 */
export const PATH_COLUMNS = Object.freeze([
  { model: 'photo', fields: ['storagePath', 'redactedPath'] },
  { model: 'faceDetection', fields: ['cropPath'] },
  { model: 'subjectFaceEnrollment', fields: ['imagePath'] },
  { model: 'subjectVoiceEnrollment', fields: ['audioPath'] },
  { model: 'recording', fields: ['storagePath', 'redactedPath'] },
  { model: 'videoAsset', fields: ['storagePath', 'redactedPath'] },
  { model: 'videoFaceTrack', fields: ['cropPath'] },
  { model: 'textDocument', fields: ['storagePath', 'redactedPath'] },
  // The last three do not own their blobs — they point at objects owned above.
  // They are still references: a file named by a DSAR evidence row or by the
  // subject data index must not be reaped, even once its owning row is gone,
  // because those two tables ARE the erasure record.
  { model: 'dsarEvidence', fields: ['storagePath'] },
  { model: 'purgeJobLocation', fields: ['storagePath'] },
  { model: 'subjectDataItem', fields: ['storagePath'] },
])

/**
 * Every path currently referenced by any row, as a Set.
 *
 * Read in one pass and deliberately not paginated: the whole point is that a
 * partial read would classify referenced files as orphans, and an orphan sweep
 * that deletes live media is far worse than one that runs out of memory. The
 * caller is expected to be a batch job. `assertComplete` makes the failure loud.
 */
export async function loadReferencedPaths({ assertComplete = true } = {}) {
  const referenced = new Set()
  let rowsRead = 0

  for (const { model, fields } of PATH_COLUMNS) {
    const delegate = prisma[model]
    if (!delegate) {
      const message = `PATH_COLUMNS names model "${model}", which does not exist on the Prisma client`
      if (assertComplete) throw new Error(message)
      logger.error({ model }, message)
      continue
    }

    const select = Object.fromEntries(fields.map((f) => [f, true]))
    const rows = await delegate.findMany({ select })
    rowsRead += rows.length

    for (const row of rows) {
      for (const field of fields) {
        if (row[field]) referenced.add(normalise(row[field]))
      }
    }
  }

  return { referenced, rowsRead }
}

/**
 * Storage paths are written in a mix of forms — some absolute-ish, some with
 * backslashes on Windows. Comparing raw strings is how a referenced file gets
 * classified as an orphan and deleted.
 */
export function normalise(storagePath) {
  return String(storagePath).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}
