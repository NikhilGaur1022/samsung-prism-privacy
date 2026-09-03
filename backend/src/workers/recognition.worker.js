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

// BullMQ's default lockDuration is 30 seconds. This job iterates every photo in
// a session, calling the face worker once per photo — a job that legitimately
// runs for minutes. Under the default, the queue declared it stalled and
// re-delivered it while the original was still running, and processSession()
// opens by deleting every FaceDetection in the session, so the redelivery wiped
// the first run's in-flight rows and the session finished with a partial
// detection set and no error anywhere. There is now an advisory lock making that
// safe, but the right fix is both: do not create the race, and survive it.
//
// The number is a floor, not a budget. `job.extendLock()` fires after every
// photo, so the real deadline is "60 seconds since the last photo finished",
// which scales with session size in a way no fixed constant does.
const LOCK_DURATION_MS = Number(process.env.RECOGNITION_LOCK_DURATION_MS ?? 60_000)

// How long a stalled job may sit before the reaper takes an interest. Set from
// the lock duration so the two cannot drift apart.
export const RECOGNITION_STALL_THRESHOLD_MS = LOCK_DURATION_MS * 3

export const recognitionWorker = new Worker(
  FACE_QUEUE_NAME,
  async (job) =>
    processSession(job.data.sessionId, job.data.jobId, {
      // Called from two places with two different shapes: `{done, total, faces}`
      // after each photo, and `{videoId, phase}` on a timer while a clip is being
      // analysed — a clip is one await that can run for minutes, so it cannot
      // heartbeat per unit of work the way the photo loop does. Both mean the
      // same thing to the queue, so the payload is passed through to the log
      // rather than destructured into fields only one caller supplies.
      onProgress: async (progress) => {
        try {
          await job.extendLock(job.token, LOCK_DURATION_MS)
        } catch (err) {
          // Losing the lock means the queue already re-delivered this job. The
          // advisory lock will stop the duplicate from corrupting anything, but
          // it has to be visible — a silently-lost lock is how the partial
          // detection sets happened.
          logger.error({ err, jobId: job.id, ...progress }, 'lost the job lock mid-session')
        }
      },
    }),
  {
    connection: faceQueueConnection,
    concurrency: Number(process.env.RECOGNITION_WORKER_CONCURRENCY ?? 1),
    lockDuration: LOCK_DURATION_MS,
    // Fires when BullMQ notices a job whose lock expired. Recorded so the
    // operator screen can show it — before this there was no reaper, no
    // surfaced stalled-job timeout, and no screen: COL-7224 sat PROCESSING for
    // two days with nothing reporting it.
    stalledInterval: 30_000,
    maxStalledCount: 2,
  },
)

recognitionWorker.on('stalled', async (jobId) => {
  logger.error({ jobId }, 'recognition job stalled')
  try {
    await prisma.stalledJob.upsert({
      where: { queueName_jobId: { queueName: FACE_QUEUE_NAME, jobId: String(jobId) } },
      create: { queueName: FACE_QUEUE_NAME, jobId: String(jobId), state: 'DETECTED' },
      update: { state: 'DETECTED', detectedAt: new Date(), resolvedAt: null },
    })
  } catch (err) {
    logger.error({ err, jobId }, 'could not record stalled job')
  }
})

recognitionWorker.on('completed', async (job, result) => {
  logger.info({ jobId: job.id, ...result }, 'recognition job completed')
  try {
    await prisma.stalledJob.updateMany({
      where: { queueName: FACE_QUEUE_NAME, jobId: String(job.id), state: { not: 'RESOLVED' } },
      data: { state: 'RESOLVED', resolvedAt: new Date() },
    })
  } catch {
    /* the operator record is not worth failing a completed job over */
  }
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
