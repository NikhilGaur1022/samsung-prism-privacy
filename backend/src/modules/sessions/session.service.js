import { createHash, randomInt } from 'node:crypto'
import sharp from 'sharp'
import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { consentVerdict, isEligible, CONSENT_VERDICT } from '../../lib/consent.js'
import { writeFile, readFile, deleteFile } from '../../lib/storage.js'
import { enqueueRecognition } from '../../lib/faceQueue.js'
import { enqueueRedaction } from '../../lib/redactionQueue.js'
import { logger } from '../../lib/logger.js'
import { createGallery, addEnrollmentPoint, destroyGallery } from '../../lib/faceGallery.js'
import { embedImage } from '../enrollment/enrollment.service.js'
import { decryptEmbedding, encryptEmbedding } from '../../lib/embeddingCrypto.js'
import { assertCollectable } from '../projects/project.service.js'

const TAGGABLE = ['TAGGED', 'UNKNOWN', 'SKIPPED', 'NOT_A_FACE']
const FACE_SERVICE_URL = process.env.FACE_SERVICE_URL ?? 'http://localhost:8001'
const PII_SERVICE_URL = process.env.PII_SERVICE_URL ?? 'http://localhost:8002'

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
  // Hard gate: no collection without a DPO approval and a published notice bound
  // to the project. Throws 403 PROJECT_NOT_APPROVED.
  await assertCollectable(projectId, admin)

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
  return addToRoster(session, subjectId, admin.id)
}

// Same roster add, minus the agent-ownership check — used by the QR join flow,
// where the actor is the subject themselves and there is no agent in the request.
// The consent gate below is NOT skipped and must never be.
export async function addParticipantInternal(sessionId, subjectId, actorId) {
  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  if (!session) throw new ApiError(404, 'Session not found')
  return addToRoster(session, subjectId, actorId)
}

async function addToRoster(session, subjectId, actorId) {
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
    data: { sessionId: session.id, subjectId, consentId: consent.consentId },
  })

  await writeAuditLog({
    entityType: 'Session',
    entityId: session.id,
    action: 'PARTICIPANT_ADDED',
    actorId,
    payload: { subjectId, consentId: consent.consentId },
  })

  return participant
}

