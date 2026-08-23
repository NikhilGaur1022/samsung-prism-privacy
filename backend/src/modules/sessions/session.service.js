import { createHash, randomInt } from 'node:crypto'
import sharp from 'sharp'
import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { readOrCreateThumbnail, invalidateThumbnail, buildThumbnail } from '../../lib/thumbnails.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { consentVerdict, isEligible, CONSENT_VERDICT } from '../../lib/consent.js'
import { writeFile, readFile, deleteFile } from '../../lib/storage.js'
import { enqueueRecognition } from '../../lib/faceQueue.js'
import { enqueueRedaction } from '../../lib/redactionQueue.js'
import { logger } from '../../lib/logger.js'
import { createGallery, addEnrollmentPoint, destroyGallery } from '../../lib/faceGallery.js'
import { embedImage } from '../enrollment/enrollment.service.js'
import {
  decryptEmbeddingForSubject,
  encryptEmbeddingForSubject,
} from '../../lib/embeddingCrypto.js'
import { assertCollectable } from '../projects/project.service.js'
import { indexPhotoSubjects } from '../dsar/itemIndex.service.js'
import { redactVideos, countDeferredVideos } from '../videos/video.service.js'
import { videoCaptureEnabled } from '../../lib/videoFeature.js'
import {
  UNRESOLVED_PHOTO_WHERE,
  UNRESOLVED_VIDEO_WHERE,
  isUnresolved,
  assertAllPhotosResolved,
} from '../../lib/photoState.js'
import { workerFetch, readWorkerError } from '../../lib/workerFetch.js'
import { deleteRowsAndBlobs } from '../../lib/blobLifecycle.js'
import { withAdvisoryLock, LOCK_NAMESPACE } from '../../lib/advisoryLock.js'
import { readFile as fsReadFile, rm as fsRm } from 'node:fs/promises'

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
  // The inner half of the two-guard pattern the project routes already use: the
  // router proves the ROLE may read session media, this proves THIS data owner
  // may read THIS project's. Without it, admitting dataOwner to the media routes
  // would have admitted every data owner to every other owner's sessions.
  if (admin.role === 'dataOwner') {
    const project = await prisma.project.findUnique({
      where: { id: session.projectId },
      select: { ownerAdminId: true },
    })
    if (project?.ownerAdminId !== admin.id) {
      throw new ApiError(403, 'You do not own the project this session belongs to')
    }
  }
  return session
}

/**
 * The session-scoping half of the two-guard pattern, exported for other media
 * modules to reuse.
 *
 * The router proves the ROLE may touch session media; this proves THIS caller
 * may touch THIS session — agent-owns-session, dataOwner-owns-project. Audio
 * shipped without it and was reachable across sessions by uuid alone; anything
 * that adds a new media type must route through here rather than reimplement it.
 */
export async function loadSessionForMedia(sessionId, admin, options) {
  return loadSession(sessionId, admin, options)
}

function assertStatus(session, ...allowed) {
  if (!allowed.includes(session.status)) {
    throw new ApiError(409, `Session is ${session.status} — this action is not allowed`)
  }
}

export async function createSession({ projectId, location, type }, admin) {
  // Hard gate: no collection without a DPO approval and a published notice bound
  // to the project. Throws 403 PROJECT_NOT_APPROVED.
  await assertCollectable(projectId, admin)

  const sessionType = type === 'AUDIO' ? 'AUDIO' : type === 'TEXT' ? 'TEXT' : 'IMAGE'
  const prefix = sessionType === 'AUDIO' ? 'AUD' : sessionType === 'TEXT' ? 'TXT' : 'COL'
  const code = `${prefix}-${randomInt(1000, 9999)}`
  const session = await prisma.session.create({
    data: { code, projectId, agentId: admin.id, location: location || null, type: sessionType },
    include: { project: { select: { name: true } } },
  })

  await writeAuditLog({
    entityType: 'Session',
    entityId: session.id,
    action: 'SESSION_STARTED',
    actorId: admin.id,
    payload: { projectId, code, type: sessionType },
  })

  return session
}

