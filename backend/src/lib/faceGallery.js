import { randomUUID } from 'node:crypto'
import { qdrant } from '../config/qdrant.js'
import { logger } from './logger.js'

// One Qdrant collection per session, built at endSession and destroyed at finalize.
// Nothing here outlives the session: the enrollment selfies are the durable record,
// the vectors are a derivative that exists for the minutes the job takes to run.
const DIM = 512
const collectionName = (sessionId) => `session_${sessionId}`

export const GALLERY_PREFIX = 'session_'

function isNotFound(err) {
  const status = err?.status ?? err?.response?.status
  return status === 404 || /not found|doesn't exist|does not exist/i.test(err?.message ?? '')
}

function isConflict(err) {
  const status = err?.status ?? err?.response?.status
  return status === 409 || /already exists/i.test(err?.message ?? '')
}

export async function createGallery(sessionId) {
  try {
    await qdrant.createCollection(collectionName(sessionId), {
      vectors: { size: DIM, distance: 'Cosine' },
    })
  } catch (err) {
    // Re-running endSession after a failed job must not blow up on the collection
    // that the first attempt already made.
    if (!isConflict(err)) throw err
  }
}

export async function galleryExists(sessionId) {
  try {
    await qdrant.getCollection(collectionName(sessionId))
    return true
  } catch {
    return false
  }
}

export async function addEnrollmentPoint(
  sessionId,
  { embedding, masterUserId, consentId, fullName, enrollmentId },
) {
  await qdrant.upsert(collectionName(sessionId), {
    wait: true,
    points: [
      {
        id: randomUUID(),
        vector: embedding,
        payload: { masterUserId, consentId, fullName, enrollmentId },
      },
    ],
  })
}

// Returns raw scored hits. Thresholding lives in the worker so all three bands
// (auto-tag / suggest / unidentified) are visible in one place.
export async function searchGallery(sessionId, embedding, limit = 1) {
  const hits = await qdrant.search(collectionName(sessionId), {
    vector: embedding,
    limit,
    with_payload: true,
  })
  return hits.map((h) => ({ score: h.score, payload: h.payload }))
}

export async function destroyGallery(sessionId) {
  try {
    await qdrant.deleteCollection(collectionName(sessionId))
  } catch (err) {
    // Teardown is best-effort by design: it runs after a finalize transaction has
    // already committed and must never be able to undo it.
    if (!isNotFound(err)) logger.warn({ err, sessionId }, 'destroyGallery failed')
  }
}

export async function listGalleryCollections() {
  const { collections } = await qdrant.getCollections()
  return collections.map((c) => c.name).filter((n) => n.startsWith(GALLERY_PREFIX))
}
