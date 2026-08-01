import { createHash } from 'node:crypto'
import sharp from 'sharp'

import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { writeFile, deleteFile } from '../../lib/storage.js'
import { enqueueRedaction } from '../../lib/redactionQueue.js'
import { logger } from '../../lib/logger.js'
import { indexPhotoSubject, indexSubject, SOURCE } from '../dsar/itemIndex.service.js'
import { assertAcceptableFile, assertImportableSubject } from './import.validators.js'

// PLAN §G1 — "an Admin can import a named person's existing data".
//
// Until this existed, a photograph could only enter the system through a
// collection session, which meant everything a DSAR could ever find was
// something this system had captured itself. A privacy platform that can only
// answer for data it collected is not answering the question §11 asks.
//
// Three things make an import different from a capture, and all three are
// recorded rather than smoothed over:
//
//   1. There is no session, no agent and no capture event. `Photo.sessionId` is
//      null. Every consumer that walks `photo.session` must treat it as optional
//      — an imported frame is real data about a real person, and skipping it
//      because it has no session is a DSAR completeness hole, not a display bug.
//
//   2. There is no capture-time consent. If the importing admin names a project
//      and a live ProjectConsent exists, the item inherits it. If not, the item
//      carries `meta.lawfulBasis = 'IMPORT_UNVERIFIED'` and `PhotoSubject.consentId`
//      stays null. Manufacturing a consent row to satisfy a foreign key would
//      have been forging the exact record this system exists to keep honest.
//
//   3. Identification is an assertion by the importing admin, not a face match.
//      That is recorded too (`meta.identification = 'ADMIN_ASSERTED'`), because
//      "how do you know this is them" is the first question an auditor asks.

// Faces are not detected on an imported frame: detection is the recognition
// worker's job and it is driven by a session. The consequence is that the
// redacted derivative of an import masks PII TEXT but blurs no bystander faces,
// because there are no face boxes to blur. That gap is recorded on every
// imported item rather than left to be discovered later — see DPIA §"Import".
const FACE_DETECTION_STATE = 'NOT_RUN'

const IMPORT_CAMERA_SOURCE = 'IPHONE_UPLOAD'

function storagePathFor(subjectId, sha256) {
  // Under `subjects/<uid>/`, which storage.scopeForPath maps to the per-subject
  // DEK. That is deliberate and load-bearing: an imported photo must be reachable
  // by the same crypto-shred that a captured one is, or an erasure certificate
  // would be signed over a subject who still has readable imported media.
  return `subjects/${subjectId}/imports/${sha256}.jpg`
}

/**
 * Resolves the lawful basis for one imported item, live, at ingest time.
 *
 * Deliberately not resolved once at batch creation: consent can be revoked
 * between opening a batch and uploading the last file, and an item ingested
 * after a revocation must not inherit the consent that was live before it.
 */
async function resolveLawfulBasis(subjectId, projectId) {
  if (!projectId) {
    return { consentId: null, lawfulBasis: 'IMPORT_UNVERIFIED', projectId: null }
  }

  const consent = await prisma.projectConsent.findUnique({
    where: { subjectId_projectId: { subjectId, projectId } },
    select: { consentId: true, status: true },
  })

  if (!consent || consent.status !== 'ACTIVE') {
    return {
      consentId: null,
      lawfulBasis: 'IMPORT_UNVERIFIED',
      projectId,
      consentGap: consent ? consent.status : 'NONE',
    }
  }

  return { consentId: consent.consentId, lawfulBasis: 'PROJECT_CONSENT', projectId }
}

async function loadOpenBatch(batchId) {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } })
  if (!batch) throw new ApiError(404, 'Import batch not found')
  if (batch.status !== 'OPEN') {
    throw new ApiError(409, `Import batch is ${batch.status}; it accepts no further items`)
  }
  return batch
}

/**
 * Opens a batch. Nothing is ingested here — the batch exists first so that every
 * item written afterwards has something to be counted against, and so a crashed
 * upload leaves a visible OPEN batch rather than a scatter of orphan photos.
 */
export async function createBatch({ subjectId, projectId, note }, admin) {
  await assertImportableSubject(subjectId)

  if (projectId) {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    })
    if (!project) throw new ApiError(404, 'Project not found')
  }

  const batch = await prisma.importBatch.create({
    data: {
      subjectId,
      projectId: projectId ?? null,
      note: note ?? null,
      createdByAdminId: admin?.id ?? null,
      status: 'OPEN',
    },
  })

  await writeAuditLog({
    entityType: 'ImportBatch',
    entityId: batch.id,
    action: 'IMPORT_BATCH_OPENED',
    actorId: admin?.id ?? null,
    payload: { subjectId, projectId: projectId ?? null, note: note ?? null },
  })

  return batch
}

