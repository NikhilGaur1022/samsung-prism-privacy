import 'dotenv/config'
import { Worker } from 'bullmq'
import { prisma } from '../config/prisma.js'
import { logger } from '../lib/logger.js'
import { writeAuditLog } from '../lib/auditLog.js'
import { REDACTION_QUEUE_NAME, redactionQueueConnection } from '../lib/redactionQueue.js'
import { redactBystanders } from '../modules/sessions/session.service.js'

// Drains the photos that finalize could not mask, usually because the
// image-pii-worker was down. Until this clears them the photos have no
// redactedPath, the serving routes 409, and the handoff refuses to ingest — so
// this worker is what unblocks a batch, not what protects it.

const CONCURRENCY = Number(process.env.REDACTION_WORKER_CONCURRENCY ?? 2)

async function handle(job) {
  const { sessionId, photoId } = job.data

  const photo = await prisma.photo.findUnique({
    where: { id: photoId },
    select: { id: true, sessionId: true, piiStatus: true, redactedPath: true },
  })

  // The photo may have been erased by a DSAR purge while the job sat in the
  // queue. That is a completed job, not a failure.
  if (!photo) {
    logger.info({ photoId }, 'redaction retry: photo no longer exists — dropping job')
    return { skipped: 'PHOTO_GONE' }
  }
  if (photo.redactedPath && photo.piiStatus !== 'DEFERRED') {
    return { skipped: 'ALREADY_REDACTED' }
  }

  const { written, deferred } = await redactBystanders(sessionId ?? photo.sessionId, {
    photoIds: [photoId],
  })

  if (deferred > 0) {
    // Throwing is what drives BullMQ's backoff. The photo is already marked
    // DEFERRED by redactBystanders, so state is correct either way.
    throw new Error(`redaction still failing for photo ${photoId}`)
  }

  return { written }
}

const worker = new Worker(REDACTION_QUEUE_NAME, handle, {
  connection: redactionQueueConnection,
  concurrency: CONCURRENCY,
})

worker.on('completed', (job, result) => {
  logger.info({ jobId: job.id, result }, 'redaction retry completed')
})

worker.on('failed', async (job, err) => {
  const attemptsMade = job?.attemptsMade ?? 0
  const maxAttempts = job?.opts?.attempts ?? 5

  if (attemptsMade < maxAttempts) {
    logger.warn({ jobId: job?.id, attemptsMade, err }, 'redaction retry failed — will back off')
    return
  }

  // Dead-letter. There is no automatic recovery left, and the photo stays
  // unserveable and unignestable, so the only correct move is to make the
  // failure loud and permanent in the ledger.
  const photoId = job?.data?.photoId
  logger.error({ jobId: job?.id, photoId, err }, 'REDACTION DEAD-LETTERED — photo cannot be masked')

  if (!photoId) return
  try {
    await prisma.photo.update({ where: { id: photoId }, data: { piiStatus: 'FAILED' } })
    await writeAuditLog({
      entityType: 'Photo',
      entityId: photoId,
      action: 'REDACTION_DEAD_LETTERED',
      actorId: null,
      payload: { sessionId: job?.data?.sessionId, attempts: attemptsMade, error: String(err?.message ?? err) },
    })
  } catch (updateErr) {
    logger.error({ err: updateErr, photoId }, 'could not mark photo FAILED after dead-letter')
  }
})

logger.info(`Redaction retry worker listening on "${REDACTION_QUEUE_NAME}" (concurrency ${CONCURRENCY})`)

async function shutdown(signal) {
  logger.info({ signal }, 'redaction worker shutting down')
  await worker.close()
  await prisma.$disconnect()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
