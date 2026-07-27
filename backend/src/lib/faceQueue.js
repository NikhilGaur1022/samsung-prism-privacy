import { Queue } from 'bullmq'

export const FACE_QUEUE_NAME = 'face-recognition'

// Reuses the Redis already in the stack (rate limiter, revocation hotlist).
// BullMQ requires maxRetriesPerRequest: null on its connection.
export const faceQueueConnection = {
  url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  maxRetriesPerRequest: null,
}

// Built on first use, not at import. `new Queue()` dials Redis immediately and,
// with maxRetriesPerRequest: null, reconnects forever — so constructing it at
// module scope meant that merely importing a route module pinned an open handle
// for the life of the process. Invisible in a long-running server; fatal in a
// test runner, where the file can then never exit.
let queue = null

export function getFaceQueue() {
  if (!queue) queue = new Queue(FACE_QUEUE_NAME, { connection: faceQueueConnection })
  return queue
}

export async function closeFaceQueue() {
  if (!queue) return
  const q = queue
  queue = null
  await q.close()
}

export async function enqueueRecognition(sessionId, jobId) {
  return getFaceQueue().add(
    'recognize-session',
    { sessionId, jobId },
    {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 50,
      removeOnFail: 100,
    },
  )
}