/**
 * Ingests one file into an open batch.
 *
 * Order matters and is not negotiable:
 *   seal the blob → write Photo + PhotoSubject → write the index row with
 *   origin=IMPORT → refresh the projection → enqueue redaction.
 *
 * The index row is written by THIS function rather than left to the indexer,
 * because `itemIndex.photoItem()` labels every photo link COLLECTION_SESSION and
 * `writeItem` sets `origin`/`meta` on create only. Creating the row here with
 * origin=IMPORT is what makes the label survive every later rebuild — an
 * imported photo that rebuilt as a collected one would erase the lawful-basis
 * gap from the record.
 */
export async function ingestItem({ batchId, file, takenAt = null }, admin) {
  const batch = await loadOpenBatch(batchId)
  await assertImportableSubject(batch.subjectId)
  assertAcceptableFile(file)

  const sha256 = createHash('sha256').update(file.buffer).digest('hex')

  // De-duplication is explicit here rather than implied by a unique index:
  // `Photo@@unique([sessionId, sha256])` stops de-duplicating the moment
  // sessionId is null, because Postgres treats NULLs as distinct. Scope is the
  // subject — the same file imported for two different people is two real items.
  const existing = await prisma.photo.findFirst({
    where: { sha256, sessionId: null, subjects: { some: { subjectId: batch.subjectId } } },
    select: { id: true },
  })
  if (existing) {
    await prisma.importBatch.update({
      where: { id: batch.id },
      data: { itemsTotal: { increment: 1 } },
    })
    return { photoId: existing.id, duplicate: true, itemId: null }
  }

  const meta = await sharp(file.buffer).metadata().catch(() => ({}))
  // Normalised to JPEG on the way in, exactly like the capture path, so the PII
  // worker and the browser only ever deal with one format.
  const normalized = await sharp(file.buffer).rotate().jpeg({ quality: 92 }).toBuffer()

  const storagePath = storagePathFor(batch.subjectId, sha256)
  await writeFile(storagePath, normalized)

  const basis = await resolveLawfulBasis(batch.subjectId, batch.projectId)

  let photo
  let link
  try {
    const written = await prisma.$transaction(async (tx) => {
      const p = await tx.photo.create({
        data: {
          sessionId: null,
          storagePath,
          cameraSource: IMPORT_CAMERA_SOURCE,
          sha256,
          mimeType: 'image/jpeg',
          sizeBytes: normalized.length,
          width: meta.width ?? null,
          height: meta.height ?? null,
          takenAt: takenAt ? new Date(takenAt) : null,
        },
      })

      const l = await tx.photoSubject.create({
        data: { photoId: p.id, subjectId: batch.subjectId, consentId: basis.consentId },
      })

      // Written inside the same transaction as the link. An item that is
      // discoverable but not indexed, or indexed but not discoverable, is the
      // kind of drift that makes a completeness claim unprovable.
      await tx.subjectDataItem.create({
        data: {
          subjectId: batch.subjectId,
          type: 'PHOTO',
          origin: 'IMPORT',
          sourceTable: SOURCE.PHOTO_SUBJECT,
          sourceId: l.id,
          // Only when a live consent was actually inherited. A batch opened
          // against a project whose consent is revoked has no project-scoped
          // basis, and stamping the project id anyway would let the item show up
          // in that project's view as though it belonged there. The gap is on
          // the record instead, as meta.consentGap. This also keeps the value
          // rebuild-stable: itemIndex re-derives projectId from the link's
          // consent, which is null in exactly the same cases.
          projectId: basis.lawfulBasis === 'PROJECT_CONSENT' ? basis.projectId : null,
          sessionId: null,
          storagePath,
          contentHash: sha256,
          capturedAt: takenAt ? new Date(takenAt) : p.createdAt,
          sharedSubjectCount: 1,
          redactedAvailable: false,
          meta: {
            lawfulBasis: basis.lawfulBasis,
            ...(basis.consentGap ? { consentGap: basis.consentGap } : {}),
            identification: 'ADMIN_ASSERTED',
            faceDetection: FACE_DETECTION_STATE,
            importBatchId: batch.id,
            importedByAdminId: admin?.id ?? null,
          },
        },
      })

      await tx.importBatch.update({
        where: { id: batch.id },
        data: { itemsTotal: { increment: 1 }, itemsDone: { increment: 1 } },
      })

      return { photo: p, link: l }
    })
    photo = written.photo
    link = written.link
  } catch (err) {
    // The blob is already sealed on disk but nothing references it. Leaving it
    // there would be an orphaned copy of a person's face with no row to find it
    // by — unreachable by discovery, unreachable by erasure.
    await deleteFile(storagePath).catch((rmErr) =>
      logger.error({ err: rmErr, storagePath }, 'import: could not remove orphaned blob'),
    )
    await prisma.importBatch
      .update({ where: { id: batch.id }, data: { itemsTotal: { increment: 1 }, itemsFailed: { increment: 1 } } })
      .catch(() => {})
    throw err
  }

  // Refreshes the derived columns (sharedSubjectCount above all) without
  // touching origin or meta — writeItem sets those on create only, which is
  // exactly why the row above had to be created here first.
  await indexPhotoSubject(link.id).catch((err) =>
    logger.error(
      { err, alert: 'ITEM_INDEX_REFRESH_FAILED', at: 'import.ingestItem', linkId: link.id },
      'import: item index refresh failed',
    ),
  )

  await writeAuditLog({
    entityType: 'ImportBatch',
    entityId: batch.id,
    action: 'IMPORT_ITEM_INGESTED',
    actorId: admin?.id ?? null,
    payload: {
      subjectId: batch.subjectId,
      photoId: photo.id,
      sha256,
      lawfulBasis: basis.lawfulBasis,
      sizeBytes: normalized.length,
    },
  })

  // Same PII treatment as a captured frame. Non-fatal: the photo is already
  // committed and refusing the upload now would report a failure for work that
  // succeeded. A dead queue leaves piiStatus PENDING, which the serving layer
  // already treats as "no redacted copy".
  await enqueueRedaction({ sessionId: null, photoId: photo.id }).catch((err) =>
    logger.error({ err, photoId: photo.id }, 'import: could not enqueue redaction'),
  )

  return {
    photoId: photo.id,
    duplicate: false,
    lawfulBasis: basis.lawfulBasis,
    sizeBytes: normalized.length,
  }
}

