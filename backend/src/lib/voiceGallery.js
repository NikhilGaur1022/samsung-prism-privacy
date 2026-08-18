import { randomUUID } from 'node:crypto'
import { qdrant } from '../config/qdrant.js'
import { logger } from './logger.js'

// The audio counterpart of faceGallery.js, and deliberately the same shape.
//
// DIM is 192, NOT the 512 of faceGallery: SpeechBrain ECAPA-TDNN
// (speechbrain/spkrec-ecapa-voxceleb, see ai-core/audio-worker/speaker_id.py)
// emits a 192-float speaker embedding at 16 kHz. Copying the face dimension here
// would make every upsert fail at Qdrant with a vector-size error.
const DIM = 192

// Keyed by RECORDING, not by session. The face gallery is per-session because it
// is built once at endSession and consumed by one job; audio analysis is a
// per-recording call that can run concurrently for several recordings in the
// same session, and a shared collection name would mean one run tearing down the
// gallery another run is still searching. A per-run collection also cannot go
// stale: an enrollment captured after the session started is in the next
// recording's gallery automatically.
const collectionName = (recordingId) => `voice_${recordingId}`

export const VOICE_GALLERY_PREFIX = 'voice_'

function isNotFound(err) {
  const status = err?.status ?? err?.response?.status
  return status === 404 || /not found|doesn't exist|does not exist/i.test(err?.message ?? '')
}

function isConflict(err) {
  const status = err?.status ?? err?.response?.status
  return status === 409 || /already exists/i.test(err?.message ?? '')
}

export async function createVoiceGallery(recordingId) {
  try {
    await qdrant.createCollection(collectionName(recordingId), {
      vectors: { size: DIM, distance: 'Cosine' },
    })
  } catch (err) {
    // A retried analyze must not blow up on the collection the first attempt
    // already made.
    if (!isConflict(err)) throw err
  }
}

/**
 * One point per live voice enrollment.
 *
 * The payload carries the subject id and nothing else identifying — no name, no
 * email. The gallery is a matching structure, and a hit only has to be able to
 * say WHICH principal it is so the backend can look their consent up; carrying a
 * name here would put it in a second store with its own lifetime for no gain.
 */
export async function addVoiceEnrollmentPoints(recordingId, points) {
  if (points.length === 0) return 0
  await qdrant.upsert(collectionName(recordingId), {
    wait: true,
    points: points.map(({ embedding, subjectId, enrollmentId }) => ({
      id: randomUUID(),
      vector: embedding,
      payload: { subjectId, enrollmentId },
    })),
  })
  return points.length
}

/**
 * Best match for one diarised speaker slot, or null.
 *
 * Returns null rather than the nearest point when nothing clears `threshold`,
 * preserving match_speaker()'s contract from speaker_id.py exactly as it moves
 * out of the worker: an unmatched speaker is an unconsented bystander, never
 * "probably the closest one". recording.service.js defaults such a slot to
 * REDACT_VOICE, and that only stays correct while this function refuses to
 * guess.
 */
export async function searchVoiceGallery(recordingId, embedding, threshold) {
  const hits = await qdrant.search(collectionName(recordingId), {
    vector: embedding,
    limit: 1,
    with_payload: true,
  })
  const best = hits[0]
  if (!best || best.score < threshold) {
    return { subjectId: null, score: best?.score ?? 0 }
  }
  return { subjectId: best.payload?.subjectId ?? null, score: best.score }
}

export async function destroyVoiceGallery(recordingId) {
  try {
    await qdrant.deleteCollection(collectionName(recordingId))
  } catch (err) {
    // Best-effort, same as destroyGallery: teardown runs after the analysis has
    // already been written and must never be able to undo it.
    if (!isNotFound(err)) logger.warn({ err, recordingId }, 'destroyVoiceGallery failed')
  }
}

export async function listVoiceGalleryCollections() {
  const { collections } = await qdrant.getCollections()
  return collections.map((c) => c.name).filter((n) => n.startsWith(VOICE_GALLERY_PREFIX))
}
