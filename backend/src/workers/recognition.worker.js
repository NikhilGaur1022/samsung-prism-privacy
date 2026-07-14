import 'dotenv/config'
import { Worker } from 'bullmq'
import sharp from 'sharp'
import { prisma } from '../config/prisma.js'
import { logger } from '../lib/logger.js'
import { writeAuditLog } from '../lib/auditLog.js'
import { readFile, writeFile } from '../lib/storage.js'
import { FACE_QUEUE_NAME, faceQueueConnection } from '../lib/faceQueue.js'

const FACE_SERVICE_URL = process.env.FACE_SERVICE_URL ?? 'http://localhost:8001'

// Cosine similarity on L2-normalised ArcFace embeddings. 0.40 is the usual
// same-person threshold for buffalo_l; lower splits one person into several
// clusters (annoying but safe), higher merges two people into one (a tagging
// error that would mislabel someone's photos — so we bias low deliberately).
const CLUSTER_THRESHOLD = Number(process.env.FACE_CLUSTER_THRESHOLD ?? 0.4)
const CROP_PADDING = 0.25

function cosine(a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

// Single-pass greedy clustering against running centroids. O(faces × clusters),
// which is fine at session scale (tens of photos, low hundreds of faces) and
// avoids pulling in a full hierarchical-clustering dependency.
function clusterFaces(faces) {
  const clusters = []

  for (const face of faces) {
    let best = null
    let bestScore = CLUSTER_THRESHOLD

    for (const cluster of clusters) {
      const score = cosine(face.embedding, cluster.centroid)
      if (score > bestScore) {
        bestScore = score
        best = cluster
      }
    }

    if (best) {
      best.members.push(face)
      const n = best.members.length
      best.centroid = best.centroid.map((v, i) => v + (face.embedding[i] - v) / n)
      const norm = Math.hypot(...best.centroid)
      best.centroid = best.centroid.map((v) => v / norm)
    } else {
      clusters.push({ centroid: [...face.embedding], members: [face] })
    }
  }

  return clusters
}

async function detectFaces(buffer, filename) {
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: 'image/jpeg' }), filename)

  const res = await fetch(`${FACE_SERVICE_URL}/detect`, { method: 'POST', body: form })
  if (!res.ok) {
    throw new Error(`Face service returned ${res.status}: ${await res.text()}`)
  }
  const body = await res.json()
  return body.faces ?? []
}

async function cropFace(photoBuffer, bbox, meta) {
  const [x1, y1, x2, y2] = bbox
  const w = x2 - x1
  const h = y2 - y1
  const padX = w * CROP_PADDING
  const padY = h * CROP_PADDING

  const left = Math.max(0, Math.round(x1 - padX))
  const top = Math.max(0, Math.round(y1 - padY))
  const width = Math.min(meta.width - left, Math.round(w + padX * 2))
  const height = Math.min(meta.height - top, Math.round(h + padY * 2))

  return sharp(photoBuffer)
    .extract({ left, top, width: Math.max(1, width), height: Math.max(1, height) })
    .resize(256, 256, { fit: 'cover' })
    .jpeg({ quality: 88 })
    .toBuffer()
}

async function processSession(sessionId, jobId) {
  await prisma.recognitionJob.update({
    where: { id: jobId },
    data: { status: 'RUNNING', startedAt: new Date() },
  })

  const photos = await prisma.photo.findMany({ where: { sessionId } })

  // Reruns must not stack duplicate faces on top of the previous attempt.
  await prisma.faceDetection.deleteMany({ where: { photo: { sessionId } } })
  await prisma.faceCluster.deleteMany({ where: { sessionId } })

  const detected = []
  let done = 0

  for (const photo of photos) {
    const buffer = await readFile(photo.storagePath)
    const meta = await sharp(buffer).metadata()
    const faces = await detectFaces(buffer, `${photo.id}.jpg`)

    for (const face of faces) {
      const record = await prisma.faceDetection.create({
        data: {
          photoId: photo.id,
          bbox: face.bbox,
          detScore: face.det_score ?? null,
        },
      })

      const cropPath = `sessions/${sessionId}/crops/${record.id}.jpg`
      await writeFile(cropPath, await cropFace(buffer, face.bbox, meta))
      await prisma.faceDetection.update({ where: { id: record.id }, data: { cropPath } })

      detected.push({
        id: record.id,
        detScore: face.det_score ?? 0,
        embedding: face.embedding,
      })
    }

    done += 1
    await prisma.recognitionJob.update({
      where: { id: jobId },
      data: { photosDone: done, facesFound: detected.length },
    })
  }

  const clusters = clusterFaces(detected)

  for (const cluster of clusters) {
    const rep = cluster.members.reduce((a, b) => (a.detScore >= b.detScore ? a : b))
    const created = await prisma.faceCluster.create({
      data: { sessionId, repFaceId: rep.id, faceCount: cluster.members.length },
    })
    await prisma.faceDetection.updateMany({
      where: { id: { in: cluster.members.map((m) => m.id) } },
      data: { clusterId: created.id },
    })
  }

  // Embeddings existed only in this function's memory and die with it — they are
  // never written to Postgres or Qdrant, per the session-scoped-only decision.
  detected.length = 0

  await prisma.$transaction([
    prisma.recognitionJob.update({
      where: { id: jobId },
      data: { status: 'DONE', finishedAt: new Date(), photosDone: photos.length },
    }),
    prisma.session.update({ where: { id: sessionId }, data: { status: 'TAGGING' } }),
  ])

  await writeAuditLog({
    entityType: 'Session',
    entityId: sessionId,
    action: 'RECOGNITION_COMPLETED',
    payload: { photos: photos.length, clusters: clusters.length },
  })

  return { photos: photos.length, clusters: clusters.length }
}

export const recognitionWorker = new Worker(
  FACE_QUEUE_NAME,
  async (job) => processSession(job.data.sessionId, job.data.jobId),
  { connection: faceQueueConnection, concurrency: 1 },
)

recognitionWorker.on('completed', (job, result) => {
  logger.info({ jobId: job.id, ...result }, 'recognition job completed')
})

recognitionWorker.on('failed', async (job, err) => {
  logger.error({ err, jobId: job?.id }, 'recognition job failed')
  if (!job?.data?.jobId) return

  // Only the final attempt flips the session to FAILED — earlier failures are
  // retried by BullMQ and the agent shouldn't see a scary state in between.
  if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
    await prisma.recognitionJob.update({
      where: { id: job.data.jobId },
      data: { status: 'FAILED', error: err.message, finishedAt: new Date() },
    })
    await prisma.session.update({
      where: { id: job.data.sessionId },
      data: { status: 'FAILED' },
    })
  }
})

logger.info(`Recognition worker listening on queue "${FACE_QUEUE_NAME}"`)
