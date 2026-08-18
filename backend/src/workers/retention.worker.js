import 'dotenv/config'
import { prisma } from '../config/prisma.js'
import { logger } from '../lib/logger.js'
import { writeAuditLog } from '../lib/auditLog.js'
import { shredFile, fileExists } from '../lib/storage.js'
import { expirePackages } from '../modules/dsar/export.service.js'

// Enforces §6.1's retention clocks. Storage limitation is not a background
// nicety: holding a raw original past its purpose is unlawful processing, and
// nothing in the request path ever deletes it, so this is the only thing that
// does.
//
// Runs as a loop rather than through BullMQ because there is nothing to
// distribute and no per-job state worth persisting — the DB is the state.

const INTERVAL_MS = Number(process.env.RETENTION_SWEEP_INTERVAL_MS ?? 60 * 60 * 1000)
const ORIGINAL_TTL_DAYS = Number(process.env.RETENTION_ORIGINAL_DAYS ?? 7)
const ACCESS_EVENT_TTL_DAYS = Number(process.env.RETENTION_ACCESS_EVENT_DAYS ?? 3 * 365)

function daysAgo(days) {
  return new Date(Date.now() - days * 86_400_000)
}

/**
 * L2 originals, 7 days after the session archived.
 *
 * The photo ROW survives — it carries the redacted derivative, the consent links
 * and the lineage. Only the unredactable original goes, and only once a redacted
 * derivative exists to replace it. Deleting the original of a photo that was
 * never successfully redacted would destroy the only copy that could still be
 * masked, so those are left alone and reported instead.
 */
async function sweepOriginals() {
  const cutoff = daysAgo(ORIGINAL_TTL_DAYS)

  const photos = await prisma.photo.findMany({
    where: {
      storagePath: { not: '' },
      redactedPath: { not: null },
      piiStatus: { in: ['CLEAN', 'MASKED'] },
      session: { is: { status: 'ARCHIVED', archivedAt: { lt: cutoff } } },
    },
    select: { id: true, storagePath: true, sessionId: true },
    take: 500,
  })

  let shredded = 0
  for (const photo of photos) {
    try {
      if (!(await fileExists(photo.storagePath))) continue
      await shredFile(photo.storagePath)
      await writeAuditLog({
        entityType: 'Photo',
        entityId: photo.id,
        action: 'ORIGINAL_RETENTION_EXPIRED',
        actorId: null,
        payload: { sessionId: photo.sessionId, ttlDays: ORIGINAL_TTL_DAYS },
      })
      shredded += 1
    } catch (err) {
      logger.error({ err, photoId: photo.id }, 'retention: could not shred original')
    }
  }

  const blocked = await prisma.photo.count({
    where: {
      redactedPath: null,
      session: { is: { status: 'ARCHIVED', archivedAt: { lt: cutoff } } },
    },
  })

  return { shredded, blockedByMissingRedaction: blocked }
}

/**
 * L14 recording originals, on the same clock as L2 photo originals.
 *
 * This sweep looked at `Photo.storagePath` and nothing else, so a recording
 * outlived the original-media TTL that governs every photo captured in the same
 * session — the raw, un-muted audio of every bystander in the room sat there
 * indefinitely. Storage limitation does not have a modality exemption.
 *
 * The rule is copied from sweepOriginals() unchanged: the ROW survives (it
 * carries the muted derivative, the segments and the lineage), only the
 * unredactable original goes, and only once a confirmed muted derivative exists
 * to replace it. `isRecordingRedactedAvailable`'s condition is inlined as a
 * query rather than called, for the same reason the photo sweep inlines its own:
 * the filter has to run in Postgres, not over a loaded page.
 *
 * Consequence worth stating, because it is real and it is inherited from the
 * photo path rather than introduced here: once the original is shredded,
 * `rebuildRedactedForRemainingSpeakers` can no longer re-mute this recording, so
 * a later erasure by one of several speakers resolves by destroying it outright
 * instead. That is the correct direction to fail — it destroys more, not less.
 */