export async function removeParticipant(sessionId, subjectId, admin) {
  const session = await loadSession(sessionId, admin)
  assertStatus(session, 'ACTIVE')

  // Idempotent on purpose: a revoke may have already dropped this row out from
  // under a stale roster view. deleteMany returns count 0 instead of throwing
  // P2025, so a second "Remove" click is a no-op, not an error.
  const { count } = await prisma.sessionParticipant.deleteMany({
    where: { sessionId, subjectId },
  })
  if (count === 0) return

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

// Stored vector first, selfie second. The backfill write is opportunistic: if it
// fails the gallery build still has the vector it needs, and the next session
// simply tries again.
async function resolveEnrollmentEmbedding(enrollment) {
  if (enrollment.embedding) return decryptEmbedding(Buffer.from(enrollment.embedding))

  const buffer = await readFile(enrollment.imagePath)
  const { embedding } = await embedImage(buffer, `${enrollment.id}.jpg`)

  try {
    await prisma.subjectFaceEnrollment.update({
      where: { id: enrollment.id },
      data: { embedding: encryptEmbedding(embedding), embeddingDim: embedding.length },
    })
  } catch (err) {
    logger.warn({ err, enrollmentId: enrollment.id }, 'embedding backfill failed')
  }

  return embedding
}

// Loads the roster's enrollment vectors into an ephemeral Qdrant collection that
// lives only as long as this session's job. The vector normally comes straight
// out of the enrollment row (encrypted at rest); legacy rows captured before
// embeddings were persisted are re-derived from the selfie and written back.
async function buildSessionGallery(sessionId, actorId) {
  const participants = await prisma.sessionParticipant.findMany({
    where: { sessionId },
    include: {
      subject: {
        include: { faceEnrollments: { where: { deletedAt: null } } },
      },
    },
  })

  try {
    await createGallery(sessionId)
  } catch (err) {
    // Silently skipping the match step is the worst possible failure mode here —
    // the agent would see "no matches" and never know the gallery never existed.
    logger.error({ err, sessionId }, 'failed to create session gallery')
    throw new ApiError(503, 'Face gallery unavailable — is Qdrant running?')
  }

  const enrolled = []
  const notEnrolled = []
  let points = 0

  for (const participant of participants) {
    const enrollments = participant.subject.faceEnrollments
    if (enrollments.length === 0) {
      notEnrolled.push({
        subjectId: participant.subjectId,
        fullName: participant.subject.fullName,
      })
      continue
    }

    let added = 0
    for (const enrollment of enrollments) {
      try {
        const embedding = await resolveEnrollmentEmbedding(enrollment)
        await addEnrollmentPoint(sessionId, {
          embedding,
          masterUserId: participant.subjectId,
          consentId: participant.consentId,
          fullName: participant.subject.fullName,
          enrollmentId: enrollment.id,
        })
        added += 1
        points += 1
      } catch (err) {
        // One unreadable or unencodable selfie is not fatal — the other shots for
        // this person (or manual tagging) still carry them.
        logger.warn({ err, enrollmentId: enrollment.id }, 'skipping enrollment in gallery build')
      }
    }

    if (added > 0) enrolled.push(participant.subjectId)
    else notEnrolled.push({ subjectId: participant.subjectId, fullName: participant.subject.fullName })
  }

  await writeAuditLog({
    entityType: 'Session',
    entityId: sessionId,
    action: 'GALLERY_BUILT',
    actorId,
    payload: { points, subjects: enrolled.length, notEnrolled: notEnrolled.map((n) => n.subjectId) },
  })

  return { points, notEnrolled }
}

export async function endSession(sessionId, admin) {
  const session = await loadSession(sessionId, admin)
  assertStatus(session, 'ACTIVE')

  const droppedSubjectIds = await dropRevokedParticipants(session, admin.id)

  const photosTotal = await prisma.photo.count({ where: { sessionId } })
  if (photosTotal === 0) throw new ApiError(409, 'Session has no photos to process')

  // A session with photos but nobody on the roster can only ever produce an empty
  // gallery — every detected face matches nothing and the whole pass silently
  // tags no one. That is almost always a divergence bug (photos captured against a
  // different session than the one people were added to), so refuse it loudly
  // instead of running a match pass that is guaranteed to find nothing.
  const participantCount = await prisma.sessionParticipant.count({ where: { sessionId } })
  if (participantCount === 0) {
    throw new ApiError(
      409,
      'No participants on the roster — add the people in these photos before ending, or none can be matched to their consent.',
    )
  }

  // Built before the job is enqueued: the worker must never start a match pass
  // against a gallery that isn't there yet.
  const gallery = await buildSessionGallery(sessionId, admin.id)

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
    payload: { photosTotal, jobId: job.id, droppedSubjectIds, galleryPoints: gallery.points },
  })

  return {
    job,
    droppedSubjectIds,
    galleryPoints: gallery.points,
    notEnrolled: gallery.notEnrolled,
  }
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

  // The card has to say "Is this Asha?", not a UUID — resolve against the roster
  // that is already loaded rather than issuing a second lookup.
  const nameById = new Map(participants.map((p) => [p.subjectId, p.subject.fullName]))

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
      suggestedName: c.suggestedSubjectId ? (nameById.get(c.suggestedSubjectId) ?? null) : null,
      matchScore: c.matchScore,
      autoTagged: c.autoTagged,
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
      // Once a human has decided, the tag is no longer the model's — the score
      // stays for the audit trail but the provenance flips to manual.
      data: { tagStatus, taggedSubjectId, autoTagged: false },
    }),
    prisma.faceDetection.updateMany({
      where: { clusterId },
      data: { tagStatus, taggedSubjectId },
    }),
  ])

  return updated
}

// Bulk-confirm what the model suggested. Routes each cluster through tagCluster so
// the roster check is the same one a single manual tag goes through — never around it.
export async function acceptSuggestions(sessionId, { clusterIds }, admin) {
  const session = await loadSession(sessionId, admin)
  assertStatus(session, 'TAGGING')

  const clusters = await prisma.faceCluster.findMany({
    where: { id: { in: clusterIds }, sessionId },
  })

  let accepted = 0
  for (const cluster of clusters) {
    if (!cluster.suggestedSubjectId) continue // nothing to accept — skip, don't fail
    await tagCluster(
      sessionId,
      cluster.id,
      { tagStatus: 'TAGGED', subjectId: cluster.suggestedSubjectId },
      admin,
    )
    accepted += 1
  }

  await writeAuditLog({
    entityType: 'Session',
    entityId: sessionId,
    action: 'SUGGESTIONS_ACCEPTED',
    actorId: admin.id,
    payload: { requested: clusterIds.length, accepted },
  })

  return { accepted, skipped: clusterIds.length - accepted }
}

