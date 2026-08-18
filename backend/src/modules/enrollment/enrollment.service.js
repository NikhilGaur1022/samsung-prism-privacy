import { createHash, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { deleteAllVoiceEnrollments } from './voiceEnrollment.service.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { writeFile, readFile, deleteFile } from '../../lib/storage.js'
import { encryptEmbeddingForSubject } from '../../lib/embeddingCrypto.js'

const FACE_SERVICE_URL = process.env.FACE_SERVICE_URL ?? 'http://localhost:8001'
const MIN_DET_SCORE = Number(process.env.FACE_ENROLL_MIN_DET_SCORE ?? 0.7)
const MAX_PER_SUBJECT = Number(process.env.FACE_MAX_ENROLLMENTS_PER_SUBJECT ?? 3)

export const ENROLLMENT_POSES = ['FRONT', 'LEFT', 'RIGHT', 'UP', 'DOWN']

// A gallery built from one angle only matches that angle back. Three distinct
// poses including a front shot is the point where a head turn stops costing a match.
const REQUIRED_POSES = 3

// Shared by enrollment capture and the per-session gallery build — one code path
// to the face service so both see the same errors and the same quality signal.
export async function embedImage(buffer, filename = 'selfie.jpg') {
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: 'image/jpeg' }), filename)

  let res
  try {
    res = await fetch(`${FACE_SERVICE_URL}/embed`, { method: 'POST', body: form })
  } catch (err) {
    throw new ApiError(503, 'Face service unavailable', { cause: err.message })
  }

  const body = await res.json().catch(() => null)
  if (!res.ok) {
    if (res.status === 400) throw new ApiError(400, body?.detail ?? 'No face detected in the image')
    throw new ApiError(502, `Face service returned ${res.status}`)
  }
  return body
}

export async function createEnrollment({ subjectId, file, source, capturedBy = null, pose = null }) {
  const subject = await prisma.subject.findUnique({ where: { masterUserId: subjectId } })
  if (!subject) throw new ApiError(404, 'Subject not found')
  if (subject.status !== 'ACTIVE') {
    throw new ApiError(409, 'Subject is not verified — enrollment is not allowed yet')
  }

  // TODO: once project_consent_matrix carries a per-purpose biometric flag
  // (backend-plan.md Phase 2), read it here instead. Subject.biometricMatch is
  // the only biometric-specific signal that exists today.
  if (subject.biometricMatch !== true) {
    throw new ApiError(409, 'Biometric matching consent not given')
  }

  const liveCount = await prisma.subjectFaceEnrollment.count({
    where: { subjectId, deletedAt: null },
  })
  if (liveCount >= MAX_PER_SUBJECT) {
    throw new ApiError(409, `At most ${MAX_PER_SUBJECT} photos can be enrolled per person`)
  }

  const result = await embedImage(file.buffer, file.originalname ?? 'selfie.jpg')

  if (result.face_count > 1) {
    throw new ApiError(400, 'More than one face in the photo — retake alone')
  }
  if (result.det_score < MIN_DET_SCORE) {
    throw new ApiError(400, 'Face not clear enough — retake in better light, facing the camera')
  }

  const sha256 = createHash('sha256').update(file.buffer).digest('hex')
  const existing = await prisma.subjectFaceEnrollment.findFirst({
    where: { subjectId, sha256, deletedAt: null },
  })
  if (existing) return { duplicate: true, enrollment: existing }

  // Normalise on the way in so every enrollment image is one orientation, one
  // format and one bounded size regardless of which device shot it.
  const normalised = await sharp(file.buffer)
    .rotate()
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer()
  const meta = await sharp(normalised).metadata().catch(() => ({}))

  const imagePath = `enrollments/${subjectId}/${randomUUID()}.jpg`
  await writeFile(imagePath, normalised)

  // The embedding IS stored, encrypted. Re-deriving it at every session start
  // meant one face-service round trip per enrollment per session and a hard
  // dependency on the worker being up before a gallery could exist at all. It is
  // encrypted at rest, never selected by any endpoint, and cleared on delete.
  // Sealed under the subject's own DEK, not the global key, and stamped with the
  // keyId that sealed it. Two reasons it must be this variant: destroying that DEK
  // is what crypto-shreds the biometric on erasure, and the gallery build reads it
  // back with decryptEmbeddingForSubject — a globally-keyed row written here would
  // be readable, but it would not be shreddable.
  const { buffer: sealedEmbedding, keyId } = await encryptEmbeddingForSubject(
    result.embedding,
    subjectId,
  )

  const enrollment = await prisma.subjectFaceEnrollment.create({
    data: {
      subjectId,
      imagePath,
      sha256,
      detScore: result.det_score,
      width: meta.width ?? null,
      height: meta.height ?? null,
      source,
      capturedBy,
      pose: pose ?? null,
      embedding: sealedEmbedding,
      embeddingDim: result.embedding.length,
      encKeyId: keyId,
    },
  })

  await writeAuditLog({
    entityType: 'Subject',
    entityId: subjectId,
    action: 'ENROLLMENT_CAPTURED',
    actorId: capturedBy,
    payload: { enrollmentId: enrollment.id, source, pose: pose ?? null, detScore: result.det_score },
  })

  return { duplicate: false, enrollment }
}