async function sweepRecordingOriginals() {
  const cutoff = daysAgo(ORIGINAL_TTL_DAYS)

  const recordings = await prisma.recording.findMany({
    where: {
      storagePath: { not: '' },
      redactedPath: { not: null },
      status: 'REDACTED',
      session: { is: { status: 'ARCHIVED', archivedAt: { lt: cutoff } } },
    },
    select: { id: true, storagePath: true, sessionId: true },
    take: 500,
  })

  let shredded = 0
  for (const recording of recordings) {
    try {
      if (!(await fileExists(recording.storagePath))) continue
      await shredFile(recording.storagePath)
      await writeAuditLog({
        entityType: 'Recording',
        entityId: recording.id,
        action: 'ORIGINAL_RETENTION_EXPIRED',
        actorId: null,
        payload: { sessionId: recording.sessionId, ttlDays: ORIGINAL_TTL_DAYS },
      })
      shredded += 1
    } catch (err) {
      logger.error({ err, recordingId: recording.id }, 'retention: could not shred recording original')
    }
  }

  // Anything past TTL that is not confirmably muted — DEFERRED, still awaiting
  // analysis, or missing its derivative. Reported, never shredded: destroying
  // the original of a recording that was never muted would destroy the only copy
  // that could still be masked.
  const blocked = await prisma.recording.count({
    where: {
      NOT: { AND: [{ status: 'REDACTED' }, { redactedPath: { not: null } }] },
      session: { is: { status: 'ARCHIVED', archivedAt: { lt: cutoff } } },
    },
  })

  return { shredded, blockedByMissingRedaction: blocked }
}

// Enrollments belonging to a revoked consent, 24h after revocation (§6.1). The
// blob goes here; the embedding row and the key are destroyed by the purge
// executor when the withdrawal's auto-raised erasure runs.
async function sweepRevokedEnrollments() {
  const cutoff = daysAgo(1)

  const revoked = await prisma.projectConsent.findMany({
    where: { status: 'REVOKED', revokedAt: { lt: cutoff } },
    select: { subjectId: true },
  })
  if (revoked.length === 0) return { shredded: 0, voiceShredded: 0 }

  const subjectIds = [...new Set(revoked.map((r) => r.subjectId))]

  // Only subjects with NO remaining active consent anywhere. A person who
  // withdrew from one project but is still enrolled in another keeps their
  // enrollment — it is still lawfully held for that other purpose.
  const stillActive = await prisma.projectConsent.findMany({
    where: { subjectId: { in: subjectIds }, status: 'ACTIVE' },
    select: { subjectId: true },
  })
  const active = new Set(stillActive.map((c) => c.subjectId))
  const orphaned = subjectIds.filter((id) => !active.has(id))
  if (orphaned.length === 0) return { shredded: 0, voiceShredded: 0 }

  const enrollments = await prisma.subjectFaceEnrollment.findMany({
    where: { subjectId: { in: orphaned } },
    select: { id: true, subjectId: true, imagePath: true },
  })

  let shredded = 0
  for (const enrollment of enrollments) {
    try {
      if (enrollment.imagePath && (await fileExists(enrollment.imagePath))) {
        await shredFile(enrollment.imagePath)
        shredded += 1
      }
      await prisma.subjectFaceEnrollment.update({
        where: { id: enrollment.id },
        data: { deletedAt: new Date() },
      })
    } catch (err) {
      logger.error({ err, enrollmentId: enrollment.id }, 'retention: could not shred enrollment selfie')
    }
  }

  // Voice enrollments of the same orphaned subjects, on the same clock and for
  // the same reason. A person with no active consent anywhere is a person whose
  // voice print is held for no purpose — leaving it because the sweep only knew
  // about selfies would be the modality exemption that does not exist.
  //
  // Unlike the face branch above, the embedding column is cleared here rather
  // than left to the key destruction. It costs one field and it means the
  // biometric is gone even in the window before the withdrawal's auto-raised
  // erasure runs, which is exactly what deleteVoiceEnrollment already does on
  // the request path.
  const voiceEnrollments = await prisma.subjectVoiceEnrollment.findMany({
    where: { subjectId: { in: orphaned }, deletedAt: null },
    select: { id: true, subjectId: true, audioPath: true },
  })

  let voiceShredded = 0
  for (const enrollment of voiceEnrollments) {
    try {
      if (enrollment.audioPath && (await fileExists(enrollment.audioPath))) {
        await shredFile(enrollment.audioPath)
        voiceShredded += 1
      }
      await prisma.subjectVoiceEnrollment.update({
        where: { id: enrollment.id },
        data: { deletedAt: new Date(), embedding: null, embeddingDim: null },
      })
    } catch (err) {
      logger.error({ err, enrollmentId: enrollment.id }, 'retention: could not shred enrollment voice clip')
    }
  }

  return { shredded, voiceShredded }
}

