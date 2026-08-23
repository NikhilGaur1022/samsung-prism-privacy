import 'dotenv/config'
import { prisma } from '../config/prisma.js'
import { logger } from '../lib/logger.js'
import { UNRESOLVED_PHOTO_WHERE } from '../lib/photoState.js'
import { enqueueRedaction, getRedactionQueue, REDACTION_QUEUE_NAME } from '../lib/redactionQueue.js'
import { enqueueRecognition, getFaceQueue, FACE_QUEUE_NAME } from '../lib/faceQueue.js'
import { promoteIfRedacted, enqueueUnresolvedPhotos } from '../modules/sessions/session.service.js'
import { withAdvisoryLock, LOCK_NAMESPACE } from '../lib/advisoryLock.js'
import { writeAuditLog } from '../lib/auditLog.js'

// The thing that was missing.
//
// The pipeline had no reaper, no stalled-job timeout surfaced anywhere, and no
// screen that showed one. What that produced, measured on the live system:
//
//   session COL-7224   PROCESSING since 2026-08-19T20:00Z   ~2 days
//   oldest PENDING photo                                    16 days
//   recognitionJob     DONE 5 · RUNNING 1
//   photo piiStatus    CLEAN 83 · PENDING 27  (0 DEFERRED, 0 FAILED)
//
// Nothing was retrying any of it and nothing was reporting it. A queue whose
// failures are invisible is a queue that silently loses work, and in a
// compliance product the work it loses is redaction.
//
// This process sweeps on an interval and does four things, in order of how bad
// the thing it fixes is:
//
//   1. Re-queues photos that are not terminal and have no live job.
//   2. Promotes REDACTING sessions that have become eligible for ARCHIVED.
//   3. Re-queues recognition jobs stuck in RUNNING past the threshold.
//   4. Records everything it found, so the operator screen has data.
//
// It never deletes and it never marks anything FAILED. Its whole job is to
// notice and to retry; a human decides the rest.

const SWEEP_INTERVAL_MS = Number(process.env.REAPER_INTERVAL_MS ?? 5 * 60_000)

// A recognition job RUNNING longer than this is stuck. Generous, because a
// large session legitimately takes a while and re-queuing a healthy job costs a
// full re-run.
const RECOGNITION_STUCK_MS = Number(process.env.REAPER_RECOGNITION_STUCK_MS ?? 30 * 60_000)

// A photo that has been unresolved this long with no job in flight has been
// forgotten by something.
const PHOTO_STUCK_MS = Number(process.env.REAPER_PHOTO_STUCK_MS ?? 15 * 60_000)

async function sweepUnresolvedPhotos() {
  const cutoff = new Date(Date.now() - PHOTO_STUCK_MS)

  const stuck = await prisma.photo.findMany({
    where: { ...UNRESOLVED_PHOTO_WHERE, createdAt: { lt: cutoff } },
    select: { id: true, sessionId: true, piiStatus: true, createdAt: true },
    take: 500,
  })

  if (stuck.length === 0) return { requeued: 0, oldestAgeMs: 0 }

  // Only re-queue what is not already queued. A photo with a live job does not
  // need another; BullMQ dedupes on jobId anyway, but asking first keeps the
  // log honest about what the reaper actually did.
  const queue = getRedactionQueue()
  let requeued = 0

  for (const photo of stuck) {
    const existing = await queue.getJob(`redact-${photo.id}`).catch(() => null)
    const state = existing ? await existing.getState().catch(() => null) : null
    if (state && ['active', 'waiting', 'delayed'].includes(state)) continue

    // A job sitting in `failed` has exhausted its attempts. Removing it before
    // re-adding is what gives it a fresh set — otherwise the reaper adds
    // nothing and the photo stays stuck forever behind a dead job id.
    if (existing) await existing.remove().catch(() => {})

    await enqueueRedaction({ sessionId: photo.sessionId, photoId: photo.id })
    requeued += 1
  }

  const oldest = stuck.reduce((a, b) => (a.createdAt < b.createdAt ? a : b))
  const oldestAgeMs = Date.now() - oldest.createdAt.getTime()

  if (requeued > 0) {
    logger.warn(
      { requeued, found: stuck.length, oldestAgeDays: Math.round(oldestAgeMs / 86_400_000) },
      'reaper re-queued unresolved photos',
    )
  }

  return { requeued, oldestAgeMs, found: stuck.length }
}

async function sweepRedactingSessions() {
  const sessions = await prisma.session.findMany({
    where: { status: 'REDACTING' },
    select: { id: true, code: true },
    take: 200,
  })

  let promoted = 0
  let waiting = 0

  for (const session of sessions) {
    const result = await promoteIfRedacted(session.id)
    if (result.archived) {
      promoted += 1
    } else {
      waiting += 1
      // Make sure the outstanding frames actually have jobs. A session can end
      // up in REDACTING with nothing queued if Redis was down at finalize.
      await enqueueUnresolvedPhotos(session.id)
    }
  }

  if (promoted > 0) logger.info({ promoted, waiting }, 'reaper promoted sessions to ARCHIVED')
  return { promoted, waiting }
}

