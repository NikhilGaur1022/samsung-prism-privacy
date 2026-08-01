import { Queue } from 'bullmq'

export const REDACTION_QUEUE_NAME = 'redaction-retry'

export const redactionQueueConnection = {
  url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  maxRetriesPerRequest: null,
}

// Lazy for the same reason as faceQueue: constructing a BullMQ Queue at module
// scope opens a Redis connection on import and never lets go of it.
let queue = null

export function getRedactionQueue() {
  if (!queue) {
    queue = new Queue(REDACTION_QUEUE_NAME, { connection: redactionQueueConnection })
  }
  return queue
}

export async function closeRedactionQueue() {
  if (!queue) return
  const q = queue
  queue = null
  await q.close()
}

// Deferred photos are retried on a long exponential backoff. The common cause is
// the image-pii-worker being down, which takes minutes to fix, not milliseconds —
// hammering it every second would only make the restart harder.
//
// jobId is the photo id, so a photo that fails twice does not queue twice.
//
// The separator is a hyphen and must stay one: BullMQ v5 rejects a custom job id
// containing ':' outright ("Custom Id cannot contain :"), because it builds its
// own Redis keys with that delimiter. The colon this used to carry made every
// enqueue throw, which presented as deferred photos never being retried.
export async function enqueueRedaction({ sessionId, photoId }) {
  return getRedactionQueue().add(
    'redact-photo',
    { sessionId, photoId },
    {
      jobId: `redact-${photoId}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 100,
      // Failures are kept: a photo that exhausted its retries is a compliance
      // problem someone has to look at, not queue noise to be swept up.
      removeOnFail: false,
    },
  )
}
