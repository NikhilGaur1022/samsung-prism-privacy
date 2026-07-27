import { Queue } from 'bullmq'

export const PURGE_QUEUE_NAME = 'dsar-purge'

export const purgeQueueConnection = {
  url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  maxRetriesPerRequest: null,
}

// Lazy for the same reason as faceQueue: constructing a BullMQ Queue at module
// scope opens a Redis connection on import and never lets go of it.
let queue = null

export function getPurgeQueue() {
  if (!queue) queue = new Queue(PURGE_QUEUE_NAME, { connection: purgeQueueConnection })
  return queue
}

export async function closePurgeQueue() {
  if (!queue) return
  const q = queue
  queue = null
  await q.close()
}

// jobId is the purge job id, so requeuing an already-running purge is a no-op
// rather than a second executor racing the first over the same rows.
export async function enqueuePurge(purgeJobId) {
  return getPurgeQueue().add(
    'execute-purge',
    { purgeJobId },
    {
      jobId: `purge:${purgeJobId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 15_000 },
      removeOnComplete: 100,
      // A failed erasure is an SLA problem with a legal deadline attached. It
      // stays in the queue where someone can see it.
      removeOnFail: false,
    },
  )
}
