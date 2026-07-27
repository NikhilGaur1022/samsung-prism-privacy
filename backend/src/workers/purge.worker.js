import 'dotenv/config'
import { Worker } from 'bullmq'
import { prisma } from '../config/prisma.js'
import { logger } from '../lib/logger.js'
import { writeAuditLog } from '../lib/auditLog.js'
import { PURGE_QUEUE_NAME, purgeQueueConnection } from '../lib/purgeQueue.js'
import { executePurgeJob } from '../modules/dsar/purge.service.js'
import { issueCertificate } from '../modules/dsar/certificate.service.js'

// Runs erasures out of band, for the cases where a purge is too large to hold an
// HTTP request open. Deliberately the same executor the synchronous path uses:
// two implementations of "delete everything about this person" would eventually
// disagree, and the disagreement would be silent.

// Concurrency 1 on purpose. Two purges running at once can touch the same photo —
// one subject erasing from a photo the other also appears in — and the rebuild of
// the survivors' derivative must not interleave with another job's delete of the
// original.
const CONCURRENCY = 1

async function handle(job) {
  const { purgeJobId } = job.data

  const finished = await executePurgeJob(purgeJobId)

  if (finished.status !== 'COMPLETED') {
    // Throwing drives the retry. The partial state is already persisted per
    // location, so the retry resumes rather than restarting.
    throw new Error(`purge ${purgeJobId} finished ${finished.status}: ${finished.error ?? 'incomplete'}`)
  }

  const certificate = await issueCertificate(finished.id)

  await prisma.dsarRequest.update({
    where: { id: finished.dsarRequestId },
    data: { status: 'REVIEW' },
  })

  return { purgeJobId, certificateId: certificate.id }
}

const worker = new Worker(PURGE_QUEUE_NAME, handle, {
  connection: purgeQueueConnection,
  concurrency: CONCURRENCY,
})

worker.on('completed', (job, result) => {
  logger.info({ jobId: job.id, result }, 'purge completed and certified')
})

worker.on('failed', async (job, err) => {
  const attemptsMade = job?.attemptsMade ?? 0
  const maxAttempts = job?.opts?.attempts ?? 3
  const purgeJobId = job?.data?.purgeJobId

  if (attemptsMade < maxAttempts) {
    logger.warn({ jobId: job?.id, attemptsMade, err }, 'purge attempt failed — will retry')
    return
  }

  logger.error({ jobId: job?.id, purgeJobId, err }, 'PURGE EXHAUSTED RETRIES — SLA at risk, needs an operator')

  if (!purgeJobId) return
  try {
    const purge = await prisma.purgeJob.findUnique({ where: { id: purgeJobId } })
    if (!purge) return
    await writeAuditLog({
      entityType: 'DsarRequest',
      entityId: purge.dsarRequestId,
      action: 'PURGE_EXHAUSTED_RETRIES',
      actorId: null,
      payload: { purgeJobId, attempts: attemptsMade, error: String(err?.message ?? err) },
    })
  } catch (logErr) {
    logger.error({ err: logErr, purgeJobId }, 'could not record purge dead-letter')
  }
})

logger.info(`Purge worker listening on "${PURGE_QUEUE_NAME}" (concurrency ${CONCURRENCY})`)

async function shutdown(signal) {
  logger.info({ signal }, 'purge worker shutting down')
  await worker.close()
  await prisma.$disconnect()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
