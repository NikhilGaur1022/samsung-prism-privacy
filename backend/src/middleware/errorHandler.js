import { logger } from '../lib/logger.js'

export class ApiError extends Error {
  constructor(statusCode, message, details = undefined) {
    super(message)
    this.statusCode = statusCode
    this.details = details
  }
}

export function errorHandler(err, req, res, _next) {
  if (err.name === 'ZodError') {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.issues,
      correlationId: req.correlationId,
    })
  }

  // Safety net behind subject.service.js's own pre-insert dedupe check, in case
  // of a race between the check and the insert.
  if (err.code === 'P2002') {
    return res.status(409).json({
      error: 'Duplicate value violates a unique constraint',
      details: err.meta,
      correlationId: req.correlationId,
    })
  }

  const statusCode = err.statusCode ?? 500
  if (statusCode >= 500) {
    logger.error({ err, correlationId: req.correlationId }, 'unhandled error')
  }
  res.status(statusCode).json({
    error: err.message ?? 'Internal server error',
    details: err.details,
    correlationId: req.correlationId,
  })
}
