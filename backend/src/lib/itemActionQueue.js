import { Queue } from 'bullmq'

export const ITEM_ACTION_QUEUE_NAME = 'dsar-item-action'

export const itemActionQueueConnection = {
  url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  maxRetriesPerRequest: null,
}

// Lazy for the same reason as the other queues: constructing a BullMQ Queue at
// module scope opens a Redis connection on import and never lets go of it, which
// is what makes a test file hang instead of exit.
let queue = null

export function getItemActionQueue() {
  if (!queue) queue = new Queue(ITEM_ACTION_QUEUE_NAME, { connection: itemActionQueueConnection })
  return queue
}

export async function closeItemActionQueue() {
  if (!queue) return
  const q = queue
  queue = null
  await q.close()
}

/**
 * One job per action row, keyed on the action id.
 *
 * jobId is the action id so a double-submitted bulk batch — which collapses onto
 * the same DsarItemAction rows via the unique constraint — also collapses onto
 * the same jobs. Two executors racing over one delete is the failure mode this
 * closes.
 */
export async function enqueueItemAction(actionId) {
  return getItemActionQueue().add(
    'execute-item-action',
    { actionId },
    {
      // Hyphen, not colon — BullMQ v5 rejects ':' in a custom job id.
      jobId: `item-action-${actionId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 15_000 },
      removeOnComplete: 200,
      // A failed action inside a DSAR is a compliance obligation someone has to
      // look at, not queue noise to be swept up.
      removeOnFail: false,
    },
  )
}
