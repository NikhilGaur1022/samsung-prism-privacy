import { logger } from './logger.js'
import { ApiError } from '../middleware/errorHandler.js'

// Every HTTP call this API makes to a Python worker goes through here.
//
// The finding this exists for: `AbortSignal`, `AbortController` and `timeout`
// appeared zero times in backend/src. All ten `fetch()` calls to the face, PII,
// audio, text and video workers relied on undici's 300-second default. That is
// not merely slow — it compounds directly with the BullMQ lock. A 300-second
// hang under a 30-second lock means the queue declares the job stalled and
// re-delivers it while the original is still running, and `processSession()`
// opens with `faceDetection.deleteMany()`, so the second run wipes the first
// run's in-flight rows. The result is a partial detection set with no error
// raised anywhere.
//
// Three things happen here that did not happen before:
//
//   1. A per-service deadline, so a hung worker fails in seconds rather than
//      minutes and always inside the job's lock.
//   2. Bounded retry with jittered backoff, but ONLY for errors that are safe
//      to retry — a connection refused or a 503, never a 4xx and never a
//      request whose body we have already streamed.
//   3. A circuit breaker per service, so a worker that is down stops being
//      asked once per job. Without it, a dead PII worker turns every finalize
//      into a full timeout ladder, and the queue backs up behind a dependency
//      that is answering instantly with "no".

const DEFAULTS = {
  // Measured worst case + headroom. These are deliberately per-service: a face
  // embed on one image is not the same workload as a video redaction pass, and
  // one global number would either be too tight for video or useless for face.
  face: { timeoutMs: 20_000, retries: 2 },
  pii: { timeoutMs: 30_000, retries: 2 },
  // 300s, not 180s. Diarization + whisper-small + one ECAPA embed per speaker is
  // CPU-bound wherever there is no GPU, and 180s was under the measured cost of a
  // few minutes of multi-speaker audio — so a run that was progressing normally
  // was aborted, retried, and eventually tripped the breaker. The worker warms
  // its models at boot now (ai-core/audio-worker/main.py), which removes the
  // cold-start spike this number kept colliding with; what is left is the honest
  // inference time, and this covers it.
  audio: { timeoutMs: 300_000, retries: 1 },
  text: { timeoutMs: 60_000, retries: 2 },
  video: { timeoutMs: 600_000, retries: 0 },
}

