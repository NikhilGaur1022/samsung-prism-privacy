import { prisma } from '../../config/prisma.js'
import { logger } from '../../lib/logger.js'
import { UNRESOLVED_PHOTO_WHERE } from '../../lib/photoState.js'
import { getFaceQueue, FACE_QUEUE_NAME } from '../../lib/faceQueue.js'
import { getRedactionQueue, REDACTION_QUEUE_NAME } from '../../lib/redactionQueue.js'
import { circuitBreakerState } from '../../lib/workerFetch.js'

// What an operator needs to see, in one read.
//
// None of this was visible anywhere. Session COL-7224 sat PROCESSING for two
// days and the oldest PENDING photo for sixteen, and the product's own
// "needs attention" counters reported zero throughout — because they enumerated
// DEFERRED and FAILED, and the real stuck state is PENDING.
//
// Every number here is deliberately computed from the same predicate the rest of
// the system now uses (lib/photoState.js), so the screen and the gate agree.

const EMPTY_COUNTS = { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0, paused: 0 }

async function queueSnapshot(name, queue) {
  try {
    const counts = await queue.getJobCounts(
      'waiting',
      'active',
      'delayed',
      'failed',
      'completed',
      'paused',
    )

    // Age of the oldest waiting job. Depth alone does not distinguish "busy" from
    // "wedged" — a queue of 3 that has not moved in an hour is the emergency, a
    // queue of 300 draining steadily is not.
    const [oldestWaiting] = await queue.getJobs(['waiting'], 0, 0, true)
    const oldestWaitingMs = oldestWaiting?.timestamp ? Date.now() - oldestWaiting.timestamp : null

    const [oldestActive] = await queue.getJobs(['active'], 0, 0, true)
    const oldestActiveMs = oldestActive?.processedOn ? Date.now() - oldestActive.processedOn : null

    return { name, reachable: true, counts, oldestWaitingMs, oldestActiveMs }
  } catch (err) {
    // A queue we cannot read is itself the finding: it means Redis is down, and
    // with Redis down the API keeps answering while every deferred job silently
    // stops being retried.
    logger.error({ err, queue: name }, 'could not read queue counts')
    return { name, reachable: false, counts: EMPTY_COUNTS, oldestWaitingMs: null, oldestActiveMs: null, error: 'unreachable' }
  }
}

export async function getQueueHealth() {
  const [face, redaction] = await Promise.all([
    queueSnapshot(FACE_QUEUE_NAME, getFaceQueue()),
    queueSnapshot(REDACTION_QUEUE_NAME, getRedactionQueue()),
  ])

  const [
    unresolvedPhotos,
    oldestUnresolved,
    redactingSessions,
    runningRecognition,
    oldestRunningRecognition,
    stalled,
    orphanBlobs,
    piiByStatus,
  ] = await Promise.all([
    prisma.photo.count({ where: UNRESOLVED_PHOTO_WHERE }),
    prisma.photo.findFirst({
      where: UNRESOLVED_PHOTO_WHERE,
      orderBy: { createdAt: 'asc' },
      select: { id: true, sessionId: true, piiStatus: true, createdAt: true },
    }),
    prisma.session.count({ where: { status: 'REDACTING' } }),
    prisma.recognitionJob.count({ where: { status: 'RUNNING' } }),
    prisma.recognitionJob.findFirst({
      where: { status: 'RUNNING' },
      orderBy: { startedAt: 'asc' },
      select: { id: true, sessionId: true, startedAt: true, photosDone: true, photosTotal: true },
    }),
    prisma.stalledJob.findMany({
      where: { state: { not: 'RESOLVED' } },
      orderBy: { detectedAt: 'desc' },
      take: 50,
    }),
    prisma.orphanBlob.groupBy({ by: ['state'], _count: { _all: true } }),
    prisma.photo.groupBy({ by: ['piiStatus'], _count: { _all: true } }),
  ])

  const now = Date.now()

  return {
    queues: [face, redaction],
    // The circuit breakers are in-process, so this is this replica's opinion —
    // stated as such rather than presented as global truth.
    workerBreakers: circuitBreakerState(),
    pipeline: {
      unresolvedPhotos,
      oldestUnresolved: oldestUnresolved && {
        ...oldestUnresolved,
        ageMs: now - oldestUnresolved.createdAt.getTime(),
      },
      redactingSessions,
      runningRecognition,
      oldestRunningRecognition: oldestRunningRecognition?.startedAt && {
        ...oldestRunningRecognition,
        ageMs: now - oldestRunningRecognition.startedAt.getTime(),
      },
      photosByPiiStatus: Object.fromEntries(
        piiByStatus.map((r) => [r.piiStatus, r._count._all]),
      ),
    },
    stalledJobs: stalled.map((s) => ({
      ...s,
      stalledForMs: s.stalledForMs === null ? null : Number(s.stalledForMs),
    })),
    orphanBlobs: Object.fromEntries(orphanBlobs.map((r) => [r.state, r._count._all])),
    generatedAt: new Date().toISOString(),
  }
}

/**
 * Re-queues one stuck thing by hand.
 *
 * The reaper does this on an interval; this is the operator's override for the
 * case where they have just fixed the underlying dependency and do not want to
 * wait five minutes to find out whether it worked.
 */
export async function requeueStalled({ queueName, jobId }, admin) {
  const { sweep } = await import('../../workers/reaper.worker.js')

  logger.warn({ queueName, jobId, actorId: admin.id }, 'operator triggered a reaper sweep')
  const result = await sweep()

  return { swept: result !== null, result }
}