// The clusterer splits one person across two cards when lighting or pose differ.
// Merging repoints every face at the largest of the selected clusters.
export async function mergeClusters(sessionId, { clusterIds }, admin) {
  const session = await loadSession(sessionId, admin)
  assertStatus(session, 'TAGGING')

  const clusters = await prisma.faceCluster.findMany({
    where: { id: { in: clusterIds }, sessionId },
    orderBy: { faceCount: 'desc' },
  })
  if (clusters.length < 2) throw new ApiError(400, 'Select at least two face groups to merge')

  const [target, ...sources] = clusters
  const sourceIds = sources.map((c) => c.id)
  const faceCount = clusters.reduce((sum, c) => sum + c.faceCount, 0)

  await prisma.$transaction(async (tx) => {
    await tx.faceDetection.updateMany({
      where: { clusterId: { in: sourceIds } },
      data: {
        clusterId: target.id,
        tagStatus: target.tagStatus,
        taggedSubjectId: target.taggedSubjectId,
      },
    })
    await tx.faceCluster.update({
      where: { id: target.id },
      data: { faceCount },
    })
    await tx.faceCluster.deleteMany({ where: { id: { in: sourceIds } } })
  })

  await writeAuditLog({
    entityType: 'Session',
    entityId: sessionId,
    action: 'CLUSTERS_MERGED',
    actorId: admin.id,
    payload: { targetClusterId: target.id, mergedClusterIds: sourceIds, faceCount },
  })

  return { clusterId: target.id, faceCount }
}

// The inverse: the clusterer put two people on one card. The moved faces start
// over as an untagged group with no suggestion — the model already got this wrong.
export async function splitFaces(sessionId, clusterId, { faceIds }, admin) {
  const session = await loadSession(sessionId, admin)
  assertStatus(session, 'TAGGING')

  const cluster = await prisma.faceCluster.findFirst({ where: { id: clusterId, sessionId } })
  if (!cluster) throw new ApiError(404, 'Cluster not found')

  const faces = await prisma.faceDetection.findMany({
    where: { id: { in: faceIds }, clusterId },
    orderBy: { detScore: 'desc' },
  })
  if (faces.length === 0) throw new ApiError(400, 'None of those faces belong to this group')
  if (faces.length >= cluster.faceCount) {
    throw new ApiError(400, 'Leave at least one face in the original group')
  }

  const created = await prisma.$transaction(async (tx) => {
    const next = await tx.faceCluster.create({
      data: {
        sessionId,
        repFaceId: faces[0].id,
        faceCount: faces.length,
        tagStatus: 'PENDING',
      },
    })
    await tx.faceDetection.updateMany({
      where: { id: { in: faces.map((f) => f.id) } },
      data: { clusterId: next.id, tagStatus: 'PENDING', taggedSubjectId: null },
    })
    await tx.faceCluster.update({
      where: { id: clusterId },
      data: { faceCount: cluster.faceCount - faces.length },
    })
    return next
  })

  await writeAuditLog({
    entityType: 'Session',
    entityId: sessionId,
    action: 'CLUSTER_SPLIT',
    actorId: admin.id,
    payload: { fromClusterId: clusterId, newClusterId: created.id, faceIds: faces.map((f) => f.id) },
  })

  return created
}

