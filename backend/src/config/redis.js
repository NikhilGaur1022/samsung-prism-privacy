import Redis from 'ioredis'
import { logger } from '../lib/logger.js'

export const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')

// Without a listener, ioredis prints a raw "Unhandled error event" stack to
// stderr on every reconnection attempt against a dead server — hundreds of them,
// outside the structured log, in a system whose logs are evidence. Attaching one
// makes a Redis outage a single legible line per attempt and keeps the process
// alive, which is correct: the API must keep serving reads while the queues are
// down, and /health/deep is what reports that they are.
redis.on('error', (err) => {
  logger.warn({ err: err.message }, 'redis connection error')
})
