import { createHash } from 'node:crypto'
import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { logger } from '../../lib/logger.js'
import { readFile, shredFile, fileExists } from '../../lib/storage.js'
import { destroySubjectKey } from '../../lib/keyring.js'
import { rebuildRedactedForRemaining } from '../sessions/session.service.js'
import { runDiscovery } from './discovery.service.js'

// The erasure executor.
//
// Three properties this file exists to guarantee, in priority order:
//
//  1. It never destroys another subject's lawfully-held data. Erasure operates on
//     the PhotoSubject LINK, never on the photo. A photo holding A and B, where A
//     erases, is kept for B and rebuilt with A blurred.
//  2. It is resumable. Every location is its own row with its own status, so a
//     crash halfway through resumes instead of restarting — restarting would
//     re-hash objects that no longer exist and report them as missing.
//  3. It records what it destroyed before destroying it. hashBefore is captured
//     in the same step as the delete; afterwards there is nothing left to hash and
//     the certificate would have nothing to attest to.

// Phase order is load-bearing, not cosmetic. Two orderings would corrupt the
// result if reversed:
//   - REREDACT before L2: rebuilding a derivative needs the original.
//   - SUBJECT_KEY last: destroying the DEK first makes every remaining sealed
//     blob unreadable, so nothing after it could be hashed.
const PHASE_ORDER = [
  'LINK',       // drop the consent links first — they are the erasure key, and
                // L6 reads them to decide rebuild-vs-delete
  'L6',         // rebuild survivors' derivatives, or delete when nobody is left
  'L3',         // face crops
  'L7',         // per-person derivative cache
  'L2',         // originals — AFTER L6, which needs them to rebuild
  'L4',         // enrollment selfies
  'L5_ROW',     // embedding rows
  'ROSTER',
  'CONSENT',
  'PII',
  'L9', 'L10',
  'L8', 'L11',  // tombstones
  'SUBJECT_KEY', // crypto-shred, always last
]

// Derived from persisted columns only. Discovery annotates L6 rows with a
// rebuild-or-delete hint, but PurgeJobLocation has no column to carry it and
// inventing one would mean trusting a decision made minutes earlier — so the L6
// handler re-derives it from the links as they stand at execution time.
function phaseOf(loc) {
  if (loc.objectType === 'SubjectKey') return 'SUBJECT_KEY'
  if (loc.locationCode === 'L5') return 'L5_ROW'
  return loc.locationCode
}

async function hashOf(storagePath) {
  try {
    // Hash the plaintext, not the envelope: the envelope's nonce differs per
    // write, so hashing ciphertext would produce a value that proves nothing
    // about the content and could not be compared to anything.
    const buf = await readFile(storagePath)
    return createHash('sha256').update(buf).digest('hex')
  } catch {
    return null
  }
}

/**
 * Plans the purge. Runs discovery and materialises one PurgeJobLocation per
 * place the subject exists.
 *
 * Idempotent: re-planning an existing job returns it untouched rather than
 * duplicating locations, so a retried request cannot double-execute.
 */
export async function createPurgeJob(dsarRequestId, admin = null) {
  const request = await prisma.dsarRequest.findUnique({ where: { id: dsarRequestId } })
  if (!request) throw new ApiError(404, 'DSAR request not found')
  if (!['ERASE', 'WITHDRAWAL_ERASURE'].includes(request.type)) {
    throw new ApiError(400, `DSAR type ${request.type} is not an erasure`)
  }

  const existing = await prisma.purgeJob.findFirst({
    where: { dsarRequestId, status: { in: ['QUEUED', 'RUNNING', 'PARTIAL'] } },
    include: { locations: true },
  })
  if (existing) return existing

  const discovery = await runDiscovery(request.subjectId)

  const job = await prisma.purgeJob.create({
    data: {
      dsarRequestId,
      subjectId: request.subjectId,
      status: 'QUEUED',
      locationsTotal: discovery.locations.length,
      locations: {
        create: discovery.locations.map((l) => ({
          locationCode: l.locationCode,
          objectType: l.objectType,
          objectId: l.objectId,
          storagePath: l.storagePath,
          status: 'PENDING',
        })),
      },
    },
    include: { locations: true },
  })

  await writeAuditLog({
    entityType: 'DsarRequest',
    entityId: dsarRequestId,
    action: 'PURGE_PLANNED',
    actorId: admin?.id ?? null,
    payload: {
      purgeJobId: job.id,
      locations: discovery.locations.length,
      multiSubjectPhotos: discovery.counts.multiSubjectPhotos,
    },
  })

  return job
}