// The Google-Photos surface: one card per person, plus everything still awaiting a
// decision. Session scale is tens of clusters, so grouping in JS beats a raw aggregate.
export async function getPeople(sessionId, admin) {
  const session = await loadSession(sessionId, admin)

  const clusters = await prisma.faceCluster.findMany({
    where: { sessionId },
    orderBy: { faceCount: 'desc' },
    include: { faces: { select: { photoId: true } } },
  })

  const participants = await prisma.sessionParticipant.findMany({
    where: { sessionId },
    include: {
      subject: {
        select: {
          masterUserId: true,
          fullName: true,
          email: true,
          faceEnrollments: { where: { deletedAt: null }, select: { id: true } },
        },
      },
    },
  })
  const nameById = new Map(participants.map((p) => [p.subjectId, p.subject.fullName]))

  const bySubject = new Map()
  const pending = []
  const counts = { autoTagged: 0, suggested: 0, unidentified: 0, notAFace: 0 }

  for (const cluster of clusters) {
    if (cluster.tagStatus === 'NOT_A_FACE') counts.notAFace += 1

    if (cluster.tagStatus === 'TAGGED' && cluster.taggedSubjectId) {
      if (cluster.autoTagged) counts.autoTagged += 1

      const entry = bySubject.get(cluster.taggedSubjectId) ?? {
        subjectId: cluster.taggedSubjectId,
        fullName: nameById.get(cluster.taggedSubjectId) ?? 'Unknown',
        email: participants.find((p) => p.subjectId === cluster.taggedSubjectId)?.subject.email ?? null,
        coverFaceId: cluster.repFaceId,
        photoIds: new Set(),
        faceCount: 0,
        clusterIds: [],
        auto: 0,
        manual: 0,
        matchScore: null,
      }

      for (const face of cluster.faces) entry.photoIds.add(face.photoId)
      entry.faceCount += cluster.faceCount
      entry.clusterIds.push(cluster.id)
      if (cluster.autoTagged) entry.auto += 1
      else entry.manual += 1
      if (cluster.matchScore != null && (entry.matchScore == null || cluster.matchScore > entry.matchScore)) {
        entry.matchScore = cluster.matchScore
      }

      bySubject.set(cluster.taggedSubjectId, entry)
      continue
    }

    if (cluster.tagStatus === 'PENDING') {
      if (cluster.suggestedSubjectId) counts.suggested += 1
      else counts.unidentified += 1

      pending.push({
        clusterId: cluster.id,
        repFaceId: cluster.repFaceId,
        faceCount: cluster.faceCount,
        matchScore: cluster.matchScore,
        suggestedSubjectId: cluster.suggestedSubjectId,
        suggestedName: cluster.suggestedSubjectId
          ? (nameById.get(cluster.suggestedSubjectId) ?? null)
          : null,
      })
    }
  }

  const people = [...bySubject.values()]
    .map(({ photoIds, auto, manual, ...rest }) => ({
      ...rest,
      photoCount: photoIds.size,
      source: auto > 0 && manual > 0 ? 'MIXED' : auto > 0 ? 'AUTO' : 'MANUAL',
    }))
    .sort((a, b) => b.photoCount - a.photoCount)

  return {
    status: session.status,
    people,
    pending,
    roster: participants.map((p) => ({
      masterUserId: p.subject.masterUserId,
      fullName: p.subject.fullName,
      email: p.subject.email,
      enrolled: p.subject.faceEnrollments.length > 0,
    })),
    counts,
  }
}

export async function getPersonPhotos(sessionId, subjectId, admin) {
  await loadSession(sessionId, admin)

  const photos = await prisma.photo.findMany({
    where: { sessionId, faces: { some: { taggedSubjectId: subjectId } } },
    orderBy: { createdAt: 'asc' },
    include: {
      faces: {
        orderBy: { detScore: 'desc' },
        include: { taggedSubject: { select: { fullName: true } } },
      },
    },
  })

  return {
    photos: photos.map((photo) => ({
      id: photo.id,
      width: photo.width,
      height: photo.height,
      faces: photo.faces.map((f) => ({
        id: f.id,
        bbox: f.bbox,
        tagStatus: f.tagStatus,
        taggedSubjectId: f.taggedSubjectId,
        taggedSubjectName: f.taggedSubject?.fullName ?? null,
        isMatch: f.taggedSubjectId === subjectId,
      })),
    })),
  }
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
  const linkKeys = new Set()
  for (const cluster of tagged) {
    const consentId = consentBySubject.get(cluster.taggedSubjectId)
    if (!consentId) continue
    for (const photoId of new Set(cluster.faces.map((f) => f.photoId))) {
      // Deduplicated across clusters, not just within one. Clustering routinely
      // splits a single person into several clusters, and tagging can point all
      // of them at the same subject — so the same (photo, subject) pair arrives
      // more than once. createMany(skipDuplicates) collapses those to one row,
      // so counting candidates here would publish a linkCount the table never
      // held, and linkCount is what the downstream consumer reconciles the
      // batch against.
      const key = `${photoId}:${cluster.taggedSubjectId}`
      if (linkKeys.has(key)) continue
      linkKeys.add(key)
      links.push({ photoId, subjectId: cluster.taggedSubjectId, consentId })
    }
  }

  const photoCount = await prisma.photo.count({ where: { sessionId } })
  const subjectCount = new Set(links.map((l) => l.subjectId)).size

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
    // The batch downstream consumes. Emitted inside the transaction so a handoff
    // can never exist for a session that didn't actually archive.
    await tx.sessionHandoff.upsert({
      where: { sessionId },
      create: {
        sessionId,
        projectId: session.projectId,
        photoCount,
        subjectCount,
        linkCount: links.length,
      },
      update: { photoCount, subjectCount, linkCount: links.length },
    })
  })

  // Everything below runs after the commit and must never be able to undo it.
  const { written: redacted, deferred } = await redactBystanders(sessionId)
  await destroyGallery(sessionId)

  await writeAuditLog({
    entityType: 'Session',
    entityId: sessionId,
    action: 'GALLERY_DESTROYED',
    actorId: admin.id,
    payload: {},
  })

  await writeAuditLog({
    entityType: 'Session',
    entityId: sessionId,
    action: 'SESSION_HANDED_OFF',
    actorId: admin.id,
    payload: { photoCount, subjectCount, linkCount: links.length },
  })

  await writeAuditLog({
    entityType: 'Session',
    entityId: sessionId,
    action: 'SESSION_FINALIZED',
    actorId: admin.id,
    payload: {
      photoLinks: links.length,
      clustersTagged: tagged.length,
      revokedSubjectIds,
      redactedPhotos: redacted,
      deferredPhotos: deferred,
    },
  })

  // deferredPhotos is surfaced to the agent rather than buried in a log line: it
  // is the number of photos that cannot be served or ingested until the retry
  // queue clears them, and the agent is the one person still on site who could
  // notice the PII worker is down.
  return {
    photoLinks: links.length,
    revokedSubjectIds,
    redactedPhotos: redacted,
    deferredPhotos: deferred,
    ingestBlocked: deferred > 0,
  }
}