function settingsFor(service) {
  const env = (name, fallback) => {
    const raw = process.env[`WORKER_${service.toUpperCase()}_${name}`]
    const parsed = Number.parseInt(raw ?? '', 10)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
  }
  const base = DEFAULTS[service] ?? { timeoutMs: 30_000, retries: 1 }
  return {
    timeoutMs: env('TIMEOUT_MS', base.timeoutMs),
    retries: env('RETRIES', base.retries),
  }
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------
// Per-service, in-process. In-process is the honest scope: each API replica and
// each worker forms its own opinion about whether a service is reachable, which
// is what they can actually observe. A shared breaker in Redis would be more
// elegant and would add a dependency to the path that exists to survive
// dependencies being down.

const BREAKER_FAILURE_THRESHOLD = 5
const BREAKER_OPEN_MS = 30_000

const breakers = new Map()

function breakerFor(service) {
  if (!breakers.has(service)) {
    breakers.set(service, { failures: 0, openedAt: null })
  }
  return breakers.get(service)
}

function breakerIsOpen(service) {
  const b = breakerFor(service)
  if (b.openedAt === null) return false
  if (Date.now() - b.openedAt >= BREAKER_OPEN_MS) {
    // Half-open: let exactly one request through to find out. The counter is
    // left at the threshold so a single failure re-opens immediately rather
    // than requiring another five.
    b.openedAt = null
    return false
  }
  return true
}

function recordSuccess(service) {
  const b = breakerFor(service)
  b.failures = 0
  b.openedAt = null
}

function recordFailure(service) {
  const b = breakerFor(service)
  b.failures += 1
  if (b.failures >= BREAKER_FAILURE_THRESHOLD && b.openedAt === null) {
    b.openedAt = Date.now()
    logger.error(
      { service, failures: b.failures, openForMs: BREAKER_OPEN_MS },
      'worker circuit breaker opened',
    )
  }
}

/** Test seam — resets breaker state between cases. */
export function resetCircuitBreakers() {
  breakers.clear()
}

export function circuitBreakerState() {
  return Object.fromEntries(
    [...breakers.entries()].map(([service, b]) => [
      service,
      { failures: b.failures, open: b.openedAt !== null },
    ]),
  )
}

// ---------------------------------------------------------------------------

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

class WorkerUnavailableError extends ApiError {
  constructor(service, cause) {
    // 503, not 500: this is a dependency being unreachable, which is a different
    // thing from this process being broken, and the two want different alerts.
    super(503, 'A processing service is unavailable')
    this.name = 'WorkerUnavailableError'
    this.service = service
    this.cause = cause
  }
}

export { WorkerUnavailableError }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * POST to a worker with a deadline, bounded retry and a circuit breaker.
 *
 * @param {string} service  one of face | pii | audio | text | video — selects the
 *                          timeout/retry profile and the breaker bucket.
 * @param {string} url      absolute URL.
 * @param {object} options
 * @param {() => FormData|BodyInit} options.body
 *        A FACTORY, not a value. A FormData carrying a stream cannot be sent
 *        twice, so a retry needs a fresh one; taking a factory makes that
 *        impossible to get wrong at the call site.
 * @param {string} [options.method='POST']
 * @param {Record<string,string>} [options.headers]
 * @param {number} [options.timeoutMs] override the per-service default.
 * @returns {Promise<Response>} a Response with a 2xx status.
 */
export async function workerFetch(service, url, { body, method = 'POST', headers, timeoutMs } = {}) {
  const settings = settingsFor(service)
  const deadline = timeoutMs ?? settings.timeoutMs

  if (breakerIsOpen(service)) {
    throw new WorkerUnavailableError(service, new Error('circuit breaker open'))
  }

  let lastError
  for (let attempt = 0; attempt <= settings.retries; attempt += 1) {
    if (attempt > 0) {
      // Exponential with full jitter. Jitter matters here because the retries
      // are driven by a queue: without it, every job that failed against a
      // restarting worker retries in lockstep and knocks it over again.
      const backoff = Math.min(2 ** attempt * 250, 4000)
      await sleep(Math.random() * backoff)
    }

    const started = Date.now()
    try {
      const response = await fetch(url, {
        method,
        ...(headers && { headers }),
        ...(body && { body: typeof body === 'function' ? body() : body }),
        signal: AbortSignal.timeout(deadline),
      })

      if (response.ok) {
        recordSuccess(service)
        return response
      }

      // A 4xx is the worker telling us the request was wrong. Retrying it will
      // produce the same answer and burn the job's lock doing so.
      if (!RETRYABLE_STATUS.has(response.status)) {
        recordSuccess(service) // it answered; the service is up
        return response
      }

      lastError = new Error(`${service} responded ${response.status}`)
      logger.warn(
        { service, url, status: response.status, attempt, elapsedMs: Date.now() - started },
        'worker call failed, will retry',
      )
    } catch (err) {
      lastError = err
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      logger.warn(
        { service, url, attempt, timedOut, elapsedMs: Date.now() - started, err: err?.message },
        'worker call errored, will retry',
      )
    }
  }

  recordFailure(service)
  throw new WorkerUnavailableError(service, lastError)
}

/**
 * Reads a worker's error body without letting it reach the client.
 *
 * The workers return `{detail: "..."}` on failure, and those strings were being
 * forwarded verbatim — one of them carried a live `BytesIO` heap address, and
 * `enrollment.service.js` attached `connect ECONNREFUSED 127.0.0.1:8001`, which
 * publishes the internal service topology. Log it, return a short opaque tag.
 */
export async function readWorkerError(service, response) {
  let detail
  try {
    const text = await response.text()
    try {
      detail = JSON.parse(text)?.detail ?? text
    } catch {
      detail = text
    }
  } catch {
    detail = '(unreadable body)'
  }

  logger.error({ service, status: response.status, detail }, 'worker returned an error')
  return `${service}:${response.status}`
}
