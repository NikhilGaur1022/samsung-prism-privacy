import 'dotenv/config'
import { Worker } from 'bullmq'
import { prisma } from '../config/prisma.js'
import { logger } from '../lib/logger.js'
import { EXPORT_QUEUE_NAME, exportQueueConnection } from '../lib/exportQueue.js'
import { buildProjectExport, expireProjectExports } from '../modules/projects/projectExport.service.js'

// Builds project archives off the request path.
//
// Concurrency is 1 by default and that is deliberate: a build reads and stamps
// every image in a project, so two of them at once doubles the memory and halves
// nobody's wait. Raise it only with the storage backend's throughput in mind.
const CONCURRENCY = Number(process.env.EXPORT_WORKER_CONCURRENCY ?? 1)

// A project archive legitimately takes a long time. The lock is extended on
// every progress tick rather than set to some guessed maximum, because "long
// enough for 5,000 images" and "short enough to notice a hang" cannot both be a
// constant.
const LOCK_DURATION_MS = Number(process.env.EXPORT_LOCK_DURATION_MS ?? 5 * 60_000)

const worker = new Worker(
  EXPORT_QUEUE_NAME,
  async (job) => {
    const heartbeat = setInterval(() => {
      job.extendLock(job.token, LOCK_DURATION_MS).catch((err) => {
        logger.error({ err, jobId: job.id }, 'lost the export job lock')
      })
    }, Math.floor(LOCK_DURATION_MS / 3))

    try {
      return await buildProjectExport(job.data.exportId)
    } finally {
      clearInterval(heartbeat)
    }
  },
  {
    connection: exportQueueConnection,
    concurrency: CONCURRENCY,
    lockDuration: LOCK_DURATION_MS,
    stalledInterval: 60_000,
    maxStalledCount: 1,
  },
)

worker.on('completed', (job, result) => {
  logger.info({ jobId: job.id, exportId: job.data.exportId, status: result?.status }, 'export built')
})

worker.on('failed', async (job, err) => {
  logger.error({ err, jobId: job?.id, exportId: job?.data?.exportId }, 'export job failed')

  const attempts = job?.attemptsMade ?? 0
  if (attempts < (job?.opts?.attempts ?? 1)) return

  // Final attempt. The row is already marked FAILED by the service's own catch,
  // but a job that died before reaching that catch — killed mid-build, OOM —
  // would leave the row RUNNING forever with a spinner on the operator's screen.
  if (!job?.data?.exportId) return
  try {
    await prisma.projectExport.updateMany({
      where: { id: job.data.exportId, status: { in: ['QUEUED', 'RUNNING'] } },
      data: {
        status: 'FAILED',
        error: String(err?.message ?? err).slice(0, 1000),
        finishedAt: new Date(),
      },
    })
  } catch (updateErr) {
    logger.error({ err: updateErr }, 'could not mark export FAILED')
  }
})

worker.on('stalled', async (jobId) => {
  logger.error({ jobId }, 'export job stalled')
  try {
    await prisma.stalledJob.upsert({
      where: { queueName_jobId: { queueName: EXPORT_QUEUE_NAME, jobId: String(jobId) } },
      create: { queueName: EXPORT_QUEUE_NAME, jobId: String(jobId), state: 'DETECTED' },
      update: { state: 'DETECTED', detectedAt: new Date(), resolvedAt: null },
    })
  } catch (err) {
    logger.error({ err, jobId }, 'could not record stalled export job')
  }
})

// Archives are personal data with a retention clock of their own, and an export
// built before an erasure still contains the erased subject. Nothing about the
// purge path can reach inside a ZIP, so the reconciliation is that the archive's
// life ENDS — this is what ends it.
const EXPIRY_INTERVAL_MS = Number(process.env.EXPORT_EXPIRY_INTERVAL_MS ?? 60 * 60_000)
const expiryTimer = setInterval(() => {
  expireProjectExports()
    .then(({ expired }) => {
      if (expired > 0) logger.info({ expired }, 'expired project export archives')
    })
    .catch((err) => logger.error({ err }, 'export expiry sweep failed'))
}, EXPIRY_INTERVAL_MS)

logger.info(`Project export worker listening on "${EXPORT_QUEUE_NAME}" (concurrency ${CONCURRENCY})`)

async function shutdown(signal) {
  logger.info({ signal }, 'export worker shutting down')
  clearInterval(expiryTimer)
  await worker.close()
  await prisma.$disconnect()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