async function redactImage(buffer, bboxes, filename) {
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: 'image/jpeg' }), filename)
  form.append('bboxes', JSON.stringify(bboxes))

  const res = await fetch(`${FACE_SERVICE_URL}/redact`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`Redaction service returned ${res.status}: ${await res.text()}`)
  return Buffer.from(await res.arrayBuffer())
}

// Raised when the image-PII worker could not confirm a result. It is a distinct
// type because the caller must treat "no PII in this image" and "we do not know
// whether there is PII in this image" as completely different outcomes.
export class PiiUnavailableError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'PiiUnavailableError'
    this.cause = cause
  }
}

// Asks the image-PII worker for pixel regions of sensitive text (Aadhaar, PAN,
// plates, phone numbers, ID cards) visible in the photo.
//
// This used to return [] when the worker was unreachable, so an outage silently
// downgraded to "faces blurred, Aadhaar number fully legible" and the pipeline
// reported success. Shipping an unmasked Aadhaar is a reportable breach under
// §8(5), so the failure now propagates and the caller parks the photo as
// DEFERRED. Fail closed (invariant 8).
async function detectPiiRegions(buffer, filename) {
  let res
  try {
    const form = new FormData()
    form.append('file', new Blob([buffer], { type: 'image/jpeg' }), filename)
    res = await fetch(`${PII_SERVICE_URL}/detect-pii`, { method: 'POST', body: form })
  } catch (err) {
    throw new PiiUnavailableError(`PII worker unreachable while scanning ${filename}`, err)
  }

  if (!res.ok) {
    throw new PiiUnavailableError(`PII worker returned ${res.status} while scanning ${filename}`)
  }

  const body = await res.json().catch((err) => {
    throw new PiiUnavailableError(`PII worker returned an unreadable response for ${filename}`, err)
  })

  // A malformed body is indistinguishable from "no regions found", and guessing
  // in favour of "clean" is exactly the wrong default here.
  if (!Array.isArray(body?.regions)) {
    throw new PiiUnavailableError(`PII worker response for ${filename} carried no regions array`)
  }
  return body.regions
}

