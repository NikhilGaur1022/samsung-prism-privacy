import { createHash } from 'node:crypto'
import { prisma } from '../config/prisma.js'
import { logger } from './logger.js'

// Postgres advisory locks, keyed by a namespace and a uuid.
//
// The pipeline needs these because BullMQ's at-least-once delivery is not a
// theoretical concern here. `processSession()` opens with
// `faceDetection.deleteMany({ where: { photo: { sessionId } } })`, so two
// concurrent runs over the same session do not merely duplicate work — the
// second wipes the first's in-flight rows and the session ends with a partial
// detection set and no error raised. With one worker replica and a 30-second
// lock over a job that makes untimed HTTP calls, that scenario is a stall away.
// At the >1 replica needed for 5,000 images/day it is routine.
//
// Advisory locks rather than a row lock or a Redis mutex: the invariant is about
// the database rows, the lock lives in the same server that owns them, and it is
// released automatically if the connection dies — which is exactly the failure
// this is protecting against. A Redis mutex would need its own liveness story.

// Namespaces are the lock's high 32 bits, so two subsystems can never collide on
// the same uuid. Add to this list rather than passing raw numbers.
export const LOCK_NAMESPACE = {
  RECOGNITION_SESSION: 1,
  REDACTION_SESSION: 2,
  FINALIZE_SESSION: 3,
  PURGE_SUBJECT: 4,
  EXPORT_PROJECT: 5,
  STORAGE_REAPER: 6,
}

// pg_advisory_lock takes (int4, int4). A uuid does not fit, so it is hashed to
// 31 bits. Collisions are possible in principle and harmless in practice: the
// consequence of two different sessions hashing alike is that one waits for the
// other, not that either runs twice.
function keyFor(id) {
  const digest = createHash('sha256').update(String(id)).digest()
  return digest.readUInt32BE(0) & 0x7fffffff
}

/**
 * Runs `fn` while holding an advisory lock, or skips it if someone else holds one.
 *
 * Session-scoped (not transaction-scoped) because the work being guarded spans
 * many separate transactions and a long series of HTTP calls — a transaction
 * held open for that whole window would pin an idle connection and bloat vacuum.
 *
 * @returns {{acquired: boolean, result?: any}} `acquired: false` means another
 *          holder is mid-flight and the caller should treat the job as a
 *          duplicate delivery rather than an error.
 */
export async function withAdvisoryLock(namespace, id, fn) {
  const key = keyFor(id)

  const [{ locked }] = await prisma.$queryRawUnsafe(
    'SELECT pg_try_advisory_lock($1::int, $2::int) AS locked',
    namespace,
    key,
  )

  if (!locked) {
    logger.warn(
      { namespace, id },
      'advisory lock already held — skipping this delivery as a duplicate',
    )
    return { acquired: false }
  }

  try {
    return { acquired: true, result: await fn() }
  } finally {
    // Unlock on the same connection that locked. Prisma's pool can hand a
    // different connection to a later query, which would leave the lock held
    // until the original connection is recycled — so the unlock is best-effort
    // and the session-level lock is backstopped by connection teardown.
    try {
      await prisma.$queryRawUnsafe(
        'SELECT pg_advisory_unlock($1::int, $2::int)',
        namespace,
        key,
      )
    } catch (err) {
      logger.error({ err, namespace, id }, 'could not release advisory lock')
    }
  }
}

/**
 * Transaction-scoped variant, for work that genuinely fits in one transaction.
 * Released by COMMIT or ROLLBACK with no unlock call and no connection-affinity
 * problem, so prefer this whenever the guarded work is a single transaction.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 */
export async function tryAdvisoryXactLock(tx, namespace, id) {
  const [{ locked }] = await tx.$queryRawUnsafe(
    'SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS locked',
    namespace,
    keyFor(id),
  )
  return locked === true
}
