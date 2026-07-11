import { randomUUID } from 'node:crypto'
import { logger } from '../lib/logger.js'

export function requestLogger(req, res, next) {
  const correlationId = req.headers['x-correlation-id'] || randomUUID()
  req.correlationId = correlationId
  res.setHeader('x-correlation-id', correlationId)

  const start = Date.now()
  res.on('finish', () => {
    logger.info(
      { correlationId, method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - start },
      'request completed'
    )
  })

  next()
}