// Writes a blurred derivative for every photo containing a face nobody claimed
// or sensitive PII text (Aadhaar/PAN/plate/ID). The original is never touched —
// downstream decides which copy it is entitled to.
export async function redactBystanders(sessionId, { photoIds } = {}) {
  const photos = await prisma.photo.findMany({
    where: { sessionId, ...(photoIds ? { id: { in: photoIds } } : {}) },
    include: { faces: { select: { bbox: true, tagStatus: true } } },
  })

  let written = 0
  let deferred = 0
  for (const photo of photos) {
    // Max-privacy rule: the ONLY box left visible is one tagged to a consented
    // participant. Everything else is blurred — UNKNOWN, SKIPPED, PENDING, and even
    // NOT_A_FACE. Blurring a declared non-face costs nothing; serving a real face
    // that was mislabelled as "not a face" is an irreversible privacy leak.
    const bystanders = photo.faces
      .filter((f) => f.tagStatus !== 'TAGGED')
      .map((f) => f.bbox)

    try {
      const original = await readFile(photo.storagePath)
      const piiRegions = await detectPiiRegions(original, `${photo.id}.jpg`)
      const regions = [...bystanders, ...piiRegions]

      // A derivative is written even when there is nothing to blur. Skipping it
      // used to leave redactedPath null, which the serving layer now — correctly
      // — treats as "redaction has not happened", so a clean photo would have
      // been unserveable forever.
      const blurred =
        regions.length === 0 ? original : await redactImage(original, regions, `${photo.id}.jpg`)
      const redactedPath = `sessions/${sessionId}/redacted/${photo.id}.jpg`
      await writeFile(redactedPath, blurred)
      await prisma.photo.update({
        where: { id: photo.id },
        data: { redactedPath, piiStatus: piiRegions.length > 0 ? 'MASKED' : 'CLEAN' },
      })
      written += 1
    } catch (err) {
      // Finalize has already committed, so this cannot roll back — but it must
      // not pass either. The photo is parked as DEFERRED: no redactedPath, so
      // nothing can serve it, and the handoff refuses to ingest the batch until
      // the retry queue clears it.
      const isPii = err instanceof PiiUnavailableError
      await prisma.photo.update({
        where: { id: photo.id },
        data: { piiStatus: 'DEFERRED', redactedPath: null },
      })
      deferred += 1
      logger.error(
        { err, photoId: photo.id, sessionId, reason: isPii ? 'PII_WORKER' : 'REDACTION' },
        'redaction deferred — photo is not serveable and the batch cannot ingest',
      )

      await enqueueRedaction({ sessionId, photoId: photo.id }).catch((queueErr) => {
        // A dead queue must not erase the DEFERRED state; the retention/ingest
        // guard still blocks, and this is visible on the DSAR/ops screens.
        logger.error({ err: queueErr, photoId: photo.id }, 'could not enqueue redaction retry')
      })
    }
  }

  if (deferred > 0) {
    logger.warn({ sessionId, deferred, written }, 'session has deferred redactions — ingest is blocked')
  }

  return { written, deferred }
}

/**
 * Rebuilds one photo's redacted derivative from the subjects who are STILL
 * lawfully linked to it. Called by the DSAR purge after an erasing subject's
 * link has been removed.
 *
 * This is what makes invariant 5 real. When A erases from a photo that also holds
 * B, the photo survives for B — but it must not survive still showing A. Because
 * the max-privacy rule is "blur every face not tagged to a remaining subject",
 * removing A's link is by itself enough to make A a bystander here; no list of
 * A's bounding boxes has to be threaded through, which means the blur cannot
 * drift out of sync with the links.
 *
 * Ordering constraint the caller must honour: this needs the ORIGINAL, so it has
 * to run before L2 is deleted. Doing it the other way round produces a photo that
 * can never be re-redacted again.
 */
export async function rebuildRedactedForRemaining(photoId) {
  const photo = await prisma.photo.findUnique({
    where: { id: photoId },
    select: {
      id: true,
      sessionId: true,
      storagePath: true,
      redactedPath: true,
      faces: { select: { bbox: true, taggedSubjectId: true } },
      subjects: { select: { subjectId: true } },
    },
  })
  if (!photo) throw new ApiError(404, 'Photo not found')

  const remaining = new Set(photo.subjects.map((s) => s.subjectId))
  const toBlur = photo.faces.filter((f) => !f.taggedSubjectId || !remaining.has(f.taggedSubjectId)).map((f) => f.bbox)

  const original = await readFile(photo.storagePath)
  const piiRegions = await detectPiiRegions(original, `${photo.id}.jpg`)
  const regions = [...toBlur, ...piiRegions]

  const rebuilt = regions.length === 0 ? original : await redactImage(original, regions, `${photo.id}.jpg`)
  const redactedPath = photo.redactedPath ?? `sessions/${photo.sessionId}/redacted/${photo.id}.jpg`
  await writeFile(redactedPath, rebuilt)

  await prisma.photo.update({
    where: { id: photo.id },
    data: { redactedPath, piiStatus: piiRegions.length > 0 ? 'MASKED' : 'CLEAN' },
  })

  return { photoId: photo.id, redactedPath, blurredRegions: regions.length, remainingSubjects: remaining.size }
}