// The select is explicit for one reason: `embedding` must never appear in an API
// response. Do not replace this with a bare findMany.
export async function listEnrollments(subjectId) {
  const rows = await prisma.subjectFaceEnrollment.findMany({
    where: { subjectId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, detScore: true, source: true, pose: true, createdAt: true },
  })
  return { items: rows, max: MAX_PER_SUBJECT }
}

// Drives both the registration gate and the Consent Hub card. "Complete" is a
// judgement about match quality, not a count: three angles with a front shot.
export async function getEnrollmentStatus(subjectId) {
  const subject = await prisma.subject.findUnique({ where: { masterUserId: subjectId } })
  if (!subject) throw new ApiError(404, 'Subject not found')

  const rows = await prisma.subjectFaceEnrollment.findMany({
    where: { subjectId, deletedAt: null },
    select: { pose: true },
  })

  const poses = [...new Set(rows.map((r) => r.pose).filter(Boolean))]

  return {
    biometricConsent: subject.biometricMatch === true,
    verified: subject.status === 'ACTIVE',
    count: rows.length,
    max: MAX_PER_SUBJECT,
    poses,
    allPoses: ENROLLMENT_POSES,
    complete: poses.includes('FRONT') && poses.length >= REQUIRED_POSES,
  }
}

// Setting Subject.biometricMatch is what unblocks createEnrollment — it is the
// only biometric-specific consent signal that exists today. It is an intake-time
// UX flag: nothing in session, photo or purge logic may read it.
export async function setBiometricConsent(subjectId, accepted) {
  const subject = await prisma.subject.findUnique({ where: { masterUserId: subjectId } })
  if (!subject) throw new ApiError(404, 'Subject not found')
  if (accepted && subject.status !== 'ACTIVE') {
    throw new ApiError(409, 'Verify your email before enabling face matching')
  }

  const updated = await prisma.subject.update({
    where: { masterUserId: subjectId },
    data: { biometricMatch: accepted },
  })

  await writeAuditLog({
    entityType: 'Subject',
    entityId: subjectId,
    action: 'BIOMETRIC_CONSENT_SET',
    actorId: subjectId,
    payload: { accepted },
  })

  // Withdrawing is not just a flag flip — the photos and vectors held on the
  // basis of that consent go with it, through the same purge chokepoint as
  // an all-consent revoke.
  if (!accepted) {
    await deleteAllEnrollments(subjectId, subjectId, 'BIOMETRIC_CONSENT_WITHDRAWN')
    // Voice prints rest on this same flag — `createVoiceEnrollment` refuses to
    // capture one without it — so withdrawing it has to take them too. Leaving
    // them would keep a biometric alive on a consent that no longer exists, and
    // the subject would still be identified by voice in every later session
    // while the UI told them biometric matching was off.
    await deleteAllVoiceEnrollments(subjectId, subjectId, 'BIOMETRIC_CONSENT_WITHDRAWN')
  }

  return { biometricConsent: updated.biometricMatch }
}

export async function deleteEnrollment(subjectId, enrollmentId, actorId) {
  const enrollment = await prisma.subjectFaceEnrollment.findFirst({
    where: { id: enrollmentId, subjectId },
  })
  if (!enrollment) throw new ApiError(404, 'Enrollment not found')
  if (enrollment.deletedAt) return

  await deleteFile(enrollment.imagePath)
  await prisma.subjectFaceEnrollment.update({
    where: { id: enrollmentId },
    // The tombstone stays for the audit chain; the biometric does not.
    data: { deletedAt: new Date(), embedding: null, embeddingDim: null },
  })

  await writeAuditLog({
    entityType: 'Subject',
    entityId: subjectId,
    action: 'ENROLLMENT_DELETED',
    actorId,
    payload: { enrollmentId },
  })
}

// Called by consent-revoke, by a subject-status change, and by a biometric-consent
// withdrawal. The single purge chokepoint — do not add a parallel one. The row is
// kept as a soft-deleted tombstone (the audit chain references it) but the selfie
// is gone from disk and the stored vector is nulled immediately.
export async function deleteAllEnrollments(subjectId, actorId, reason) {
  const live = await prisma.subjectFaceEnrollment.findMany({
    where: { subjectId, deletedAt: null },
  })
  if (live.length === 0) return { count: 0 }

  for (const enrollment of live) {
    await deleteFile(enrollment.imagePath)
  }
  await prisma.subjectFaceEnrollment.updateMany({
    where: { id: { in: live.map((e) => e.id) } },
    data: { deletedAt: new Date(), embedding: null, embeddingDim: null },
  })

  await writeAuditLog({
    entityType: 'Subject',
    entityId: subjectId,
    action: 'ENROLLMENT_PURGED',
    actorId,
    payload: { reason, count: live.length },
  })

  return { count: live.length }
}

// Returns the DECRYPTED bytes, never a path. Enrollment selfies are sealed on
// disk by storage.writeFile (magic 'PRSM' + AES-GCM envelope), so handing the
// route a path meant res.sendFile streamed the ciphertext out under
// Content-Type: image/jpeg — every thumbnail in both portals rendered as a
// broken image. Same rule as session media: media leaves this process as a
// buffer that went through readFile, or it does not leave.
export async function readEnrollmentImage(subjectId, enrollmentId) {
  const enrollment = await prisma.subjectFaceEnrollment.findFirst({
    where: { id: enrollmentId, subjectId, deletedAt: null },
  })
  if (!enrollment) throw new ApiError(404, 'Enrollment not found')
  return { buffer: await readFile(enrollment.imagePath), mimeType: 'image/jpeg' }
}
