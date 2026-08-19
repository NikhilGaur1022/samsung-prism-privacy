import 'dotenv/config'
import { Worker } from 'bullmq'
import { prisma } from '../config/prisma.js'
import { logger } from '../lib/logger.js'
import { FACE_QUEUE_NAME, faceQueueConnection } from '../lib/faceQueue.js'
import { destroyGallery } from '../lib/faceGallery.js'
import { processSession } from '../modules/sessions/recognition.service.js'

// Queue binding only. The recognition pass itself lives in
// modules/sessions/recognition.service.js so it can be driven directly — by the
// e2e suite, or by an operator re-running a session — without a broker.

export const recognitionWorker = new Worker(
  FACE_QUEUE_NAME,
  async (job) => processSession(job.data.sessionId, job.data.jobId),
  { connection: faceQueueConnection, concurrency: 1 },
)

recognitionWorker.on('completed', (job, result) => {
  logger.info({ jobId: job.id, ...result }, 'recognition job completed')
})

recognitionWorker.on('failed', async (job, err) => {
  logger.error({ err, jobId: job?.id }, 'recognition job failed')
  if (!job?.data?.jobId) return

  // Only the final attempt flips the session to FAILED — earlier failures are
  // retried by BullMQ and the agent shouldn't see a scary state in between.
  if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
    // Everything below is best-effort, and the try/catch is the point.
    //
    // This runs inside a BullMQ event listener, where a rejection has no caller
    // to catch it and takes the whole process down with an unhandled rejection.
    // That turned one unprocessable job into a worker that died on every boot:
    // a queue outlives the database rows it points at — a session erased by a
    // DSAR purge, or dropped in a dev reset, leaves its job behind — and the
    // P2025 from updating a row that is gone killed the worker before it could
    // reach any of the healthy jobs behind it. A job whose session no longer
    // exists needs no status written; there is nothing left to mark FAILED.
    try {
      await prisma.recognitionJob.update({
        where: { id: job.data.jobId },
        data: { status: 'FAILED', error: err.message, finishedAt: new Date() },
      })
      await prisma.session.update({
        where: { id: job.data.sessionId },
        data: { status: 'FAILED' },
      })
      // A FAILED session is never finalized, so nothing else would ever drop its
      // gallery — tear it down here or the vectors outlive the job that needed them.
      await destroyGallery(job.data.sessionId)
    } catch (handlerErr) {
      logger.error(
        { err: handlerErr, jobId: job.data.jobId, sessionId: job.data.sessionId },
        'could not record recognition failure — session or job row is gone',
      )
      // The gallery is still ours to clean up even when the rows have vanished,
      // and leaking biometric vectors is the worse of the two failures.
      await destroyGallery(job.data.sessionId).catch(() => {})
    }
  }
})

logger.info(`Recognition worker listening on queue "${FACE_QUEUE_NAME}"`)