// Any photo in this session whose masking is unconfirmed. The handoff ingest and
// the retention sweep both ask this rather than re-deriving the rule.
export async function countDeferredPhotos(sessionId) {
  return prisma.photo.count({
    where: { sessionId, OR: [{ piiStatus: 'DEFERRED' }, { piiStatus: 'FAILED' }] },
  })
}

// Returns every photo in the session with its face detections and tagged subject
// names — used by the review page to overlay bounding boxes before finalization.
export async function getPhotosForReview(sessionId, admin) {
  const session = await loadSession(sessionId, admin)
  assertStatus(session, 'TAGGING')

  const photos = await prisma.photo.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
    include: {
      faces: {
        orderBy: { detScore: 'desc' },
        include: {
          taggedSubject: { select: { fullName: true } },
          // The score and the auto/manual flag live on the parent cluster — the
          // review page labels boxes with them, so carry them down here.
          cluster: { select: { matchScore: true, autoTagged: true, suggestedSubjectId: true } },
        },
      },
    },
  })

  return {
    photos: photos.map((photo) => ({
      id: photo.id,
      width: photo.width,
      height: photo.height,
      faces: photo.faces.map((f) => ({
        id: f.id,
        bbox: f.bbox,
        tagStatus: f.tagStatus,
        taggedSubjectName: f.taggedSubject?.fullName ?? null,
        matchScore: f.cluster?.matchScore ?? null,
        autoTagged: f.cluster?.autoTagged ?? false,
        suggested: Boolean(f.cluster?.suggestedSubjectId) && f.tagStatus === 'PENDING',
      })),
    })),
  }
}

// Media is never served straight off disk by a static handler — every read goes
// through the same session ownership check as the rest of the module, and every
// one of these returns a decrypted BUFFER rather than a path. Returning a path
// invited `res.sendFile`, which streams whatever is on disk: once blobs are
// sealed that is ciphertext, and before they were sealed it silently bypassed
// every check in this file.
export async function readPhotoFile(sessionId, photoId, admin) {
  const session = await loadSession(sessionId, admin)
  const photo = await prisma.photo.findFirst({ where: { id: photoId, sessionId } })
  if (!photo) throw new ApiError(404, 'Photo not found')

  // Matrix §B: the agent's basis for the raw original is operational necessity
  // during capture, and it expires at ARCHIVE. This used to fall back to the
  // redacted derivative, which was friendlier but wrong — the route means "give
  // me the original", and after archive the honest answer is no.
  if (admin.role === 'collectionAgent' && session.status === 'ARCHIVED') {
    throw new ApiError(403, 'This session is ARCHIVED — the original is no longer available to the collecting agent')
  }

  return { buffer: await readFile(photo.storagePath), mimeType: photo.mimeType }
}

export async function readRedactedPhoto(sessionId, photoId, admin) {
  await loadSession(sessionId, admin)
  const photo = await prisma.photo.findFirst({ where: { id: photoId, sessionId } })
  if (!photo) throw new ApiError(404, 'Photo not found')

  // Fail closed (invariant 8). A missing derivative means redaction has not
  // succeeded yet; 409 tells the caller to wait. There is no branch here that
  // reaches for storagePath, and none may be added.
  if (!photo.redactedPath || photo.piiStatus === 'DEFERRED' || photo.piiStatus === 'FAILED') {
    throw new ApiError(409, 'REDACTION_PENDING — no redacted copy is available for this photo yet')
  }
  return { buffer: await readFile(photo.redactedPath), mimeType: 'image/jpeg' }
}

// Break-glass binding helpers. They answer "whose data is this object?" so the
// middleware can refuse an open DSAR being used as a skeleton key for a subject
// it does not name. A photo can lawfully hold several subjects, so these return
// every subject linked to the object and the caller checks membership.
export async function subjectsOnPhoto(photoId) {
  const links = await prisma.photoSubject.findMany({
    where: { photoId },
    select: { subjectId: true },
  })
  return links.map((l) => l.subjectId)
}