// AccessEvent, 3 years. Uses raw SQL because the RLS migration grants the app
// INSERT and SELECT only — this delete is expected to fail when the app connects
// as a least-privilege role, and that failure is correct, not a bug. Ops runs the
// sweep under the role that owns the exemption.
async function sweepAccessEvents() {
  const cutoff = daysAgo(ACCESS_EVENT_TTL_DAYS)
  try {
    const deleted = await prisma.accessEvent.deleteMany({ where: { createdAt: { lt: cutoff } } })
    return { deleted: deleted.count }
  } catch (err) {
    logger.warn(
      { err },
      'retention: access_events delete refused — expected when running as the least-privilege app role',
    )
    return { deleted: 0, refused: true }
  }
}

export async function runSweep() {
  const startedAt = Date.now()

  const [originals, recordingOriginals, enrollments, packages, accessEvents] = await Promise.all([
    sweepOriginals(),
    sweepRecordingOriginals(),
    sweepRevokedEnrollments(),
    expirePackages(),
    sweepAccessEvents(),
  ])

  const summary = {
    originals,
    recordingOriginals,
    enrollments,
    packagesExpired: packages,
    accessEvents,
    durationMs: Date.now() - startedAt,
  }

  logger.info(summary, 'retention sweep complete')

  if (originals.blockedByMissingRedaction > 0) {
    logger.warn(
      { count: originals.blockedByMissingRedaction },
      'retention: originals past TTL retained because no confirmed redaction exists — the redaction queue must clear them first',
    )
  }

  // Separate warning rather than a combined count: a stuck audio worker and a
  // stuck image worker are different outages with different fixes, and a single
  // number would hide one behind the other.
  if (recordingOriginals.blockedByMissingRedaction > 0) {
    logger.warn(
      { count: recordingOriginals.blockedByMissingRedaction },
      'retention: recording originals past TTL retained because no confirmed muted copy exists — the audio worker must clear them first',
    )
  }

  return summary
}

// `--once` for cron-driven deployments; the default loop suits a long-running
// process. Both call the same function.
const runOnce = process.argv.includes('--once')

if (runOnce) {
  runSweep()
    .catch((err) => {
      logger.error({ err }, 'retention sweep failed')
      process.exitCode = 1
    })
    .finally(() => prisma.$disconnect())
} else {
  logger.info({ intervalMs: INTERVAL_MS }, 'retention worker started')
  const timer = setInterval(() => {
    runSweep().catch((err) => logger.error({ err }, 'retention sweep failed'))
  }, INTERVAL_MS)

  runSweep().catch((err) => logger.error({ err }, 'retention sweep failed'))

  const shutdown = async (signal) => {
    logger.info({ signal }, 'retention worker shutting down')
    clearInterval(timer)
    await prisma.$disconnect()
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}
