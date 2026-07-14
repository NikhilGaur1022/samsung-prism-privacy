import { createHash, randomInt } from 'node:crypto'
import sharp from 'sharp'
import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { consentVerdict, isEligible, CONSENT_VERDICT } from '../../lib/consent.js'
import { writeFile, deleteFile } from '../../lib/storage.js'
import { enqueueRecognition } from '../../lib/faceQueue.js'
import { assertAssigned } from '../projects/project.service.js'

const TAGGABLE = ['TAGGED', 'UNKNOWN', 'SKIPPED', 'NOT_A_FACE']

async function loadSession(sessionId, admin, { include } = {}) {
  const session = await prisma.session.findUnique({ where: { id: sessionId }, include })
  if (!session) throw new ApiError(404, 'Session not found')
  // A session belongs to the agent who started it. Assignment alone isn't enough —
  // two agents on the same project must not walk into each other's session.
  if (admin.role === 'collectionAgent' && session.agentId !== admin.id) {
    throw new ApiError(403, 'This session belongs to another agent')
  }
  return session
}

function assertStatus(session, ...allowed) {
  if (!allowed.includes(session.status)) {
    throw new ApiError(409, `Session is ${session.status} — this action is not allowed`)
  }
}

export async function createSession({ projectId, location }, admin) {
  await assertAssigned(projectId, admin)

  const code = `COL-${randomInt(1000, 9999)}`
  const session = await prisma.session.create({
    data: { code, projectId, agentId: admin.id, location: location || null },
    include: { project: { select: { name: true } } },
  })

  await writeAuditLog({
    entityType: 'Session',
    entityId: session.id,
    action: 'SESSION_STARTED',
    actorId: admin.id,
    payload: { projectId, code },
  })

  return session
}

export async function listSessions(admin, { status }) {
  const sessions = await prisma.session.findMany({
    where: {
      ...(admin.role === 'collectionAgent' && { agentId: admin.id }),
      ...(status && { status }),
    },
    orderBy: { createdAt: 'desc' },
    include: {
      project: { select: { id: true, name: true } },
      _count: { select: { participants: true, photos: true } },
    },
  })

  return sessions.map(({ _count, ...s }) => ({
    ...s,
    participantCount: _count.participants,
    photoCount: _count.photos,
  }))
}