// Each handler returns 'DONE' or 'SKIPPED'. Throwing marks the location FAILED
// and leaves the job PARTIAL — never silently complete.
const handlers = {
  async LINK(loc) {
    const { count } = await prisma.photoSubject.deleteMany({ where: { id: loc.objectId } })
    return count > 0 ? 'DONE' : 'SKIPPED'
  },

  async L3(loc) {
    if (loc.storagePath && (await fileExists(loc.storagePath))) await shredFile(loc.storagePath)
    const { count } = await prisma.faceDetection.deleteMany({ where: { id: loc.objectId } })
    return count > 0 || loc.storagePath ? 'DONE' : 'SKIPPED'
  },

  async L7(loc) {
    if (!loc.storagePath || !(await fileExists(loc.storagePath))) return 'SKIPPED'
    await shredFile(loc.storagePath)
    return 'DONE'
  },

  async L6(loc, job) {
    // Only reached when this subject was the sole subject on the photo — the
    // multi-subject case was routed to REREDACT during planning. Re-checked here
    // rather than trusted, because planning and execution can be minutes apart
    // and another subject could have been unlinked in between.
    const remaining = await prisma.photoSubject.count({
      where: { photoId: loc.objectId, subjectId: { not: job.subjectId } },
    })
    if (remaining > 0) {
      await rebuildRedactedForRemaining(loc.objectId)
      return 'DONE'
    }
    if (loc.storagePath && (await fileExists(loc.storagePath))) await shredFile(loc.storagePath)
    await prisma.photo.updateMany({ where: { id: loc.objectId }, data: { redactedPath: null } })
    return 'DONE'
  },

  async L2(loc, job) {
    // Invariant 5: erasure operates on the LINK, not on the photo. A frame that
    // still holds B is B's lawfully-collected data, and the original is the part
    // of it that matters — it is what readRawForDsar serves under break-glass and
    // what rebuildRedactedForRemaining needs to blur the NEXT person who erases.
    //
    // Shredding it and keeping only the row is not "keeping the photo for B": it
    // leaves a row pointing at bytes that no longer exist, and it makes the frame
    // permanently un-re-redactable, so a second erasure from the same photo can
    // never be honoured. The bytes go only when the last link does.
    const remaining = await prisma.photoSubject.count({ where: { photoId: loc.objectId } })

    if (remaining > 0) {
      logger.info(
        { photoId: loc.objectId, remaining, purgeJobId: job.id },
        'original retained — other subjects still hold consent to this photo',
      )
      // A's presence in the frame is already handled: the link is gone (LINK) and
      // the derivative was rebuilt with A blurred (L6). Nothing served from this
      // photo shows A any more.
      return 'SKIPPED'
    }

    if (loc.storagePath && (await fileExists(loc.storagePath))) await shredFile(loc.storagePath)
    await prisma.photo.deleteMany({ where: { id: loc.objectId } })
    return 'DONE'
  },

  async L4(loc) {
    if (loc.storagePath && (await fileExists(loc.storagePath))) await shredFile(loc.storagePath)
    return 'DONE'
  },

  async L5_ROW(loc) {
    const { count } = await prisma.subjectFaceEnrollment.deleteMany({ where: { id: loc.objectId } })
    return count > 0 ? 'DONE' : 'SKIPPED'
  },

  async ROSTER(loc) {
    const { count } = await prisma.sessionParticipant.deleteMany({ where: { id: loc.objectId } })
    return count > 0 ? 'DONE' : 'SKIPPED'
  },

  async CONSENT(loc) {
    // Marked PURGED, never deleted. The row is the fiduciary's proof that the
    // collection was lawful when it happened; destroying it on the principal's
    // request would destroy our own defence, and DPDP does not ask for it.
    const { count } = await prisma.projectConsent.updateMany({
      where: { consentId: loc.objectId },
      data: { status: 'PURGED' },
    })
    return count > 0 ? 'DONE' : 'SKIPPED'
  },

  async PII(loc) {
    // Anonymised in place rather than deleted: the row is the anchor for the
    // consent proof above and for this very DSAR request. What is removed is
    // everything that identifies a person.
    const anon = `erased-${loc.objectId.slice(0, 8)}@erased.invalid`
    await prisma.subject.updateMany({
      where: { masterUserId: loc.objectId },
      data: {
        fullName: 'ERASED',
        email: anon,
        phone: null,
        employeeRef: null,
        dateOfBirth: null,
        guardianContact: null,
        nomineeContact: null,
        status: 'ERASED',
      },
    })
    return 'DONE'
  },

  async L9(loc) {
    if (!loc.storagePath || !(await fileExists(loc.storagePath))) return 'SKIPPED'
    await shredFile(loc.storagePath)
    return 'DONE'
  },

  async L10(loc) {
    return handlers.L9(loc)
  },

  async L8() {
    return 'SKIPPED'
  },

  async L11() {
    // Nothing to execute. The location exists so the certificate names it and so
    // the residual risk is on the record instead of being an omission.
    return 'SKIPPED'
  },

  async SUBJECT_KEY(loc, job) {
    await destroySubjectKey(job.subjectId)
    await prisma.purgeJob.update({
      where: { id: job.id },
      data: { keyDestroyedAt: new Date() },
    })
    return 'DONE'
  },
}

