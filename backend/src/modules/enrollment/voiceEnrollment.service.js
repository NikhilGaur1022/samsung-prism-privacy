import { createHash, randomUUID } from 'node:crypto'
import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { writeFile, readFile, deleteFile } from '../../lib/storage.js'
import { encryptEmbeddingForSubject, decryptEmbeddingForSubject } from '../../lib/embeddingCrypto.js'
import { workerFetch, readWorkerError } from '../../lib/workerFetch.js'

const AUDIO_SERVICE_URL = process.env.AUDIO_SERVICE_URL ?? 'http://localhost:8003'
const MAX_PER_SUBJECT = Number(process.env.VOICE_MAX_ENROLLMENTS_PER_SUBJECT ?? 3)

// A speaker embedding taken from a clip this short is dominated by whatever
// phoneme happened to be in it. The worker applies the same floor to a diarised
// turn before it will attempt a match (MIN_UTTERANCE_DURATION); enforcing it at
// enrollment too means a subject cannot register a reference that could never
// match anything, and then be muted in every session for it.
const MIN_DURATION_SEC = Number(process.env.VOICE_ENROLL_MIN_SECONDS ?? 3)

// ECAPA-TDNN's output width. Asserted rather than assumed: a worker upgraded to a
// different model would otherwise write vectors of a new width into the same
// column, and the mismatch would not surface until a Qdrant upsert failed
// mid-session with the roster half-loaded.
export const VOICE_EMBEDDING_DIM = 192

/**
 * Sends one clip to the audio worker for a speaker embedding.
 *
 * Shares a code path with the gallery build's re-derivation for the same reason
 * embedImage does on the face side: both see the same errors and the same
 * dimension check.
 */
export async function embedVoice(buffer, filename = 'voice.wav') {
  const buildForm = () => {
    const f = new FormData()
    f.append('audio', new Blob([buffer]), filename)
    return f
  }

  const res = await workerFetch('audio', `${AUDIO_SERVICE_URL}/api/v1/embed`, { body: buildForm })

  const body = await res.json().catch(() => null)
  if (!res.ok) {
    if (res.status === 400) throw new ApiError(400, body?.detail ?? 'No usable speech in the clip')
    await readWorkerError('audio', res)
    throw new ApiError(502, 'Audio service could not process the clip')
  }

  if (!Array.isArray(body?.embedding) || body.embedding.length !== VOICE_EMBEDDING_DIM) {
    throw new ApiError(
      502,
      `Audio service returned a ${body?.embedding?.length ?? 'missing'}-dimension embedding, expected ${VOICE_EMBEDDING_DIM}`,
    )
  }
  return body
}

export async function createVoiceEnrollment({ subjectId, file, source, capturedBy = null }) {
  const subject = await prisma.subject.findUnique({ where: { masterUserId: subjectId } })
  if (!subject) throw new ApiError(404, 'Subject not found')
  if (subject.status !== 'ACTIVE') {
    throw new ApiError(409, 'Subject is not verified — enrollment is not allowed yet')
  }

  // Same gate as createEnrollment. A voice print is biometric data on the same
  // footing as a face embedding, so it rests on the same consent signal —
  // `Subject.biometricMatch` is still the only biometric-specific one that
  // exists. Withdrawing it must therefore destroy voice enrollments too, which
  // is why setBiometricConsent now calls deleteAllVoiceEnrollments.
  if (subject.biometricMatch !== true) {
    throw new ApiError(409, 'Biometric matching consent not given')
  }

  const liveCount = await prisma.subjectVoiceEnrollment.count({
    where: { subjectId, deletedAt: null },
  })
  if (liveCount >= MAX_PER_SUBJECT) {
    throw new ApiError(409, `At most ${MAX_PER_SUBJECT} voice clips can be enrolled per person`)
  }

  const sha256 = createHash('sha256').update(file.buffer).digest('hex')
  const existing = await prisma.subjectVoiceEnrollment.findFirst({
    where: { subjectId, sha256, deletedAt: null },
  })
  if (existing) return { duplicate: true, enrollment: existing }

  const result = await embedVoice(file.buffer, file.originalname ?? 'voice.wav')

  if (result.duration_sec != null && result.duration_sec < MIN_DURATION_SEC) {
    throw new ApiError(
      400,
      `Clip is too short — record at least ${MIN_DURATION_SEC} seconds of continuous speech`,
    )
  }

  const audioPath = `voice-enrollments/${subjectId}/${randomUUID()}.wav`
  await writeFile(audioPath, file.buffer)

  // Sealed under the subject's OWN DEK, not the global key. Two reasons, both
  // the same as for a face enrollment: destroying that DEK is what crypto-shreds
  // the biometric on erasure, and the gallery build reads it back with
  // decryptEmbeddingForSubject. A globally-keyed row would be readable but not
  // shreddable, which is the whole point of the column.
  const { buffer: sealedEmbedding, keyId } = await encryptEmbeddingForSubject(
    result.embedding,
    subjectId,
  )

  const enrollment = await prisma.subjectVoiceEnrollment.create({
    data: {
      subjectId,
      audioPath,
      sha256,
      mimeType: file.mimetype ?? 'audio/wav',
      sizeBytes: file.size ?? file.buffer.length,
      durationSec: result.duration_sec ?? null,
      source,
      capturedBy,
      embedding: sealedEmbedding,
      embeddingDim: result.embedding.length,
      encKeyId: keyId,
    },
  })

  await writeAuditLog({
    entityType: 'Subject',
    entityId: subjectId,
    action: 'VOICE_ENROLLMENT_CAPTURED',
    actorId: capturedBy,
    payload: { enrollmentId: enrollment.id, source, durationSec: result.duration_sec ?? null },
  })

  return { duplicate: false, enrollment }
}