export async function getSession(sessionId, admin) {
  const session = await loadSession(sessionId, admin, {
    include: {
      project: { select: { id: true, name: true, purpose: true } },
      participants: {
        orderBy: { addedAt: 'asc' },
        include: {
          subject: { select: { masterUserId: true, fullName: true, email: true, group: true } },
          consent: { select: { status: true, consentId: true } },
        },
      },
      photos: { orderBy: { createdAt: 'desc' } },
      jobs: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  })

  return {
    ...session,
    participants: session.participants.map((p) => ({
      id: p.id,
      subjectId: p.subjectId,
      fullName: p.subject.fullName,
      email: p.subject.email,
      group: p.subject.group,
      consentStatus: p.consent.status,
      addedAt: p.addedAt,
    })),
    job: session.jobs[0] ?? null,
    jobs: undefined,
  }
}

export async function addParticipant(sessionId, subjectId, admin) {
  const session = await loadSession(sessionId, admin)
  assertStatus(session, 'ACTIVE')

  const subject = await prisma.subject.findUnique({
    where: { masterUserId: subjectId },
    include: { projectConsents: { where: { projectId: session.projectId } } },
  })
  if (!subject) throw new ApiError(404, 'Subject not found')

  // The greyed-out row in the UI is cosmetic. This is the check that matters:
  // consent is re-read from the DB at the moment of the add, not trusted from
  // whatever the client last saw.
  const consent = subject.projectConsents[0] ?? null
  const verdict = consentVerdict(subject, consent)
  if (!isEligible(verdict)) {
    throw new ApiError(409, 'Consent not given for this project', { verdict })
  }

  const participant = await prisma.sessionParticipant.create({
    data: { sessionId, subjectId, consentId: consent.consentId },
  })

  await writeAuditLog({
    entityType: 'Session',
    entityId: sessionId,
    action: 'PARTICIPANT_ADDED',
    actorId: admin.id,
    payload: { subjectId, consentId: consent.consentId },
  })

  return participant
}

export async function removeParticipant(sessionId, subjectId, admin) {
  const session = await loadSession(sessionId, admin)
  assertStatus(session, 'ACTIVE')

  await prisma.sessionParticipant.delete({
    where: { sessionId_subjectId: { sessionId, subjectId } },
  })

  await writeAuditLog({
    entityType: 'Session',
    entityId: sessionId,
    action: 'PARTICIPANT_REMOVED',
    actorId: admin.id,
    payload: { subjectId },
  })
}

export async function addPhoto(sessionId, file, { cameraSource, takenAt }, admin) {
  const session = await loadSession(sessionId, admin)
  assertStatus(session, 'ACTIVE')

  const sha256 = createHash('sha256').update(file.buffer).digest('hex')

  const duplicate = await prisma.photo.findUnique({
    where: { sessionId_sha256: { sessionId, sha256 } },
  })
  // Re-picking the same file from the PC (or a double-tap on the shutter) must not
  // create a second copy — the same face would then be counted twice in clustering.
  if (duplicate) return { photo: duplicate, duplicate: true }

  const meta = await sharp(file.buffer).metadata().catch(() => ({}))
  const storagePath = `sessions/${sessionId}/photos/${sha256}.jpg`

  // Normalising to JPEG on the way in (rotating by EXIF first) means the face
  // worker and the browser only ever deal with one format.
  const normalized = await sharp(file.buffer).rotate().jpeg({ quality: 92 }).toBuffer()
  await writeFile(storagePath, normalized)

  const photo = await prisma.photo.create({
    data: {
      sessionId,
      storagePath,
      cameraSource,
      sha256,
      mimeType: 'image/jpeg',
      sizeBytes: normalized.length,
      width: meta.width ?? null,
      height: meta.height ?? null,
      takenAt: takenAt ? new Date(takenAt) : null,
    },
  })

  return { photo, duplicate: false }
}

export async function deletePhoto(sessionId, photoId, admin) {
  const session = await loadSession(sessionId, admin)
  assertStatus(session, 'ACTIVE')

  const photo = await prisma.photo.findFirst({ where: { id: photoId, sessionId } })
  if (!photo) throw new ApiError(404, 'Photo not found')

  await deleteFile(photo.storagePath)
  await prisma.photo.delete({ where: { id: photoId } })
}

// Consent can be revoked between roster-add and end-session. Anyone no longer
// eligible is dropped from the roster here, before any face is ever computed.
async function dropRevokedParticipants(session, actorId) {
  const participants = await prisma.sessionParticipant.findMany({
    where: { sessionId: session.id },
    include: { subject: true, consent: true },
  })

  const revoked = participants.filter(
    (p) => !isEligible(consentVerdict(p.subject, p.consent)),
  )
  if (revoked.length === 0) return []

  await prisma.sessionParticipant.deleteMany({
    where: { id: { in: revoked.map((p) => p.id) } },
  })

  await writeAuditLog({
    entityType: 'Session',
    entityId: session.id,
    action: 'PARTICIPANTS_DROPPED_ON_REVOKE',
    actorId,
    payload: { subjectIds: revoked.map((p) => p.subjectId) },
  })

  return revoked.map((p) => p.subjectId)
}

export async function endSession(sessionId, admin) {
  const session = await loadSession(sessionId, admin)
  assertStatus(session, 'ACTIVE')

  const droppedSubjectIds = await dropRevokedParticipants(session, admin.id)

  const photosTotal = await prisma.photo.count({ where: { sessionId } })
  if (photosTotal === 0) throw new ApiError(409, 'Session has no photos to process')

  const job = await prisma.$transaction(async (tx) => {
    const created = await tx.recognitionJob.create({
      data: { sessionId, photosTotal },
    })
    await tx.session.update({
      where: { id: sessionId },
      data: { status: 'PROCESSING', endedAt: new Date() },
    })
    return created
  })

  await enqueueRecognition(sessionId, job.id)

  await writeAuditLog({
    entityType: 'Session',
    entityId: sessionId,
    action: 'SESSION_ENDED',
    actorId: admin.id,
    payload: { photosTotal, jobId: job.id, droppedSubjectIds },
  })

  return { job, droppedSubjectIds }
}

export async function getClusters(sessionId, admin) {
  const session = await loadSession(sessionId, admin)

  const clusters = await prisma.faceCluster.findMany({
    where: { sessionId },
    orderBy: [{ tagStatus: 'asc' }, { faceCount: 'desc' }],
    include: {
      faces: {
        orderBy: { detScore: 'desc' },
        select: { id: true, photoId: true, cropPath: true, bbox: true, detScore: true },
      },
    },
  })

  const participants = await prisma.sessionParticipant.findMany({
    where: { sessionId },
    include: { subject: { select: { masterUserId: true, fullName: true, email: true } } },
  })

  return {
    status: session.status,
    // The dropdown in the tagging UI is built from exactly this list — the whole
    // point of roster-scoping is that the full subject DB is never offered here.
    roster: participants.map((p) => ({
      masterUserId: p.subject.masterUserId,
      fullName: p.subject.fullName,
      email: p.subject.email,
    })),
    clusters: clusters.map((c) => ({
      id: c.id,
      faceCount: c.faceCount,
      tagStatus: c.tagStatus,
      taggedSubjectId: c.taggedSubjectId,
      suggestedSubjectId: c.suggestedSubjectId,
      repFaceId: c.repFaceId,
      faces: c.faces,
    })),
  }
}

export async function tagCluster(sessionId, clusterId, { tagStatus, subjectId }, admin) {
  const session = await loadSession(sessionId, admin)
  assertStatus(session, 'TAGGING')

  const cluster = await prisma.faceCluster.findFirst({ where: { id: clusterId, sessionId } })
  if (!cluster) throw new ApiError(404, 'Cluster not found')

  if (tagStatus === 'TAGGED') {
    if (!subjectId) throw new ApiError(400, 'subjectId is required when tagging a cluster')
    const onRoster = await prisma.sessionParticipant.findUnique({
      where: { sessionId_subjectId: { sessionId, subjectId } },
    })
    // Enforces the roster constraint server-side — a crafted request can't tag a
    // face with someone who never consented to this project.
    if (!onRoster) throw new ApiError(409, 'That person is not on this session’s roster')
  }

  const taggedSubjectId = tagStatus === 'TAGGED' ? subjectId : null

  const [updated] = await prisma.$transaction([
    prisma.faceCluster.update({
      where: { id: clusterId },
      data: { tagStatus, taggedSubjectId },
    }),
    prisma.faceDetection.updateMany({
      where: { clusterId },
      data: { tagStatus, taggedSubjectId },
    }),
  ])

  return updated
}

export async function finalizeSession(sessionId, admin) {
  const session = await loadSession(sessionId, admin)
  assertStatus(session, 'TAGGING')

  const pending = await prisma.faceCluster.count({
    where: { sessionId, tagStatus: 'PENDING' },
  })
  if (pending > 0) {
    throw new ApiError(409, `${pending} face group${pending === 1 ? '' : 's'} still untagged`)
  }

  const tagged = await prisma.faceCluster.findMany({
    where: { sessionId, tagStatus: 'TAGGED' },
    include: { faces: { select: { photoId: true } } },
  })

  const participants = await prisma.sessionParticipant.findMany({
    where: { sessionId },
    include: { subject: true, consent: true },
  })
  const consentBySubject = new Map(
    participants
      .filter((p) => isEligible(consentVerdict(p.subject, p.consent)))
      .map((p) => [p.subjectId, p.consentId]),
  )

  // Last consent gate. Someone can revoke between tagging and finalize — if so,
  // their photo links are never written and their faces are erased outright.
  const revokedSubjectIds = tagged
    .map((c) => c.taggedSubjectId)
    .filter((id) => id && !consentBySubject.has(id))

  const links = []
  for (const cluster of tagged) {
    const consentId = consentBySubject.get(cluster.taggedSubjectId)
    if (!consentId) continue
    for (const photoId of new Set(cluster.faces.map((f) => f.photoId))) {
      links.push({ photoId, subjectId: cluster.taggedSubjectId, consentId })
    }
  }

  await prisma.$transaction(async (tx) => {
    if (links.length > 0) {
      await tx.photoSubject.createMany({ data: links, skipDuplicates: true })
    }
    if (revokedSubjectIds.length > 0) {
      await tx.faceDetection.deleteMany({
        where: { clusterId: { in: tagged.filter((c) => revokedSubjectIds.includes(c.taggedSubjectId)).map((c) => c.id) } },
      })
      await tx.faceCluster.deleteMany({
        where: { sessionId, taggedSubjectId: { in: revokedSubjectIds } },
      })
    }
    await tx.session.update({
      where: { id: sessionId },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    })
  })

  await writeAuditLog({
    entityType: 'Session',
    entityId: sessionId,
    action: 'SESSION_FINALIZED',
    actorId: admin.id,
    payload: { photoLinks: links.length, clustersTagged: tagged.length, revokedSubjectIds },
  })

  return { photoLinks: links.length, revokedSubjectIds }
}

// Media is never served straight off disk by a static handler — every read goes
// through the same session ownership check as the rest of the module.
export async function readPhotoFile(sessionId, photoId, admin) {
  await loadSession(sessionId, admin)
  const photo = await prisma.photo.findFirst({ where: { id: photoId, sessionId } })
  if (!photo) throw new ApiError(404, 'Photo not found')
  return { path: photo.storagePath, mimeType: photo.mimeType }
}

export async function readFaceCrop(sessionId, faceId, admin) {
  await loadSession(sessionId, admin)
  const face = await prisma.faceDetection.findFirst({
    where: { id: faceId, photo: { sessionId } },
  })
  if (!face?.cropPath) throw new ApiError(404, 'Face crop not found')
  return { path: face.cropPath, mimeType: 'image/jpeg' }
}

export { TAGGABLE, CONSENT_VERDICT }