// Raw original for a DSAR operator. There is no `admin` parameter and no session
// ownership check because the caller is by definition not the collecting agent —
// the authorization already happened in requireBreakGlass, which proved an open
// DSAR names a subject on this photo. Passing the breakGlass context in makes
// that dependency explicit: the function cannot be called from anywhere that has
// not been through the middleware.
export async function readRawForDsar(sessionId, photoId, breakGlass) {
  if (!breakGlass?.dsarRequestId) {
    throw new ApiError(403, 'Raw media requires an established break-glass context')
  }

  const photo = await prisma.photo.findFirst({ where: { id: photoId, sessionId } })
  if (!photo) throw new ApiError(404, 'Photo not found')

  return { buffer: await readFile(photo.storagePath), mimeType: photo.mimeType }
}

export async function subjectsOnFace(faceId) {
  const face = await prisma.faceDetection.findUnique({
    where: { id: faceId },
    select: { taggedSubjectId: true, photoId: true },
  })
  if (!face) return []
  if (face.taggedSubjectId) return [face.taggedSubjectId]
  return subjectsOnPhoto(face.photoId)
}

// Per-person view: serve a copy of the photo with EVERYONE except `subjectId`
// blurred (other identified people + unrecognised bystanders) plus any sensitive
// PII text masked. The session-wide `redactBystanders` derivative only hides
// non-TAGGED faces, so a person tagged to someone else would still be visible in
// this gallery — this endpoint is the only one that hides other participants.
// Derivatives are cached per subject so the on-the-fly blur runs once per photo.
export async function readPersonRedactedPhoto(sessionId, photoId, subjectId, admin) {
  await loadSession(sessionId, admin)
  return buildPersonRedacted(sessionId, photoId, subjectId)
}

// The principal's own §11 view of a photo they appear in. There is no `admin` and
// no session ownership check: the authorization is the PhotoSubject link itself,
// re-proved here rather than trusted from the caller. Everyone but the principal
// is blurred by exactly the same code path the agent's per-person view uses — a
// second implementation is a second place for the blur to be forgotten.
export async function readPersonRedactedPhotoForSubject(photoId, subjectId) {
  const link = await prisma.photoSubject.findUnique({
    where: { photoId_subjectId: { photoId, subjectId } },
    select: { photo: { select: { sessionId: true } } },
  })
  if (!link) throw new ApiError(404, 'Photo not found')
  return buildPersonRedacted(link.photo.sessionId, photoId, subjectId)
}

async function buildPersonRedacted(sessionId, photoId, subjectId) {
  const photo = await prisma.photo.findFirst({
    where: { id: photoId, sessionId },
    include: { faces: { select: { bbox: true, taggedSubjectId: true } } },
  })
  if (!photo) throw new ApiError(404, 'Photo not found')

  const cachePath = `sessions/${sessionId}/redacted/${photoId}.person-${subjectId}.jpg`
  try {
    return { buffer: await readFile(cachePath), mimeType: 'image/jpeg' }
  } catch {
    // Not built yet — fall through and generate it.
  }

  const original = await readFile(photo.storagePath)
  const otherFaces = photo.faces.filter((f) => f.taggedSubjectId !== subjectId).map((f) => f.bbox)
  // PII detection failing must not degrade into "serve it unmasked" — see
  // detectPiiRegions, which throws rather than returning [] on a worker error.
  const piiRegions = await detectPiiRegions(original, `${photoId}.jpg`)
  const regions = [...otherFaces, ...piiRegions]

  // Even with nothing to blur we materialise a separate derivative rather than
  // handing back storagePath. Invariant 8 is easier to keep when no code path in
  // the serving layer can name the original at all.
  const derived = regions.length === 0 ? original : await redactImage(original, regions, `${photoId}.jpg`)
  // No explicit scope: storage.scopeForPath derives the DEK from the path, so a
  // per-person derivative is sealed under the same key as the session it belongs
  // to and stays readable after a process restart.
  await writeFile(cachePath, derived)
  return { buffer: derived, mimeType: 'image/jpeg' }
}

export async function readFaceCrop(sessionId, faceId, admin) {
  const session = await loadSession(sessionId, admin)

  // Matrix §B: crops exist so an agent can tag. Outside the TAGGING window there
  // is no purpose for a close-up of a face, so there is no access.
  if (admin.role === 'collectionAgent' && session.status !== 'TAGGING') {
    throw new ApiError(403, `Face crops are readable during TAGGING only — this session is ${session.status}`)
  }

  const face = await prisma.faceDetection.findFirst({
    where: { id: faceId, photo: { sessionId } },
  })
  if (!face?.cropPath) throw new ApiError(404, 'Face crop not found')
  return { buffer: await readFile(face.cropPath), mimeType: 'image/jpeg' }
}

export { TAGGABLE, CONSENT_VERDICT }
