import { createHash, randomInt } from 'node:crypto'
import sharp from 'sharp'
import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { consentVerdict, isEligible, CONSENT_VERDICT } from '../../lib/consent.js'
import { writeFile, readFile, deleteFile } from '../../lib/storage.js'
import { enqueueRecognition } from '../../lib/faceQueue.js'
import { logger } from '../../lib/logger.js'
import { createGallery, addEnrollmentPoint, destroyGallery } from '../../lib/faceGallery.js'
import { embedImage } from '../enrollment/enrollment.service.js'
import { decryptEmbedding, encryptEmbedding } from '../../lib/embeddingCrypto.js'
import { assertAssigned } from '../projects/project.service.js'

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
  for (const cluster of tagged) {
    const consentId = consentBySubject.get(cluster.taggedSubjectId)
    if (!consentId) continue
    for (const photoId of new Set(cluster.faces.map((f) => f.photoId))) {
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
  const redacted = await redactBystanders(sessionId)
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
    },
  })

  return { photoLinks: links.length, revokedSubjectIds, redactedPhotos: redacted }
}

async function redactImage(buffer, bboxes, filename) {
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: 'image/jpeg' }), filename)
  form.append('bboxes', JSON.stringify(bboxes))

  const res = await fetch(`${FACE_SERVICE_URL}/redact`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`Redaction service returned ${res.status}: ${await res.text()}`)
  return Buffer.from(await res.arrayBuffer())
}

// Asks the image-PII worker for pixel regions of sensitive text (Aadhaar, PAN,
// plates, phone numbers, ID cards) visible in the photo. Best-effort: if the
// service is down or errors, we return [] so face redaction still proceeds — a
// missing PII pass is a degraded result, never a reason to leak an unblurred face.
async function detectPiiRegions(buffer, filename) {
  try {
    const form = new FormData()
    form.append('file', new Blob([buffer], { type: 'image/jpeg' }), filename)
    const res = await fetch(`${PII_SERVICE_URL}/detect-pii`, { method: 'POST', body: form })
    if (!res.ok) {
      logger.warn({ status: res.status, filename }, 'PII detection service returned non-OK')
      return []
    }
    const body = await res.json()
    return Array.isArray(body?.regions) ? body.regions : []
  } catch (err) {
    logger.warn({ err, filename }, 'PII detection unavailable — redacting faces only')
    return []
  }
}

// Writes a blurred derivative for every photo containing a face nobody claimed
// or sensitive PII text (Aadhaar/PAN/plate/ID). The original is never touched —
// downstream decides which copy it is entitled to.
async function redactBystanders(sessionId) {
  const photos = await prisma.photo.findMany({
    where: { sessionId },
    include: { faces: { select: { bbox: true, tagStatus: true } } },
  })

  let written = 0
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
      // Nothing to hide: no bystander faces and no PII text. Skip the derivative.
      if (regions.length === 0) continue

      const blurred = await redactImage(original, regions, `${photo.id}.jpg`)
      const redactedPath = `sessions/${sessionId}/redacted/${photo.id}.jpg`
      await writeFile(redactedPath, blurred)
      await prisma.photo.update({ where: { id: photo.id }, data: { redactedPath } })
      written += 1
    } catch (err) {
      // Finalize has already committed; a failed derivative is a warning, not a
      // rollback. The original stays intact either way.
      logger.warn({ err, photoId: photo.id }, 'bystander redaction failed')
    }
  }

  return written
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
// through the same session ownership check as the rest of the module.
export async function readPhotoFile(sessionId, photoId, admin) {
  const session = await loadSession(sessionId, admin)
  const photo = await prisma.photo.findFirst({ where: { id: photoId, sessionId } })
  if (!photo) throw new ApiError(404, 'Photo not found')

  // Once the session is archived the redacted derivative IS the photo. Serving the
  // original here would mean an unrecognised bystander's face is blurred in the
  // handoff manifest and still fully visible one URL away — which is not redaction,
  // it is a checkbox. The original stays on disk for the audit trail only.
  if (session.status === 'ARCHIVED' && photo.redactedPath) {
    return { path: photo.redactedPath, mimeType: 'image/jpeg' }
  }

  return { path: photo.storagePath, mimeType: photo.mimeType }
}

export async function readRedactedPhoto(sessionId, photoId, admin) {
  await loadSession(sessionId, admin)
  const photo = await prisma.photo.findFirst({ where: { id: photoId, sessionId } })
  if (!photo?.redactedPath) throw new ApiError(404, 'No redacted copy for this photo')
  return { path: photo.redactedPath, mimeType: 'image/jpeg' }
}

// Per-person view: serve a copy of the photo with EVERYONE except `subjectId`
// blurred (other identified people + unrecognised bystanders) plus any sensitive
// PII text masked. The session-wide `redactBystanders` derivative only hides
// non-TAGGED faces, so a person tagged to someone else would still be visible in
// this gallery — this endpoint is the only one that hides other participants.
// Derivatives are cached per subject so the on-the-fly blur runs once per photo.
export async function readPersonRedactedPhoto(sessionId, photoId, subjectId, admin) {
  await loadSession(sessionId, admin)
  const photo = await prisma.photo.findFirst({
    where: { id: photoId, sessionId },
    include: { faces: { select: { bbox: true, taggedSubjectId: true } } },
  })
  if (!photo) throw new ApiError(404, 'Photo not found')

  const cachePath = `sessions/${sessionId}/redacted/${photoId}.person-${subjectId}.jpg`
  try {
    await readFile(cachePath)
    return { path: cachePath, mimeType: 'image/jpeg' }
  } catch {
    // Not built yet — fall through and generate it.
  }

  const original = await readFile(photo.storagePath)
  const otherFaces = photo.faces.filter((f) => f.taggedSubjectId !== subjectId).map((f) => f.bbox)
  const piiRegions = await detectPiiRegions(original, `${photoId}.jpg`)
  const regions = [...otherFaces, ...piiRegions]

  // Nobody else in frame and no PII — the original already shows only this person.
  if (regions.length === 0) return { path: photo.storagePath, mimeType: photo.mimeType }

  const blurred = await redactImage(original, regions, `${photoId}.jpg`)
  await writeFile(cachePath, blurred)
  return { path: cachePath, mimeType: 'image/jpeg' }
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