export async function listSessions(admin, { status, type }) {
  const sessions = await prisma.session.findMany({
    where: {
      ...(admin.role === 'collectionAgent' && { agentId: admin.id }),
      ...(status && { status }),
      ...(type && { type }),
    },
    orderBy: { createdAt: 'desc' },
    include: {
      project: { select: { id: true, name: true } },
      _count: { select: { participants: true, photos: true, recordings: true, documents: true } },
    },
  })

  return sessions.map(({ _count, ...s }) => ({
    ...s,
    participantCount: _count.participants,
    photoCount: _count.photos,
    recordingCount: _count.recordings,
    documentCount: _count.documents,
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
      recordings: {
        orderBy: { createdAt: 'desc' },
        include: {
          segments: {
            orderBy: { startSec: 'asc' },
          },
        },
      },
      documents: {
        orderBy: { createdAt: 'desc' },
        include: {
          spans: {
            orderBy: { startChar: 'asc' },
          },
        },
      },
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
      consentId: p.consent.consentId,
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

/**
 * Reads an uploaded file's bytes, whether multer spooled it to memory or disk.
 *
 * The session photo route is disk-backed now: 20 files x 25 MB in memoryStorage
 * is up to 500 MB resident per request, and one POST was measured at exactly
 * that with nothing releasing it. Every other upload path is small enough to
 * stay in memory, so both shapes have to work.
 */
async function uploadBytes(file) {
  if (file.buffer) return file.buffer
  if (file.path) return fsReadFile(file.path)
  throw new ApiError(400, 'Uploaded file had no content')
}

/** Removes a spooled temp file. Best-effort: a leftover temp file is untidy, a
 *  failed upload because cleanup threw is a bug. */
async function discardUpload(file) {
  if (!file?.path) return
  await fsRm(file.path, { force: true }).catch(() => {})
}

export async function addPhoto(sessionId, file, { cameraSource, takenAt }, admin) {
  const session = await loadSession(sessionId, admin)
  assertStatus(session, 'ACTIVE')

  const bytes = await uploadBytes(file)
  const sha256 = createHash('sha256').update(bytes).digest('hex')

  const duplicate = await prisma.photo.findUnique({
    where: { sessionId_sha256: { sessionId, sha256 } },
  })
  // Re-picking the same file from the PC (or a double-tap on the shutter) must not
  // create a second copy — the same face would then be counted twice in clustering.
  if (duplicate) return { photo: duplicate, duplicate: true }

  const meta = await sharp(bytes).metadata().catch(() => ({}))
  const storagePath = `sessions/${sessionId}/photos/${sha256}.jpg`

  // Normalising to JPEG on the way in (rotating by EXIF first) means the face
  // worker and the browser only ever deal with one format.
  //
  // `.withMetadata()` is not decoration. Without it sharp drops every APPn
  // segment — proved at byte level: a source JPEG carrying EXIF (APP1, 288
  // bytes) and ICC (APP2, 496 bytes) came out of this exact chain with neither,
  // so the camera's own timestamp, device and orientation were destroyed at
  // ingest and nothing anywhere put them back. That is a chain-of-custody gap
  // independent of the export stamp: the provenance of a collected frame should
  // not be something the platform silently erases on the way in.
  //
  // The person is deliberately NOT written here — at ingest nobody knows who is
  // in the frame. See lib/imageMetadata.js for why the identity stamp belongs at
  // export.
  const normalized = await sharp(bytes).rotate().withMetadata().jpeg({ quality: 92 }).toBuffer()
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
  // MUST be the per-subject variant. migrate-media-encrypt re-sealed every stored
  // embedding under the subject's DEK, and the keyless decryptEmbedding throws on
  // those rows. That throw was caught one frame up and logged as "skipping
  // enrollment", so a whole roster silently resolved to an EMPTY gallery: every
  // face matched nothing, every cluster came back unidentified, and finalize then
  // blurred all of them as bystanders. The keyless call must never come back.
  // decryptEmbeddingForSubject still handles legacy unsealed rows itself.
  if (enrollment.embedding) {
    return decryptEmbeddingForSubject(Buffer.from(enrollment.embedding), enrollment.subjectId)
  }

  const buffer = await readFile(enrollment.imagePath)
  const { embedding } = await embedImage(buffer, `${enrollment.id}.jpg`)

  try {
    const { buffer: sealed, keyId } = await encryptEmbeddingForSubject(
      embedding,
      enrollment.subjectId,
    )
    await prisma.subjectFaceEnrollment.update({
      where: { id: enrollment.id },
      // encKeyId is stamped with the ciphertext: without it a key rotation or a
      // crypto-shred has no way to tell which rows it still has to touch.
      data: { embedding: sealed, embeddingDim: embedding.length, encKeyId: keyId },
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
  // "Has enrolled selfies, but not one of them could be loaded into the gallery."
  // Kept apart from notEnrolled on purpose: they look identical downstream (the
  // person matches nothing) but they are opposite situations. notEnrolled is a
  // fact about the roster the agent can fix by enrolling someone; broken is a
  // fault in this service, and quietly filing it under notEnrolled is how an
  // empty gallery got reported as a clean run.
  const broken = []
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
    let lastErr = null
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
        lastErr = err
        logger.warn({ err, enrollmentId: enrollment.id }, 'skipping enrollment in gallery build')
      }
    }

    if (added > 0) {
      enrolled.push(participant.subjectId)
    } else {
      broken.push({
        subjectId: participant.subjectId,
        fullName: participant.subject.fullName,
        reason: String(lastErr?.message ?? lastErr),
      })
    }
  }

  await writeAuditLog({
    entityType: 'Session',
    entityId: sessionId,
    action: 'GALLERY_BUILT',
    actorId,
    payload: {
      points,
      subjects: enrolled.length,
      notEnrolled: notEnrolled.map((n) => n.subjectId),
      broken: broken.map((b) => b.subjectId),
    },
  })

  // Refuse the pass rather than run it. Every face belonging to these people would
  // come back unidentified, and finalize blurs anything not tagged — so continuing
  // does not degrade to "manual tagging", it degrades to shipping a batch in which
  // the consented subjects are the ones masked out of their own photos.
  if (broken.length > 0) {
    logger.error({ sessionId, broken }, 'gallery build could not load any enrollment for a subject')
    throw new ApiError(
      503,
      `Face gallery could not load the enrolled photos for ${broken
        .map((b) => b.fullName)
        .join(', ')} — matching would tag nobody. This is a server fault, not a roster problem; retry after it is fixed.`,
      { broken },
    )
  }

  return { points, notEnrolled }
}

export async function endSession(sessionId, admin) {
  const session = await loadSession(sessionId, admin)
  assertStatus(session, 'ACTIVE')

  const droppedSubjectIds = await dropRevokedParticipants(session, admin.id)

  // Photos AND clips. The recognition pass analyses both — analyseSessionVideos
  // runs off VideoAsset rows and does not read the photo count at all — so a
  // session holding only video is a perfectly ordinary session to end. Counting
  // photos alone made it unendable: `end` 409'd, nothing ever called
  // analyzeVideo, and every clip sat at PENDING_ANALYSIS with no way forward.
  // That reads as a dead video pipeline, when the only thing missing was this
  // second count.
  const photosTotal = await prisma.photo.count({ where: { sessionId } })
  const videosTotal = await prisma.videoAsset.count({ where: { sessionId } })
  if (photosTotal === 0 && videosTotal === 0) {
    throw new ApiError(409, 'Session has no photos or video to process')
  }

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
    payload: {
      photosTotal,
      videosTotal,
      jobId: job.id,
      droppedSubjectIds,
      galleryPoints: gallery.points,
    },
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
      // The video half of the card. One person tagged once covers every
      // appearance of them in the session, which is the whole reason tracks
      // join the existing clusters instead of getting a parallel queue — but
      // the agent has to be able to SEE that a clip is on this card, or they
      // are tagging a person for footage they were never shown.
      videoTracks: {
        orderBy: { detScore: 'desc' },
        select: {
          id: true,
          videoId: true,
          trackId: true,
          cropPath: true,
          startSec: true,
          endSec: true,
          detScore: true,
          embeddedFrames: true,
        },
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
      // Counted alongside faceCount, never folded into it: faceCount is
      // photo-only by deliberate schema decision and the handoff counts already
      // read it.
      videoTrackCount: c.videoTrackCount,
      repTrackId: c.repTrackId,
      videoTracks: c.videoTracks,
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
    // The video half of the same card. A cluster can hold stills, clips or
    // both, and the agent tags the person once — so the decision has to reach
    // both media or the clip keeps a stale PENDING that blurs a consenting
    // participant out of their own footage and holds the session in REDACTING
    // forever, with the tagging screen showing the person as tagged.
    prisma.videoFaceTrack.updateMany({
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
  const videoTrackCount = clusters.reduce((sum, c) => sum + (c.videoTrackCount ?? 0), 0)

  await prisma.$transaction(async (tx) => {
    await tx.faceDetection.updateMany({
      where: { clusterId: { in: sourceIds } },
      data: {
        clusterId: target.id,
        tagStatus: target.tagStatus,
        taggedSubjectId: target.taggedSubjectId,
      },
    })
    // Tracks must be moved BEFORE the source clusters are deleted.
    // VideoFaceTrack.clusterId is onDelete: SetNull, so deleting a source
    // cluster silently detaches its tracks instead of failing: they vanish from
    // the tagging screen, keep whatever tagStatus they had, and — being no
    // longer reachable from any card — can never be corrected. A PENDING
    // orphan then blurs a consenting participant out of their own footage and
    // holds the session in REDACTING with nothing on screen to explain why.
    await tx.videoFaceTrack.updateMany({
      where: { clusterId: { in: sourceIds } },
      data: {
        clusterId: target.id,
        tagStatus: target.tagStatus,
        taggedSubjectId: target.taggedSubjectId,
      },
    })
    await tx.faceCluster.update({
      where: { id: target.id },
      data: { faceCount, videoTrackCount },
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

/**
 * splitFaces for the video half of a card.
 *
 * Without it a person who appears ONLY in a clip cannot be separated from
 * whoever the clusterer put them on a card with: splitFaces takes face ids, and
 * they have none. The agent's only remaining options would be to tag one card
 * with two people on it, or to leave both untagged and blurred — a correctness
 * hole disguised as a missing convenience.
 *
 * Tracks move to a fresh untagged group with no suggestion carried over, for the
 * same reason splitFaces drops it: the model has already been shown to be wrong
 * about this grouping.
 */
export async function splitTracks(sessionId, clusterId, { trackIds }, admin) {
  const session = await loadSession(sessionId, admin)
  assertStatus(session, 'TAGGING')

  const cluster = await prisma.faceCluster.findFirst({ where: { id: clusterId, sessionId } })
  if (!cluster) throw new ApiError(404, 'Cluster not found')

  const tracks = await prisma.videoFaceTrack.findMany({
    where: { id: { in: trackIds }, clusterId },
    orderBy: { detScore: 'desc' },
  })
  if (tracks.length === 0) throw new ApiError(400, 'None of those clips belong to this group')

  // A card with nothing left on it is not a split, it is a rename — and it
  // would leave an empty cluster that the tagging screen still renders.
  if (tracks.length >= cluster.videoTrackCount && cluster.faceCount === 0) {
    throw new ApiError(400, 'Leave at least one appearance in the original group')
  }

  const created = await prisma.$transaction(async (tx) => {
    const next = await tx.faceCluster.create({
      data: {
        sessionId,
        repTrackId: tracks[0].id,
        videoTrackCount: tracks.length,
        faceCount: 0,
        tagStatus: 'PENDING',
      },
    })
    await tx.videoFaceTrack.updateMany({
      where: { id: { in: tracks.map((t) => t.id) } },
      data: { clusterId: next.id, tagStatus: 'PENDING', taggedSubjectId: null },
    })
    await tx.faceCluster.update({
      where: { id: clusterId },
      data: { videoTrackCount: cluster.videoTrackCount - tracks.length },
    })
    return next
  })

  await writeAuditLog({
    entityType: 'Session',
    entityId: sessionId,
    action: 'VIDEO_TRACKS_SPLIT',
    actorId: admin?.id ?? null,
    payload: { fromClusterId: clusterId, toClusterId: created.id, trackIds: tracks.map((t) => t.id) },
  })

  return created
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
  const session = await loadSession(sessionId, admin, {
    include: {
      recordings: { include: { segments: true } },
      documents: { include: { spans: true } },
    },
  })

  // ---- Text Session Finalization ----
  if (session.type === 'TEXT') {
    assertStatus(session, 'ACTIVE', 'TAGGING', 'PROCESSING')

    if (!session.documents || session.documents.length === 0) {
      throw new ApiError(400, 'Text session has no documents to finalize')
    }

    const pendingDocs = session.documents.filter(
      (d) => d.status === 'PENDING_ANALYSIS' || d.status === 'DEFERRED',
    )
    if (pendingDocs.length > 0) {
      throw new ApiError(409, `${pendingDocs.length} document(s) have not been analyzed or redacted yet`)
    }

    const textSpans = await prisma.textSpan.findMany({
      where: { documentId: { in: session.documents.map((d) => d.id) } },
    })

    const subjectCount = new Set(textSpans.map((s) => s.subjectId).filter(Boolean)).size

    await prisma.$transaction(async (tx) => {
      await tx.session.update({
        where: { id: sessionId },
        data: { status: 'ARCHIVED', endedAt: new Date(), archivedAt: new Date() },
      })
      await tx.sessionHandoff.upsert({
        where: { sessionId },
        create: {
          sessionId,
          projectId: session.projectId,
          photoCount: 0,
          subjectCount,
          linkCount: textSpans.filter((s) => s.action === 'KEEP_NON_PII').length,
        },
        update: {
          subjectCount,
          linkCount: textSpans.filter((s) => s.action === 'KEEP_NON_PII').length,
        },
      })
    })

    await writeAuditLog({
      entityType: 'Session',
      entityId: sessionId,
      action: 'SESSION_FINALIZED',
      actorId: admin.id,
      payload: {
        documents: session.documents.length,
        subjectCount,
        type: 'TEXT',
      },
    })

    return { id: sessionId, status: 'ARCHIVED', type: 'TEXT' }
  }

  // ---- Audio Session Finalization ----
  if (session.type === 'AUDIO' || (session.type !== 'IMAGE' && session.recordings?.length > 0 && session.photos?.length === 0)) {
    assertStatus(session, 'ACTIVE', 'TAGGING', 'PROCESSING')

    if (!session.recordings || session.recordings.length === 0) {
      throw new ApiError(400, 'Audio session has no recordings to finalize')
    }

    const pendingRecordings = session.recordings.filter(
      (r) => r.status === 'PENDING_ANALYSIS' || r.status === 'DEFERRED',
    )
    if (pendingRecordings.length > 0) {
      throw new ApiError(409, `${pendingRecordings.length} recording(s) have not been analyzed or redacted yet`)
    }

    const audioSegments = await prisma.audioSegment.findMany({
      where: { recordingId: { in: session.recordings.map((r) => r.id) } },
    })

    const subjectCount = new Set(audioSegments.map((s) => s.subjectId).filter(Boolean)).size

    await prisma.$transaction(async (tx) => {
      await tx.session.update({
        where: { id: sessionId },
        data: { status: 'ARCHIVED', endedAt: new Date(), archivedAt: new Date() },
      })
      await tx.sessionHandoff.upsert({
        where: { sessionId },
        create: {
          sessionId,
          projectId: session.projectId,
          photoCount: 0,
          subjectCount,
          linkCount: audioSegments.filter((s) => s.action === 'KEEP').length,
        },
        update: {
          subjectCount,
          linkCount: audioSegments.filter((s) => s.action === 'KEEP').length,
        },
      })
    })

    await writeAuditLog({
      entityType: 'Session',
      entityId: sessionId,
      action: 'SESSION_FINALIZED',
      actorId: admin.id,
      payload: {
        recordings: session.recordings.length,
        subjectCount,
        type: 'AUDIO',
      },
    })

    return { id: sessionId, status: 'ARCHIVED', type: 'AUDIO' }
  }

  // ---- Image Session Finalization ----
  assertStatus(session, 'TAGGING')

  const pending = await prisma.faceCluster.count({
    where: { sessionId, tagStatus: 'PENDING' },
  })
  if (pending > 0) {
    throw new ApiError(409, `${pending} face group${pending === 1 ? '' : 's'} still untagged`)
  }

  const tagged = await prisma.faceCluster.findMany({
    where: { sessionId, tagStatus: 'TAGGED' },
    include: {
      faces: { select: { photoId: true } },
      // The video half of the same card. A tagged cluster can cover stills,
      // clips or both, and the consent link has to be written for every medium
      // the person actually appears in.
      videoTracks: { select: { videoId: true } },
    },
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
  // The clip counterpart of `links`. VideoSubject is what redactVideos reads to
  // decide who stays VISIBLE — its `keep` set is built from these rows — and
  // nothing in the codebase ever created one. With the table empty, every face
  // in every clip fell through to the blur branch, including the consenting
  // participants the session was recorded for: a derivative that is technically
  // redacted and completely useless. Same consent gate as stills, same
  // deduplication, same revocation rule.
  const videoLinks = []
  const videoLinkKeys = new Set()

  for (const cluster of tagged) {
    const consentId = consentBySubject.get(cluster.taggedSubjectId)
    if (!consentId) continue

    for (const videoId of new Set(cluster.videoTracks.map((t) => t.videoId))) {
      const key = `${videoId}:${cluster.taggedSubjectId}`
      if (videoLinkKeys.has(key)) continue
      videoLinkKeys.add(key)
      videoLinks.push({ videoId, subjectId: cluster.taggedSubjectId, consentId })
    }

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

  // The transaction commits the tagging DECISIONS and moves the session to
  // REDACTING. It no longer writes ARCHIVED and it no longer creates the
  // handoff.
  //
  // Both of those used to happen here, and redactBystanders() ran afterwards,
  // outside the transaction, in code whose own comment said it "must never be
  // able to undo it". redactBystanders() is the only thing in the codebase that
  // ever moves a photo off the schema default piiStatus = PENDING. So if it did
  // not complete — PII worker down, process killed, network gone — the session
  // was left archived, handed off, and holding unredacted originals, with the
  // status column asserting the opposite. That is the observed state of
  // COL-2225: ARCHIVED, ended 2026-08-18, sixteen photos still PENDING.
  //
  // ARCHIVED is now a promotion that only happens once every photo is terminal,
  // and the handoff is created at the same moment. A crash between the two
  // leaves a session in REDACTING, which is honest, recoverable, and visible.
  const revokedClusterIds = tagged
    .filter((c) => revokedSubjectIds.includes(c.taggedSubjectId))
    .map((c) => c.id)

  await deleteRowsAndBlobs({
    reason: 'CONSENT_REVOKED_AT_FINALIZE',
    // Collected before the delete: after it the paths are unrecoverable. This is
    // one of the two confirmed routes by which orphaned biometric crops were
    // manufactured, and it is the worse of the two — deleting the detections of
    // someone who withdrew consent while leaving their cropped face on disk
    // indefinitely, unreachable by discovery and by purge.
    collectPaths: async (tx) => {
      if (revokedClusterIds.length === 0) return []
      const faces = await tx.faceDetection.findMany({
        where: { clusterId: { in: revokedClusterIds } },
        select: { cropPath: true },
      })
      const tracks = await tx.videoFaceTrack.findMany({
        where: { clusterId: { in: revokedClusterIds } },
        select: { cropPath: true },
      })
      return [...faces.map((f) => f.cropPath), ...tracks.map((t) => t.cropPath)]
    },
    deleteRows: async (tx) => {
      if (links.length > 0) {
        await tx.photoSubject.createMany({ data: links, skipDuplicates: true })
      }
      if (videoLinks.length > 0) {
        await tx.videoSubject.createMany({ data: videoLinks, skipDuplicates: true })
      }
      if (revokedClusterIds.length > 0) {
        // Tracks first, and by cluster: someone who withdrew between tagging and
        // finalize must not keep a TAGGED attribution, because buildSchedule
        // reads exactly that to decide whether to blur them.
        await tx.videoFaceTrack.deleteMany({ where: { clusterId: { in: revokedClusterIds } } })
        await tx.faceDetection.deleteMany({ where: { clusterId: { in: revokedClusterIds } } })
        await tx.faceCluster.deleteMany({
          where: { sessionId, taggedSubjectId: { in: revokedSubjectIds } },
        })
      }
      await tx.session.update({
        where: { id: sessionId },
        data: { status: 'REDACTING' },
      })
    },
  })

  // Everything below runs after the commit and must never be able to undo it.
  //
  // Redaction is now ENQUEUED rather than awaited inline. Inline meant the work
  // existed only in this request's stack frame: a crash, a deploy, or a client
  // disconnect lost it with nothing durable left to retry, which is the other
  // half of how sixteen photos stayed PENDING for two weeks. A queued job
  // survives all three.
  //
  // The first pass still runs here, best-effort, because the common case is that
  // it succeeds in a second or two and the agent gets a real answer while still
  // on site. What changed is that its failure is no longer the end of the story.
  let redacted = 0
  let deferred = 0
  try {
    const result = await redactBystanders(sessionId)
    redacted = result.written
    deferred = result.deferred
  } catch (err) {
    logger.error({ err, sessionId }, 'inline redaction pass failed at finalize — queued for retry')
    deferred = await countDeferredPhotos(sessionId)
  }

  // Queue every frame that is still not terminal, whether the inline pass
  // deferred it or never reached it.
  await enqueueUnresolvedPhotos(sessionId)

  // The same pass for clips. Best-effort and non-fatal for the same reason the
  // stills pass is: a clip left without a derivative is held by the promotion
  // gate above, so the failure mode is a session that stays in REDACTING and
  // says so — not a session that archives with a bystander's face still visible.
  let videosRedacted = 0
  let videosDeferred = 0
  if (videoCaptureEnabled()) {
    try {
      const result = await redactVideos(sessionId)
      videosRedacted = result?.written ?? 0
      videosDeferred = result?.deferred ?? 0
    } catch (err) {
      logger.error({ err, sessionId }, 'inline video redaction failed at finalize — clips held unarchived')
      videosDeferred = await countDeferredVideos(sessionId)
    }
  }

  await destroyGallery(sessionId)

  // Promote to ARCHIVED and create the handoff only if redaction actually
  // finished. promoteIfRedacted() is also what the redaction worker and the
  // reaper call, so there is exactly one place that decides a session is done.
  const promotion = await promoteIfRedacted(sessionId)

  // Index the links this finalize created, after redaction rather than inside
  // the transaction: redactBystanders() is what sets Photo.redactedPath, and an
  // item indexed before it runs would claim no redacted copy exists.
  //
  // Non-fatal by the same reasoning as discovery: the session is already
  // committed and the gallery already destroyed, so throwing here would report
  // a failure for work that cannot be undone. The index is rebuildable and
  // discovery refreshes it on every DSAR walk.
  if (links.length > 0) {
    try {
      const created = await prisma.photoSubject.findMany({
        where: {
          photoId: { in: [...new Set(links.map((l) => l.photoId))] },
          subjectId: { in: [...new Set(links.map((l) => l.subjectId))] },
        },
        select: { id: true },
      })
      await indexPhotoSubjects(created)
    } catch (err) {
      // Still non-fatal — the transaction is committed and the gallery already
      // destroyed, so throwing would report failure for work that cannot be
      // undone. Tagged so it is alertable: since Phase 4 the DSAR item grid
      // serves completeness from this index.
      logger.error(
        { alert: 'ITEM_INDEX_REFRESH_FAILED', err, sessionId, at: 'finalizeSession' },
        'item index refresh failed after finalize — DSAR completeness may be stale until the next listing repairs it',
      )
    }
  }

  await writeAuditLog({
    entityType: 'Session',
    entityId: sessionId,
    action: 'GALLERY_DESTROYED',
    actorId: admin.id,
    payload: {},
  })

  if (promotion.archived) {
    await writeAuditLog({
      entityType: 'Session',
      entityId: sessionId,
      action: 'SESSION_HANDED_OFF',
      actorId: admin.id,
      payload: { photoCount, subjectCount, linkCount: links.length },
    })
  }

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
    deferredPhotos: promotion.unresolved,
    // The session is only handed off once nothing is outstanding. Reported as
    // the status rather than as a boolean so the agent's screen can say which
    // of the two states it is in — REDACTING is "wait", not "broken".
    status: promotion.archived ? 'ARCHIVED' : 'REDACTING',
    ingestBlocked: !promotion.archived,
  }
}

/**
 * Promotes a REDACTING session to ARCHIVED and creates its handoff, but only
 * once every photo is terminal.
 *
 * Idempotent and safe to call from anywhere: finalize calls it optimistically,
 * the redaction worker calls it after each photo it clears, and the reaper calls
 * it for sessions that have been sitting. The advisory lock is what makes those
 * three concurrent callers safe — without it two of them can both observe zero
 * unresolved photos and both create the handoff.
 */
export async function promoteIfRedacted(sessionId) {
  const { acquired, result } = await withAdvisoryLock(
    LOCK_NAMESPACE.FINALIZE_SESSION,
    sessionId,
    async () => {
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { id: true, status: true, projectId: true },
      })
      if (!session) return { archived: false, unresolved: 0, reason: 'SESSION_GONE' }
      if (session.status === 'ARCHIVED') {
        return { archived: true, unresolved: 0, reason: 'ALREADY_ARCHIVED' }
      }
      if (session.status !== 'REDACTING') {
        return { archived: false, unresolved: 0, reason: `NOT_REDACTING (${session.status})` }
      }

      const unresolved = await prisma.photo.count({
        where: { sessionId, ...UNRESOLVED_PHOTO_WHERE },
      })
      if (unresolved > 0) return { archived: false, unresolved, reason: 'PHOTOS_UNRESOLVED' }

      // Clips are gated exactly as stills are, and for the identical reason: a
      // VideoAsset with no redactedPath is a clip whose bystanders were never
      // blurred, and archiving over it makes the status column assert something
      // false about a person's face. UNRESOLVED_VIDEO_WHERE was written in the
      // same pass as the photo predicate and then never wired to anything, so
      // until now the gate let unredacted video through while carefully holding
      // back an unredacted still of the same person in the same session.
      const unresolvedVideos = await prisma.videoAsset.count({
        where: { sessionId, ...UNRESOLVED_VIDEO_WHERE },
      })
      if (unresolvedVideos > 0) {
        return {
          archived: false,
          unresolved: unresolvedVideos,
          reason: 'VIDEOS_UNRESOLVED',
        }
      }

      const [photoCount, linkRows] = await Promise.all([
        prisma.photo.count({ where: { sessionId } }),
        prisma.photoSubject.findMany({
          where: { photo: { sessionId } },
          select: { subjectId: true },
        }),
      ])

      await prisma.$transaction(async (tx) => {
        await tx.session.update({
          where: { id: sessionId },
          data: { status: 'ARCHIVED', archivedAt: new Date() },
        })
        await tx.sessionHandoff.upsert({
          where: { sessionId },
          create: {
            sessionId,
            projectId: session.projectId,
            photoCount,
            subjectCount: new Set(linkRows.map((l) => l.subjectId)).size,
            linkCount: linkRows.length,
          },
          update: {
            photoCount,
            subjectCount: new Set(linkRows.map((l) => l.subjectId)).size,
            linkCount: linkRows.length,
          },
        })
      })

      await writeAuditLog({
        entityType: 'Session',
        entityId: sessionId,
        action: 'SESSION_ARCHIVED',
        payload: { photoCount, linkCount: linkRows.length },
      })

      logger.info({ sessionId, photoCount }, 'session promoted to ARCHIVED — redaction complete')
      return { archived: true, unresolved: 0, reason: 'PROMOTED' }
    },
  )

  // Another caller holds the lock and is doing exactly this work. Reporting
  // "not archived" is correct and the caller will see the real state on its
  // next read.
  if (!acquired) return { archived: false, unresolved: -1, reason: 'LOCK_HELD' }
  return result
}

/**
 * Queues a redaction retry for every photo in the session that is not terminal.
 *
 * This is what makes redaction durable. Before it, the only redaction attempt a
 * photo ever got was the inline one inside finalizeSession — so a PII worker
 * that was down for the duration of a finalize left the whole session's frames
 * PENDING with nothing anywhere holding a record that they needed doing.
 */
export async function enqueueUnresolvedPhotos(sessionId) {
  const unresolved = await prisma.photo.findMany({
    where: { sessionId, ...UNRESOLVED_PHOTO_WHERE },
    select: { id: true },
  })
  if (unresolved.length === 0) return 0

  for (const photo of unresolved) {
    try {
      await enqueueRedaction({ sessionId, photoId: photo.id })
    } catch (err) {
      // A dead Redis must not lose the fact that these need doing. The photos
      // stay non-terminal, so the reaper's sweep finds them again.
      logger.error({ err, sessionId, photoId: photo.id }, 'could not enqueue redaction retry')
    }
  }

  logger.info({ sessionId, queued: unresolved.length }, 'queued redaction retries')
  return unresolved.length
}

// Faces and PII text are sent as separate lists because they are destroyed
// differently: a Gaussian wide enough to erase a face still leaves printed
// digits recoverable, so text regions are mosaicked (pixels discarded) and
// padded before being blurred. Merging them into one list — as this used to —
// silently gave an Aadhaar the face-grade treatment.
async function redactImage(buffer, faceBoxes, piiBoxes, filename) {
  const buildForm = () => {
    const f = new FormData()
    f.append('file', new Blob([buffer], { type: 'image/jpeg' }), filename)
    f.append('bboxes', JSON.stringify(faceBoxes ?? []))
    f.append('pii_bboxes', JSON.stringify(piiBoxes ?? []))
    return f
  }

  const res = await workerFetch('face', `${FACE_SERVICE_URL}/redact`, { body: buildForm })
  if (!res.ok) throw new Error(`redaction failed: ${await readWorkerError('face', res)}`)

  const out = Buffer.from(await res.arrayBuffer())
  // An empty body would be written as the redacted derivative and served as a
  // corrupt image; a body identical to the input means the service applied
  // nothing at all despite being handed regions. Both are failures.
  if (out.length === 0) throw new Error('Redaction service returned an empty image')
  return out
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
  const buildForm = () => {
    const f = new FormData()
    f.append('file', new Blob([buffer], { type: 'image/jpeg' }), filename)
    return f
  }

  let res
  try {
    res = await workerFetch('pii', `${PII_SERVICE_URL}/detect-pii`, { body: buildForm })
  } catch (err) {
    throw new PiiUnavailableError(`PII worker unreachable while scanning ${filename}`, err)
  }

  if (!res.ok) {
    throw new PiiUnavailableError(
      `PII worker failed while scanning ${filename} (${await readWorkerError('pii', res)})`,
    )
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
  // When ids are given they select on their own. `sessionId` is null for an
  // imported frame (there was no capture event), and a `where: { sessionId: null }`
  // clause would then match every import in the database rather than the one the
  // retry queue named.
  const photos = await prisma.photo.findMany({
    where: photoIds ? { id: { in: photoIds } } : { sessionId },
    include: {
      faces: { select: { bbox: true, tagStatus: true } },
      subjects: { select: { subjectId: true } },
    },
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

      // A derivative is written even when there is nothing to blur. Skipping it
      // used to leave redactedPath null, which the serving layer now — correctly
      // — treats as "redaction has not happened", so a clean photo would have
      // been unserveable forever.
      const blurred =
        bystanders.length === 0 && piiRegions.length === 0
          ? original
          : await redactImage(original, bystanders, piiRegions, `${photo.id}.jpg`)
      // Derived from the photo's own session, not from the argument. An imported
      // frame has no session, and `sessions/null/redacted/...` would have put a
      // derivative outside the per-session key scope that opens it.
      const redactedPath = photo.sessionId
        ? `sessions/${photo.sessionId}/redacted/${photo.id}.jpg`
        : `subjects/${photo.subjects[0]?.subjectId ?? 'orphan'}/imports/redacted/${photo.id}.jpg`
      await writeFile(redactedPath, blurred)
      // The cached thumbnail describes the PREVIOUS derivative. Left in place it
      // would keep showing whatever this pass just masked.
      await invalidateThumbnail(photo.sessionId, photo.id)
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

  let piiRegions
  let rebuilt
  try {
    const original = await readFile(photo.storagePath)
    piiRegions = await detectPiiRegions(original, `${photo.id}.jpg`)
    rebuilt =
      toBlur.length === 0 && piiRegions.length === 0
        ? original
        : await redactImage(original, toBlur, piiRegions, `${photo.id}.jpg`)
  } catch (err) {
    // The existing derivative was built while the erasing subject was still
    // linked, so it still SHOWS them. Failing here and leaving it in place
    // would serve an erased person's face out of a photo they have already
    // left — the exact thing invariant 5 forbids. Retract the derivative
    // first, then let the purge mark the location FAILED.
    await prisma.photo
      .update({ where: { id: photo.id }, data: { piiStatus: 'DEFERRED', redactedPath: null } })
      .catch((updateErr) =>
        logger.error({ err: updateErr, photoId: photo.id }, 'could not retract stale redacted derivative'),
      )
    await enqueueRedaction({ sessionId: photo.sessionId, photoId: photo.id }).catch((queueErr) =>
      logger.error({ err: queueErr, photoId: photo.id }, 'could not enqueue re-redaction retry'),
    )
    logger.error(
      { err, photoId: photo.id, reason: err instanceof PiiUnavailableError ? 'PII_WORKER' : 'REDACTION' },
      're-redaction failed after erasure — derivative retracted, photo is not serveable',
    )
    throw err
  }

  const redactedPath = photo.redactedPath ?? `sessions/${photo.sessionId}/redacted/${photo.id}.jpg`
  await writeFile(redactedPath, rebuilt)
  // Erasure path. A thumbnail from before the rebuild still shows the face that
  // was just erased, which is the worst possible moment to serve a stale cache.
  await invalidateThumbnail(photo.sessionId, photo.id)

  await prisma.photo.update({
    where: { id: photo.id },
    data: { redactedPath, piiStatus: piiRegions.length > 0 ? 'MASKED' : 'CLEAN' },
  })

  return {
    photoId: photo.id,
    redactedPath,
    blurredRegions: toBlur.length + piiRegions.length,
    remainingSubjects: remaining.size,
  }
}

// Any photo in this session whose masking is unconfirmed. The handoff ingest and
// the retention sweep both ask this rather than re-deriving the rule.
//
// Named "deferred" for history; it counts every non-terminal state, PENDING
// included. The old spelling of it listed DEFERRED and FAILED only, which is why
// a session could be archived and handed off while sixteen of its frames had
// never been through redaction at all.
export async function countDeferredPhotos(sessionId) {
  return prisma.photo.count({ where: { sessionId, ...UNRESOLVED_PHOTO_WHERE } })
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

/**
 * The photo index for a role that is allowed the redacted derivatives but not the
 * session record itself (matrix §B: dataOwner "own project", dataAdmin).
 *
 * getSession is not an option for them — it carries the participant roster, and
 * naming subjects to a data owner is the exact disclosure §D closes. So this
 * returns frames and their redaction state and nothing that identifies a person:
 * no roster, no tagged names, no face boxes.
 *
 * `redactionPending` is surfaced per frame rather than left to a 409 on the image
 * request, so the screen can say "still processing" instead of rendering a row of
 * broken thumbnails — which is what a DEFERRED batch looked like before.
 */
export async function listSessionPhotosForOversight(sessionId, admin) {
  const session = await loadSession(sessionId, admin)

  const photos = await prisma.photo.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      width: true,
      height: true,
      piiStatus: true,
      redactedPath: true,
      createdAt: true,
    },
  })

  // An audio or text session has no frames, and a page that only knows how to
  // count photos reports that as "nothing here" — which is a false statement
  // about a session that holds a fully processed recording. Hand the caller the
  // type and the real counts so it can say what this session actually is.
  const [recordings, videos, documents] = await Promise.all([
    prisma.recording.count({ where: { sessionId } }),
    prisma.videoAsset.count({ where: { sessionId } }),
    prisma.textDocument.count({ where: { sessionId } }),
  ])

  return {
    session: {
      id: session.id,
      code: session.code,
      type: session.type,
      status: session.status,
      projectId: session.projectId,
      location: session.location,
      createdAt: session.createdAt,
      endedAt: session.endedAt,
      archivedAt: session.archivedAt,
      counts: { photos: photos.length, recordings, videos, documents },
    },
    items: photos.map(({ redactedPath, ...p }) => ({
      ...p,
      // Deliberately a boolean, not the path. The path is a storage location for
      // sealed bytes and has no business leaving the process.
      redactionPending: isUnresolved({ ...p, redactedPath }),
    })),
  }
}

export async function readRedactedPhoto(sessionId, photoId, admin) {
  await loadSession(sessionId, admin)
  const photo = await prisma.photo.findFirst({ where: { id: photoId, sessionId } })
  if (!photo) throw new ApiError(404, 'Photo not found')

  // Fail closed (invariant 8). A missing derivative means redaction has not
  // succeeded yet; 409 tells the caller to wait. There is no branch here that
  // reaches for storagePath, and none may be added.
  if (isUnresolved(photo)) {
    throw new ApiError(409, 'REDACTION_PENDING — no redacted copy is available for this photo yet')
  }
  return { buffer: await readFile(photo.redactedPath), mimeType: 'image/jpeg' }
}

/**
 * A grid-sized version of the ORIGINAL capture, for the agent's own grid before
 * the session is archived.
 *
 * Built per request and never written to disk, which is the whole difference
 * from the redacted thumbnail. A cached miniature of an unredacted frame would
 * be a second copy of unmasked personal data, living past the moment the
 * agent's basis for the original expires and outside everything the redaction
 * pipeline guarantees. Paying ~30ms of CPU per tile to avoid creating that is
 * the right trade.
 *
 * Authorisation is `readPhotoFile`'s, unchanged — the same call, on the same
 * row, before any resizing happens.
 */
export async function readPhotoFileThumb(sessionId, photoId, admin) {
  const original = await readPhotoFile(sessionId, photoId, admin)
  return { buffer: await buildThumbnail(original.buffer), mimeType: 'image/jpeg' }
}

/**
 * A grid-sized version of the redacted derivative.
 *
 * Same authorisation and the same fail-closed rule as the full-size read above:
 * no redacted copy means no thumbnail, and there is no branch here that reaches
 * for the original. The reduction is real — a 2816x1584 frame at ~500 KB
 * becomes roughly 30 KB — and it is the difference between a gallery that
 * paints immediately and one that appears broken while twelve full frames land.
 */
export async function readRedactedPhotoThumb(sessionId, photoId, admin) {
  await loadSession(sessionId, admin)
  const photo = await prisma.photo.findFirst({ where: { id: photoId, sessionId } })
  if (!photo) throw new ApiError(404, 'Photo not found')

  if (isUnresolved(photo)) {
    throw new ApiError(409, 'REDACTION_PENDING — no redacted copy is available for this photo yet')
  }

  const { buffer } = await readOrCreateThumbnail(photo)
  return { buffer, mimeType: 'image/jpeg' }
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

  // Even with nothing to blur we materialise a separate derivative rather than
  // handing back storagePath. Invariant 8 is easier to keep when no code path in
  // the serving layer can name the original at all.
  const derived =
    otherFaces.length === 0 && piiRegions.length === 0
      ? original
      : await redactImage(original, otherFaces, piiRegions, `${photoId}.jpg`)
  // No explicit scope: storage.scopeForPath derives the DEK from the path, so a
  // per-person derivative is sealed under the same key as the session it belongs
  // to and stays readable after a process restart.
  await writeFile(cachePath, derived)
  return { buffer: derived, mimeType: 'image/jpeg' }
}

export async function readFaceCrop(sessionId, faceId, admin) {
  const session = await loadSession(sessionId, admin)

  // Matrix §B: crops exist so an agent can tag, and stay visible on the
  // People page after the session ends for review — only pre-tagging
  // states (ACTIVE/PROCESSING) have no purpose for a close-up of a face.
  if (admin.role === 'collectionAgent' && !['TAGGING', 'ARCHIVED'].includes(session.status)) {
    throw new ApiError(403, `Face crops are readable during TAGGING or after archival only — this session is ${session.status}`)
  }

  const face = await prisma.faceDetection.findFirst({
    where: { id: faceId, photo: { sessionId } },
  })
  if (!face?.cropPath) throw new ApiError(404, 'Face crop not found')
  return { buffer: await readFile(face.cropPath), mimeType: 'image/jpeg' }
}

export { TAGGABLE, CONSENT_VERDICT }