/**
 * Executes (or resumes) a purge job.
 *
 * Safe to call repeatedly: locations already DONE or SKIPPED are not revisited,
 * and each handler is written to tolerate the object already being gone.
 */
export async function executePurgeJob(purgeJobId, { admin = null } = {}) {
  const job = await prisma.purgeJob.findUnique({
    where: { id: purgeJobId },
    include: { locations: true },
  })
  if (!job) throw new ApiError(404, 'Purge job not found')
  if (job.status === 'COMPLETED') return job

  await prisma.purgeJob.update({
    where: { id: purgeJobId },
    data: { status: 'RUNNING', startedAt: job.startedAt ?? new Date() },
  })

  const pending = job.locations.filter((l) => l.status === 'PENDING' || l.status === 'FAILED')
  const ordered = [...pending].sort(
    (a, b) => PHASE_ORDER.indexOf(phaseOf(a)) - PHASE_ORDER.indexOf(phaseOf(b)),
  )

  let failures = 0

  for (const loc of ordered) {
    const phase = phaseOf(loc)
    const handler = handlers[phase]

    if (!handler) {
      await prisma.purgeJobLocation.update({
        where: { id: loc.id },
        data: { status: 'FAILED', error: `No handler for phase "${phase}"`, attempts: { increment: 1 } },
      })
      failures += 1
      continue
    }

    try {
      await prisma.purgeJobLocation.update({ where: { id: loc.id }, data: { status: 'RUNNING' } })

      // Captured before the handler runs. This is the only moment the object is
      // both still present and known to be about to be destroyed.
      const hashBefore = loc.hashBefore ?? (loc.storagePath ? await hashOf(loc.storagePath) : null)

      const outcome = await handler(loc, job)

      await prisma.purgeJobLocation.update({
        where: { id: loc.id },
        data: {
          status: outcome,
          hashBefore,
          completedAt: new Date(),
          error: null,
          attempts: { increment: 1 },
        },
      })
    } catch (err) {
      failures += 1
      logger.error({ err, locationId: loc.id, phase, purgeJobId }, 'purge location failed')
      await prisma.purgeJobLocation.update({
        where: { id: loc.id },
        data: { status: 'FAILED', error: String(err?.message ?? err), attempts: { increment: 1 } },
      })
    }
  }

  const done = await prisma.purgeJobLocation.count({
    where: { purgeJobId, status: { in: ['DONE', 'SKIPPED'] } },
  })
  const total = await prisma.purgeJobLocation.count({ where: { purgeJobId } })
  const complete = done === total && failures === 0

  const updated = await prisma.purgeJob.update({
    where: { id: purgeJobId },
    data: {
      status: complete ? 'COMPLETED' : 'PARTIAL',
      locationsDone: done,
      finishedAt: complete ? new Date() : null,
      error: complete ? null : `${total - done} location(s) incomplete`,
    },
  })

  await writeAuditLog({
    entityType: 'DsarRequest',
    entityId: job.dsarRequestId,
    action: complete ? 'PURGE_COMPLETED' : 'PURGE_PARTIAL',
    actorId: admin?.id ?? null,
    payload: { purgeJobId, done, total, failures },
  })

  return updated
}

export async function getPurgeJob(purgeJobId) {
  const job = await prisma.purgeJob.findUnique({
    where: { id: purgeJobId },
    include: { locations: { orderBy: { locationCode: 'asc' } } },
  })
  if (!job) throw new ApiError(404, 'Purge job not found')
  return job
}
