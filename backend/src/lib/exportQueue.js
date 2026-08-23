import { Queue } from 'bullmq'

export const EXPORT_QUEUE_NAME = 'project-export'

export const exportQueueConnection = {
  url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  maxRetriesPerRequest: null,
}

// Lazy, for the same reason as faceQueue and redactionQueue: constructing a
// BullMQ Queue at module scope dials Redis on import and, with
// maxRetriesPerRequest: null, reconnects forever — which pins an open handle for
// the life of the process and stops a test runner from ever exiting.
let queue = null

export function getExportQueue() {
  if (!queue) queue = new Queue(EXPORT_QUEUE_NAME, { connection: exportQueueConnection })
  return queue
}

export async function closeExportQueue() {
  if (!queue) return
  const q = queue
  queue = null
  await q.close()
}

/**
 * One job per export row.
 *
 * jobId is the export id, so a double-click on the button cannot start two
 * builds of the same archive — which matters more here than elsewhere, because
 * two builds would write the same file concurrently.
 *
 * attempts is 2, not 5: a failed export is visible to the operator with its
 * error, and re-reading several gigabytes of media on a hunch is expensive. The
 * retry that exists covers a transient storage blip, not a broken project.
 */
export async function enqueueProjectExport(exportId) {
  return getExportQueue().add(
    'build-project-export',
    { exportId },
    {
      jobId: `export-${exportId}`,
      attempts: 2,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 50,
      // Failures are kept. An export that could not be built is something a
      // person asked for and did not get.
      removeOnFail: false,
    },
  )
}
