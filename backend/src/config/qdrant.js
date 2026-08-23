import { QdrantClient } from '@qdrant/js-client-rest'
import { logger } from '../lib/logger.js'

// Every Qdrant call this process makes goes through the retrying proxy below.
//
// The finding this exists for: a voice-gallery search failed with
// `read ECONNRESET` at the END of a 199-second /analyze — after diarisation,
// transcription and four speaker embeddings had all completed. The whole
// request 500'd and the work was thrown away, because a pooled keep-alive
// socket had gone stale while the audio worker was busy and undici handed back
// the reset on first use.
//
// That is the classic idle-keep-alive race, and it is not rare here: the
// pipeline's shape is "make one Qdrant call, go away for minutes, make another".
// A single retry on a fresh connection turns a lost three-minute job into an
// invisible hiccup.
//
// Deliberately NOT retried: anything the server actually answered. A 4xx is
// Qdrant telling us the request was wrong, and repeating it produces the same
// answer more slowly. Only transport-level failures — where no response was
// ever received — are retried, which also makes the retry safe for the
// non-idempotent calls (`upsert` with explicit point ids is idempotent; a
// request that never reached the server changed nothing either way).

const RETRIES = Number.parseInt(process.env.QDRANT_RETRIES ?? '2', 10)

// undici surfaces the cause on `err.cause`, and the code lives there rather than
// on the TypeError it wraps.
const TRANSIENT = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
])

function isTransient(err) {
  for (let e = err; e; e = e.cause) {
    if (e.code && TRANSIENT.has(e.code)) return true
    if (typeof e.message === 'string' && /socket hang up|other side closed|fetch failed/i.test(e.message)) {
      return true
    }
    if (e === e.cause) break
  }
  return false
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const base = new QdrantClient({ url: process.env.QDRANT_URL })

/**
 * The client, with transport failures retried.
 *
 * A Proxy rather than a hand-written façade so a method this codebase does not
 * use yet cannot quietly bypass the retry the day someone reaches for it.
 */
export const qdrant = new Proxy(base, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver)
    if (typeof value !== 'function') return value

    return async function retrying(...args) {
      let lastError
      for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
        try {
          return await value.apply(target, args)
        } catch (err) {
          if (!isTransient(err)) throw err
          lastError = err
          if (attempt === RETRIES) break
          // Short and jittered. A reset socket is replaced on the next request,
          // so this is about giving the pool a moment, not about backing off a
          // loaded server.
          await sleep(Math.random() * Math.min(2 ** attempt * 100, 1000))
          logger.warn(
            { op: String(prop), attempt: attempt + 1, err: err?.message },
            'qdrant call failed on the transport, retrying',
          )
        }
      }
      throw lastError
    }
  },
})
