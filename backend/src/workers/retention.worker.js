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

// Enrollments belonging to a revoked consent, 24h after revocation (§6.1). The
// blob goes here; the embedding row and the key are destroyed by the purge
// executor when the withdrawal's auto-raised erasure runs.
async function sweepRevokedEnrollments() {
  const cutoff = daysAgo(1)

  const revoked = await prisma.projectConsent.findMany({
    where: { status: 'REVOKED', revokedAt: { lt: cutoff } },
    select: { subjectId: true },
  })
  if (revoked.length === 0) return { shredded: 0 }

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
  if (orphaned.length === 0) return { shredded: 0 }

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

  return { shredded }
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

  const [originals, enrollments, packages, accessEvents] = await Promise.all([
    sweepOriginals(),
    sweepRevokedEnrollments(),
    expirePackages(),
    sweepAccessEvents(),
  ])

  const summary = {
    originals,
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
