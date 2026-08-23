import sharp from 'sharp'
import { prisma } from '../../config/prisma.js'
import { logger } from '../../lib/logger.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { readFile, writeFile } from '../../lib/storage.js'
import { searchGallery } from '../../lib/faceGallery.js'
import { workerFetch, readWorkerError } from '../../lib/workerFetch.js'
import { withAdvisoryLock, LOCK_NAMESPACE } from '../../lib/advisoryLock.js'
import { deleteRowsAndBlobs } from '../../lib/blobLifecycle.js'
import { CLUSTER_THRESHOLD, MATCH_THRESHOLD, AUTO_TAG_THRESHOLD } from '../../config/faceThresholds.js'
import { analyzeVideo } from '../videos/video.service.js'
import { videoCaptureEnabled } from '../../lib/videoFeature.js'

// Detection, clustering and gallery matching used to live inside
// recognition.worker.js, which builds a BullMQ Worker at module scope — importing
// that file opens a Redis connection as a side effect. The end-to-end suite needs
// to run this pass deterministically, in-process, with no broker in the way, so
// the pass lives here and the worker is now only the queue binding around it.

const FACE_SERVICE_URL = process.env.FACE_SERVICE_URL ?? 'http://localhost:8001'

// The three bands live in config/faceThresholds.js, which validates them, holds
// the ordering invariant (auto-tag must be strictly above suggest) and logs the
// values in force at boot. They were inline here, and the shipped .env disagreed
// with the inline defaults — 0.3/0.5 against 0.38/0.55 — with nothing reporting
// which set was actually applied to a given session's tagging decisions.
//
// Cosine similarity on L2-normalised ArcFace embeddings. 0.40 is the usual
// same-person threshold for buffalo_l; lower splits one person into several
// clusters (annoying but safe), higher merges two people into one (a tagging
// error that would mislabel someone's photos — so we bias low deliberately).
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
  const buildForm = () => {
    const f = new FormData()
    f.append('file', new Blob([buffer], { type: 'image/jpeg' }), filename)
    return f
  }

  const res = await workerFetch('face', `${FACE_SERVICE_URL}/detect`, { body: buildForm })
  if (!res.ok) {
    throw new Error(`face detect failed: ${await readWorkerError('face', res)}`)
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

/**
 * The recognition pass for one session.
 *
 * Wrapped in an advisory lock keyed on the session. BullMQ delivers at least
 * once, and this function opens by deleting every FaceDetection in the session
 * — so two concurrent runs do not merely duplicate work, the second wipes the
 * first's in-flight rows and the session ends with a partial detection set and
 * no error raised anywhere. With a 30-second queue lock over a job that made
 * untimed HTTP calls, a stall-and-redeliver was one slow worker away; at the
 * second replica needed for 5,000 images/day it is routine.
 *
 * A duplicate delivery now returns `{ skipped: 'ALREADY_RUNNING' }` rather than
 * racing, which BullMQ treats as a completed job.
 */
export async function processSession(sessionId, jobId, { onProgress } = {}) {
  const { acquired, result } = await withAdvisoryLock(
    LOCK_NAMESPACE.RECOGNITION_SESSION,
    sessionId,
    () => runRecognition(sessionId, jobId, { onProgress }),
  )

  if (!acquired) {
    logger.warn({ sessionId, jobId }, 'recognition already running for this session — skipping')
    return { skipped: 'ALREADY_RUNNING', sessionId }
  }
  return result
}

/**
 * Analyses every clip in the session and appends its identifiable tracks to the
 * shared embedding list, so photo faces and video tracks cluster together.
 *
 * Never throws. A video worker outage must not take the session's photos down
 * with it: analyzeVideo returns null in that case and parks the clip as
 * DEFERRED, which is a state the finalize gate refuses to archive over. The
 * clip is not silently dropped — it is loudly stuck, which is the difference
 * between a delay and a data-protection failure.
 *
 * The dangerous shape being avoided here is a clip whose analysis failed
 * leaving no track boxes: a redaction pass over it would blur nothing and still
 * write a derivative, producing an unmasked clip stamped clean.
 */
async function analyseSessionVideos(sessionId, detected) {
  if (!videoCaptureEnabled()) return { analysed: 0, deferred: 0, tracks: 0, skipped: 'disabled' }

  const videos = await prisma.videoAsset.findMany({
    where: { sessionId },
    select: { id: true },
  })
  if (videos.length === 0) return { analysed: 0, deferred: 0, tracks: 0 }

  let analysed = 0
  let deferred = 0
  let tracks = 0

  for (const video of videos) {
    let result = null
    try {
      result = await analyzeVideo(video.id)
    } catch (err) {
      // analyzeVideo already parks the clip and writes its own audit record; the
      // catch is here so an unexpected throw cannot abort the photo pass that
      // has already completed.
      logger.error({ err, videoId: video.id, sessionId }, 'video analysis threw — clip left unanalysed')
    }

    if (!result) {
      deferred += 1
      continue
    }

    analysed += 1
    tracks += result.tracks.length
    for (const track of result.tracks) detected.push(track)
  }

  if (deferred > 0) {
    logger.warn(
      { alert: 'VIDEO_ANALYSIS_DEFERRED', sessionId, deferred, analysed },
      'clips could not be analysed — the session cannot be archived until they are',
    )
  }

  return { analysed, deferred, tracks }
}

async function runRecognition(sessionId, jobId, { onProgress } = {}) {
  await prisma.recognitionJob.update({
    where: { id: jobId },
    data: { status: 'RUNNING', startedAt: new Date() },
  })

  const photos = await prisma.photo.findMany({ where: { sessionId } })

  // Reruns must not stack duplicate faces on top of the previous attempt — and
  // must not leave the previous attempt's cropped faces on disk. Dropping the
  // rows without the blobs is one of the two confirmed routes by which 383
  // orphaned face crops were manufactured: unreferenced by any row, therefore
  // invisible to DSAR discovery and unreachable by purge, therefore still on
  // disk after a signed deletion certificate said they were gone.
  await deleteRowsAndBlobs({
    reason: 'RECOGNITION_RERUN',
    collectPaths: async (tx) => {
      const previous = await tx.faceDetection.findMany({
        where: { photo: { sessionId } },
        select: { cropPath: true },
      })
      // Track crops are manufactured by exactly the same route and were not
      // being collected: analyzeVideo writes one per track, a rerun deletes the
      // rows, and the JPEGs stay on disk unreferenced — invisible to DSAR
      // discovery and unreachable by purge, which is the orphan class this
      // helper exists to close.
      const tracks = await tx.videoFaceTrack.findMany({
        where: { video: { sessionId } },
        select: { cropPath: true },
      })
      return [...previous.map((f) => f.cropPath), ...tracks.map((t) => t.cropPath)]
    },
    deleteRows: async (tx) => {
      await tx.faceDetection.deleteMany({ where: { photo: { sessionId } } })
      await tx.videoFaceTrack.deleteMany({ where: { video: { sessionId } } })
      await tx.videoPiiSpan.deleteMany({ where: { video: { sessionId } } })
      await tx.faceCluster.deleteMany({ where: { sessionId } })
    },
  })

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

    // Per-photo heartbeat. The worker uses it to call job.extendLock(): the job
    // iterates every photo in the session calling a face worker, and no fixed
    // lockDuration is right for both a five-photo session and a five-hundred.
    // Extending as we go is the only version that scales with the work.
    await onProgress?.({ done, total: photos.length, faces: detected.length })
  }

  // Video joins the same clustering rather than getting a parallel queue.
  //
  // A person who appears in a photo and in a clip is one person, and the agent
  // should tag them once. The schema was built for this — FaceCluster carries
  // videoTrackCount and repTrackId, and VideoFaceTrack.clusterId points at the
  // same cluster a photo face does — but nothing ever called analyzeVideo, so
  // every one of those columns sat at its default and no clip was ever analysed.
  const videoStats = await analyseSessionVideos(sessionId, detected)

  const clusters = clusterFaces(detected)

  let autoTaggedCount = 0
  let suggestedCount = 0
  let unidentifiedCount = 0

  for (const cluster of clusters) {
    const rep = cluster.members.reduce((a, b) => (a.detScore >= b.detScore ? a : b))

    // faceCount stays photo-only on purpose — the portal and the handoff counts
    // already read it, and quietly widening it would have moved numbers on
    // screens nobody was touching. Tracks are counted alongside, never inside.
    const photoMembers = cluster.members.filter((m) => m.kind !== 'track')
    const trackMembers = cluster.members.filter((m) => m.kind === 'track')
    const bestPhoto = photoMembers.length
      ? photoMembers.reduce((a, b) => (a.detScore >= b.detScore ? a : b))
      : null
    const bestTrack = trackMembers.length
      ? trackMembers.reduce((a, b) => (a.detScore >= b.detScore ? a : b))
      : null

    // One gallery probe per person-group, not per face: the running centroid is a
    // cleaner signal than any single frame, and it keeps the decision 1:1 with the
    // card the agent will see.
    let match = null
    try {
      const [top] = await searchGallery(sessionId, cluster.centroid, 1)
      if (top && top.score >= MATCH_THRESHOLD) match = top
    } catch (err) {
      logger.warn({ err, sessionId }, 'gallery search failed — cluster left for manual tagging')
    }

    const subjectId = match?.payload?.masterUserId ?? null
    const autoTagged = Boolean(match && match.score >= AUTO_TAG_THRESHOLD)

    if (autoTagged) autoTaggedCount += 1
    else if (subjectId) suggestedCount += 1
    else unidentifiedCount += 1

    const created = await prisma.faceCluster.create({
      data: {
        sessionId,
        // Null for a clip-only cluster. repFaceId is a FaceDetection id, and
        // writing a track id into it would be a dangling reference that reads
        // as a valid one.
        repFaceId: bestPhoto?.id ?? null,
        // Set when the sharpest representative of this person is a track. A
        // track crop is cut from the best of several frames, so it is often the
        // better card image even when stills exist.
        repTrackId: rep.kind === 'track' ? rep.id : (bestTrack?.id ?? null),
        videoTrackCount: trackMembers.length,
        faceCount: photoMembers.length,
        matchScore: match?.score ?? null,
        autoTagged,
        tagStatus: autoTagged ? 'TAGGED' : 'PENDING',
        taggedSubjectId: autoTagged ? subjectId : null,
        // Set in BOTH bands — an auto-tag the agent later overrides should still
        // show what the model originally suggested.
        suggestedSubjectId: subjectId,
      },
    })

    await prisma.faceDetection.updateMany({
      where: { id: { in: photoMembers.map((m) => m.id) } },
      data: {
        clusterId: created.id,
        ...(autoTagged && { tagStatus: 'TAGGED', taggedSubjectId: subjectId }),
      },
    })

    if (trackMembers.length) {
      // The same decision, applied to the same person's other medium. A track
      // left PENDING here is a track that stays blurred, which is the correct
      // outcome until an agent says otherwise.
      await prisma.videoFaceTrack.updateMany({
        where: { id: { in: trackMembers.map((m) => m.id) } },
        data: {
          clusterId: created.id,
          ...(autoTagged && { tagStatus: 'TAGGED', taggedSubjectId: subjectId }),
        },
      })
    }
  }

  // Embeddings existed only in this function's memory and die with it. They are
  // searched against the ephemeral per-session Qdrant collection above, but no
  // vector from a session photo is ever written anywhere — only the roster's
  // re-derived enrollment vectors live in that collection, and it is destroyed
  // at finalize.
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
    payload: {
      photos: photos.length,
      clusters: clusters.length,
      autoTagged: autoTaggedCount,
      suggested: suggestedCount,
      unidentified: unidentifiedCount,
      videos: videoStats.analysed,
      videosDeferred: videoStats.deferred,
      videoTracks: videoStats.tracks,
    },
  })

  return {
    photos: photos.length,
    clusters: clusters.length,
    autoTagged: autoTaggedCount,
    suggested: suggestedCount,
    unidentified: unidentifiedCount,
  }
}
