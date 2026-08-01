import 'dotenv/config'
import { Worker } from 'bullmq'
import { prisma } from '../config/prisma.js'
import { logger } from '../lib/logger.js'
import { writeAuditLog } from '../lib/auditLog.js'
import { ITEM_ACTION_QUEUE_NAME, itemActionQueueConnection } from '../lib/itemActionQueue.js'
import { executeAction } from '../modules/dsar/itemAction.service.js'

// Executes the per-item DSAR actions the item grid records.
//
// Deliberately the same executor the inline path uses. Two implementations of
// "delete this item" would eventually disagree, and the disagreement would be
// silent — one of them would be the one that ran.

// Concurrency 1, for the same reason purge.worker.js runs at 1: two deletes can
// land on the same frame (two principals erasing from one photo), and the
// rebuild of the survivors' derivative must not interleave with another job's
// delete of the original.
const CONCURRENCY = 1

async function handle(job) {
  const { actionId } = job.data
  const action = await executeAction(actionId)
  return { actionId, kind: action.kind, status: action.status }
}

const worker = new Worker(ITEM_ACTION_QUEUE_NAME, handle, {
  connection: itemActionQueueConnection,
  concurrency: CONCURRENCY,
})

worker.on('completed', (job, result) => {
  logger.info({ jobId: job.id, result }, 'DSAR item action completed')
})

worker.on('failed', async (job, err) => {
  const attemptsMade = job?.attemptsMade ?? 0
  const maxAttempts = job?.opts?.attempts ?? 3
  const actionId = job?.data?.actionId

  if (attemptsMade < maxAttempts) {
    logger.warn({ jobId: job?.id, attemptsMade, err }, 'item action attempt failed — will retry')
    return
  }

  logger.error(
    { alert: 'ITEM_ACTION_EXHAUSTED_RETRIES', jobId: job?.id, actionId, err },
    'DSAR ITEM ACTION EXHAUSTED RETRIES — the request cannot be closed until an operator resolves it',
  )

  if (!actionId) return
  try {
    const action = await prisma.dsarItemAction.findUnique({ where: { id: actionId } })
    if (!action) return
    // Terminal FAILED with the error text, so the close guard blocks and the
    // operator sees why rather than finding a row stuck in RUNNING forever.
    await prisma.dsarItemAction.update({
      where: { id: actionId },
      data: {
        status: 'FAILED',
        error: String(err?.message ?? err),
        completedAt: new Date(),
      },
    })
    await writeAuditLog({
      entityType: 'DsarRequest',
      entityId: action.dsarRequestId,
      action: 'DSAR_ITEM_ACTION_EXHAUSTED_RETRIES',
      actorId: null,
      payload: { actionId, kind: action.kind, attempts: attemptsMade, error: String(err?.message ?? err) },
    })
  } catch (logErr) {
    logger.error({ err: logErr, actionId }, 'could not record item action dead-letter')
  }
})

logger.info(`DSAR item action worker listening on "${ITEM_ACTION_QUEUE_NAME}" (concurrency ${CONCURRENCY})`)

async function shutdown(signal) {
  logger.info({ signal }, 'item action worker shutting down')
  await worker.close()
  await prisma.$disconnect()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