async function sweepStuckRecognition() {
  const cutoff = new Date(Date.now() - RECOGNITION_STUCK_MS)

  const stuck = await prisma.recognitionJob.findMany({
    where: { status: 'RUNNING', startedAt: { lt: cutoff } },
    select: { id: true, sessionId: true, startedAt: true, photosDone: true, photosTotal: true },
  })

  if (stuck.length === 0) return { requeued: 0 }

  const queue = getFaceQueue()
  let requeued = 0

  for (const job of stuck) {
    const ageMs = Date.now() - job.startedAt.getTime()

    await prisma.stalledJob.upsert({
      where: { queueName_jobId: { queueName: FACE_QUEUE_NAME, jobId: job.id } },
      create: {
        queueName: FACE_QUEUE_NAME,
        jobId: job.id,
        subjectRef: job.sessionId,
        stalledForMs: BigInt(ageMs),
        lastError: `RUNNING for ${Math.round(ageMs / 60_000)} minutes at ${job.photosDone}/${job.photosTotal} photos`,
      },
      update: { stalledForMs: BigInt(ageMs), state: 'DETECTED', resolvedAt: null },
    })

    const existing = await queue.getJob(job.id).catch(() => null)
    const state = existing ? await existing.getState().catch(() => null) : null
    if (state === 'active') {
      // Genuinely still running and just slow. Recorded above so an operator can
      // see it; not touched, because re-queuing a live job is how you get the
      // concurrent-deleteMany race back.
      continue
    }

    if (existing) await existing.remove().catch(() => {})

    // Reset the row so processSession's own status write is not fighting a
    // RUNNING that nothing owns.
    await prisma.recognitionJob.update({
      where: { id: job.id },
      data: { status: 'QUEUED', startedAt: null, error: 'requeued by reaper after stall' },
    })
    await enqueueRecognition(job.sessionId, job.id)

    await prisma.stalledJob.update({
      where: { queueName_jobId: { queueName: FACE_QUEUE_NAME, jobId: job.id } },
      data: { state: 'REQUEUED', attempts: { increment: 1 } },
    })

    await writeAuditLog({
      entityType: 'Session',
      entityId: job.sessionId,
      action: 'RECOGNITION_REQUEUED_AFTER_STALL',
      payload: { jobId: job.id, stalledForMs: ageMs, photosDone: job.photosDone },
    })

    requeued += 1
    logger.error(
      { jobId: job.id, sessionId: job.sessionId, stalledForMinutes: Math.round(ageMs / 60_000) },
      'reaper re-queued a stalled recognition job',
    )
  }

  return { requeued, found: stuck.length }
}

export async function sweep() {
  // One reaper at a time across every replica. Two concurrent sweeps would both
  // see the same stuck job and both re-queue it, which is the exact duplicate
  // delivery the rest of this phase exists to prevent.
  const { acquired, result } = await withAdvisoryLock(LOCK_NAMESPACE.STORAGE_REAPER, 'reaper', async () => {
    const photos = await sweepUnresolvedPhotos()
    const sessions = await sweepRedactingSessions()
    const recognition = await sweepStuckRecognition()
    return { photos, sessions, recognition, at: new Date().toISOString() }
  })

  if (!acquired) {
    logger.debug('reaper sweep skipped — another replica holds the lock')
    return null
  }
  return result
}

// ---------------------------------------------------------------------------

if (process.argv[1]?.endsWith('reaper.worker.js')) {
  let timer = null
  let running = false

  const tick = async () => {
    if (running) return
    running = true
    try {
      const result = await sweep()
      if (result) logger.info(result, 'reaper sweep complete')
    } catch (err) {
      // A sweep that throws must not kill the process — the next one may well
      // succeed, and a dead reaper is indistinguishable from the state it exists
      // to detect.
      logger.error({ err }, 'reaper sweep failed')
    } finally {
      running = false
    }
  }

  logger.info({ intervalMs: SWEEP_INTERVAL_MS }, 'reaper started')
  tick()
  timer = setInterval(tick, SWEEP_INTERVAL_MS)

  const shutdown = async (signal) => {
    logger.info({ signal }, 'reaper shutting down')
    clearInterval(timer)
    // Let an in-flight sweep finish rather than leaving a session half-promoted.
    for (let i = 0; running && i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 500))
    }
    await prisma.$disconnect()
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

export { REDACTION_QUEUE_NAME, FACE_QUEUE_NAME }