/**
 * Closes a batch and rebuilds the subject's index once.
 *
 * The per-item path already keeps the index correct; this is the belt to that
 * braces. A batch whose last upload raced a tagging write elsewhere could leave
 * a stale `sharedSubjectCount`, and that number is what decides whether a later
 * DELETE is downgraded to a REDACT.
 */
export async function closeBatch(batchId, { note } = {}, admin) {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } })
  if (!batch) throw new ApiError(404, 'Import batch not found')
  if (batch.status !== 'OPEN') return batch

  const closed = await prisma.importBatch.update({
    where: { id: batchId },
    data: {
      status: batch.itemsFailed > 0 && batch.itemsDone === 0 ? 'FAILED' : 'CLOSED',
      closedAt: new Date(),
      ...(note ? { note } : {}),
    },
  })

  const index = await indexSubject(batch.subjectId).catch((err) => {
    logger.error(
      { err, alert: 'ITEM_INDEX_REFRESH_FAILED', at: 'import.closeBatch', subjectId: batch.subjectId },
      'import: index rebuild failed on batch close',
    )
    return null
  })

  await writeAuditLog({
    entityType: 'ImportBatch',
    entityId: batchId,
    action: 'IMPORT_BATCH_CLOSED',
    actorId: admin?.id ?? null,
    payload: {
      subjectId: batch.subjectId,
      itemsTotal: closed.itemsTotal,
      itemsDone: closed.itemsDone,
      itemsFailed: closed.itemsFailed,
    },
  })

  return { ...closed, index }
}

export async function listBatches({ subjectId, status, limit = 50 }) {
  const items = await prisma.importBatch.findMany({
    where: {
      ...(subjectId ? { subjectId } : {}),
      ...(status ? { status } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
  })
  return { items }
}

export async function getBatch(batchId) {
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    include: { project: { select: { id: true, name: true } } },
  })
  if (!batch) throw new ApiError(404, 'Import batch not found')

  // Counted off the index rather than off the batch's own counters: the counters
  // are bookkeeping, the index is what a DSAR will actually report.
  const indexed = await prisma.subjectDataItem.count({
    where: {
      subjectId: batch.subjectId,
      origin: 'IMPORT',
      deletedAt: null,
      meta: { path: ['importBatchId'], equals: batch.id },
    },
  })

  return { ...batch, indexedItems: indexed }
}
