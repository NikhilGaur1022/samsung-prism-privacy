import { Queue } from 'bullmq'

export const FACE_QUEUE_NAME = 'face-recognition'

// Reuses the Redis already in the stack (rate limiter, revocation hotlist).
// BullMQ requires maxRetriesPerRequest: null on its connection.
export const faceQueueConnection = {
  url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  maxRetriesPerRequest: null,
}

export const faceQueue = new Queue(FACE_QUEUE_NAME, { connection: faceQueueConnection })

export async function enqueueRecognition(sessionId, jobId) {
  return faceQueue.add(
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