// The select is explicit for one reason: `embedding` must never appear in an API
// response. Do not replace this with a bare findMany.
export async function listVoiceEnrollments(subjectId) {
  const rows = await prisma.subjectVoiceEnrollment.findMany({
    where: { subjectId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, durationSec: true, source: true, createdAt: true },
  })
  return { items: rows, max: MAX_PER_SUBJECT }
}

export async function getVoiceEnrollmentStatus(subjectId) {
  const subject = await prisma.subject.findUnique({ where: { masterUserId: subjectId } })
  if (!subject) throw new ApiError(404, 'Subject not found')

  const count = await prisma.subjectVoiceEnrollment.count({
    where: { subjectId, deletedAt: null },
  })

  return {
    biometricConsent: subject.biometricMatch === true,
    verified: subject.status === 'ACTIVE',
    count,
    max: MAX_PER_SUBJECT,
    // One good clip is enough to match on, unlike faces where a single pose only
    // matches that pose back. More clips widen the acoustic conditions covered.
    complete: count >= 1,
  }
}

export async function deleteVoiceEnrollment(subjectId, enrollmentId, actorId) {
  const enrollment = await prisma.subjectVoiceEnrollment.findFirst({
    where: { id: enrollmentId, subjectId },
  })
  if (!enrollment) throw new ApiError(404, 'Voice enrollment not found')
  if (enrollment.deletedAt) return

  await deleteFile(enrollment.audioPath)
  await prisma.subjectVoiceEnrollment.update({
    where: { id: enrollmentId },
    // The tombstone stays for the audit chain; the biometric does not.
    data: { deletedAt: new Date(), embedding: null, embeddingDim: null },
  })

  await writeAuditLog({
    entityType: 'Subject',
    entityId: subjectId,
    action: 'VOICE_ENROLLMENT_DELETED',
    actorId,
    payload: { enrollmentId },
  })
}

// The single purge chokepoint for voice, mirroring deleteAllEnrollments. Called
// by consent-revoke, by a subject-status change and by a biometric-consent
// withdrawal — do not add a parallel one.
export async function deleteAllVoiceEnrollments(subjectId, actorId, reason) {
  const live = await prisma.subjectVoiceEnrollment.findMany({
    where: { subjectId, deletedAt: null },
  })
  if (live.length === 0) return { count: 0 }

  for (const enrollment of live) {
    await deleteFile(enrollment.audioPath)
  }
  await prisma.subjectVoiceEnrollment.updateMany({
    where: { id: { in: live.map((e) => e.id) } },
    data: { deletedAt: new Date(), embedding: null, embeddingDim: null },
  })

  await writeAuditLog({
    entityType: 'Subject',
    entityId: subjectId,
    action: 'VOICE_ENROLLMENT_PURGED',
    actorId,
    payload: { reason, count: live.length },
  })

  return { count: live.length }
}

/**
 * Stored vector first, clip second — the same order and the same opportunistic
 * backfill as resolveEnrollmentEmbedding() for faces.
 *
 * MUST use the per-subject variant. The keyless decryptEmbedding throws on
 * sealed rows, and on the face side that throw was once caught a frame up and
 * logged as "skipping enrollment", so an entire roster silently resolved to an
 * EMPTY gallery and every subject was blurred as a bystander. The audio
 * equivalent is muting everyone in the room. The keyless call must not appear
 * here.
 */
export async function resolveVoiceEmbedding(enrollment) {
  if (enrollment.embedding) {
    return decryptEmbeddingForSubject(Buffer.from(enrollment.embedding), enrollment.subjectId)
  }

  const buffer = await readFile(enrollment.audioPath)
  const { embedding } = await embedVoice(buffer, `${enrollment.id}.wav`)

  try {
    const { buffer: sealed, keyId } = await encryptEmbeddingForSubject(
      embedding,
      enrollment.subjectId,
    )
    await prisma.subjectVoiceEnrollment.update({
      where: { id: enrollment.id },
      data: { embedding: sealed, embeddingDim: embedding.length, encKeyId: keyId },
    })
  } catch {
    // Non-fatal: the gallery build already has the vector it needs, and the next
    // session simply tries again. Swallowed rather than logged-and-rethrown for
    // the same reason the face path does it — a failed backfill must not fail an
    // analysis that has everything it requires.
  }

  return embedding
}

// Returns the DECRYPTED bytes, never a path. Enrollment clips are sealed on disk
// by storage.writeFile, so handing a route the path would stream ciphertext out
// under Content-Type: audio/wav. Same rule as session media and enrollment
// selfies: media leaves this process as a buffer that went through readFile, or
// it does not leave.
export async function readVoiceEnrollmentAudio(subjectId, enrollmentId) {
  const enrollment = await prisma.subjectVoiceEnrollment.findFirst({
    where: { id: enrollmentId, subjectId, deletedAt: null },
  })
  if (!enrollment) throw new ApiError(404, 'Voice enrollment not found')
  return {
    buffer: await readFile(enrollment.audioPath),
    mimeType: enrollment.mimeType ?? 'audio/wav',
  }
}
