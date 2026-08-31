import { createHash } from 'node:crypto'
import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { logger } from '../../lib/logger.js'
import { readFile, shredFile, fileExists } from '../../lib/storage.js'
import { destroySubjectKey } from '../../lib/keyring.js'
import { rebuildRedactedForRemaining } from '../sessions/session.service.js'
import { thumbPathFor } from '../../lib/thumbnails.js'
import { rebuildRedactedVideoForRemaining } from '../videos/video.service.js'
import {
  destroyRecording,
  rebuildRedactedForRemainingSpeakers,
} from '../recordings/recording.service.js'
import { runDiscovery } from './discovery.service.js'
import { findSubjectResidue } from '../../lib/storageSweep.js'

// The erasure executor.
//
// Three properties this file exists to guarantee, in priority order:
//
//  1. It never destroys another subject's lawfully-held data. Erasure operates on
//     the PhotoSubject LINK, never on the photo. A photo holding A and B, where A
//     erases, is kept for B and rebuilt with A blurred.
//  2. It is resumable. Every location is its own row with its own status, so a
//     crash halfway through resumes instead of restarting — restarting would
//     re-hash objects that no longer exist and report them as missing.
//  3. It records what it destroyed before destroying it. hashBefore is captured
//     in the same step as the delete; afterwards there is nothing left to hash and
//     the certificate would have nothing to attest to.

// Phase order is load-bearing, not cosmetic. Two orderings would corrupt the
// result if reversed:
//   - REREDACT before L2: rebuilding a derivative needs the original.
//   - SUBJECT_KEY last: destroying the DEK first makes every remaining sealed
//     blob unreadable, so nothing after it could be hashed.
const PHASE_ORDER = [
  'LINK',       // drop the consent links first — they are the erasure key, and
                // L6 reads them to decide rebuild-vs-delete
  'SEGMENT',    // the audio counterpart of LINK, and for the same reason: L15
                // decides mute-vs-delete from what attributions remain
  'VLINK',      // the video counterpart of LINK. MUST precede L21: redactVideos
                // builds its keep-visible set from VideoSubject rows, so a
                // rebuild that ran before this deletion would faithfully keep
                // the erased subject visible in the new derivative
  'TRACK',      // the video counterpart of SEGMENT — the face attributions
  'L6',         // rebuild survivors' derivatives, or delete when nobody is left
  'L15',        // re-mute survivors' recordings — AFTER SEGMENT, which is what
                // turns the erased speaker's spans into mute intervals
  'L21',        // re-blur survivors' clips — AFTER VLINK and TRACK, same reason
  'L3',         // face crops
  'L7',         // per-person derivative cache
  'L2',         // originals — AFTER L6, which needs them to rebuild
  'L14',        // recording originals — AFTER L15, same reason as L2/L6
  'L20',        // clip originals — AFTER L21, same reason again
  'L4',         // enrollment selfies
  'L5_ROW',     // embedding rows
  'L16',        // voice enrollment clips
  'L17_ROW',    // voice embedding rows
  'ROSTER',
  'CONSENT',
  'PII',
  'L9', 'L10',
  'L8', 'L11',  // tombstones
  'SUBJECT_KEY', // crypto-shred, always last
]

// Derived from persisted columns only. Discovery annotates L6 rows with a
// rebuild-or-delete hint, but PurgeJobLocation has no column to carry it and
// inventing one would mean trusting a decision made minutes earlier — so the L6
// handler re-derives it from the links as they stand at execution time.
function phaseOf(loc) {
  if (loc.objectType === 'SubjectKey') return 'SUBJECT_KEY'
  if (loc.locationCode === 'L5') return 'L5_ROW'
  if (loc.locationCode === 'L17') return 'L17_ROW'
  return loc.locationCode
}

async function hashOf(storagePath) {
  try {
    // Hash the plaintext, not the envelope: the envelope's nonce differs per
    // write, so hashing ciphertext would produce a value that proves nothing
    // about the content and could not be compared to anything.
    const buf = await readFile(storagePath)
    return createHash('sha256').update(buf).digest('hex')
  } catch {
    return null
  }
}

/**
 * Materialises the locations for a SCOPED delete — the subset of the discovery
 * vocabulary that one item occupies, and nothing else.
 *
 * Three locations are deliberately absent and must stay absent:
 *   - SUBJECT_KEY. Destroying the per-subject DEK to honour the deletion of one
 *     photo would make every OTHER photo and enrollment of that subject
 *     permanently unreadable. Crypto-shredding is a whole-subject act.
 *   - CONSENT and PII. The consent proof and the identity row are subject-level;
 *     an item delete says nothing about either.
 * Their absence is also what makes a scoped job structurally uncertifiable, on
 * top of the explicit `scope` check in issueCertificate().
 */
async function locationsForItems(subjectId, items) {
  const linkIds = items.filter((i) => i.sourceTable === 'photo_subjects').map((i) => i.sourceId)
  const enrollmentIds = items
    .filter((i) => i.sourceTable === 'subject_face_enrollments')
    .map((i) => i.sourceId)
  const recordingIds = items.filter((i) => i.sourceTable === 'recordings').map((i) => i.sourceId)
  const voiceEnrollmentIds = items
    .filter((i) => i.sourceTable === 'subject_voice_enrollments')
    .map((i) => i.sourceId)

  const [links, enrollments, recordings, voiceEnrollments] = await Promise.all([
    linkIds.length
      ? prisma.photoSubject.findMany({
          where: { id: { in: linkIds }, subjectId },
          select: {
            id: true,
            photoId: true,
            consentId: true,
            photo: { select: { id: true, sessionId: true, storagePath: true, redactedPath: true } },
          },
        })
      : [],
    enrollmentIds.length
      ? prisma.subjectFaceEnrollment.findMany({
          where: { id: { in: enrollmentIds }, subjectId },
          select: { id: true, imagePath: true, embedding: true },
        })
      : [],
    // Scoped to recordings this subject is actually on: an item id names a
    // recording, and a caller must not be able to reach one they are not a
    // speaker in by passing its id.
    recordingIds.length
      ? prisma.recording.findMany({
          where: { id: { in: recordingIds }, segments: { some: { subjectId } } },
          select: { id: true, storagePath: true, redactedPath: true },
        })
      : [],
    voiceEnrollmentIds.length
      ? prisma.subjectVoiceEnrollment.findMany({
          where: { id: { in: voiceEnrollmentIds }, subjectId },
          select: { id: true, audioPath: true, embedding: true },
        })
      : [],
  ])

  // Untagged crops on a frame this subject appears in are still potentially crops
  // OF this subject — same rule runDiscovery() applies, for the same reason.
  const photoIds = links.map((l) => l.photoId)
  const faces = photoIds.length
    ? await prisma.faceDetection.findMany({
        where: {
          photoId: { in: photoIds },
          OR: [{ taggedSubjectId: subjectId }, { taggedSubjectId: null }],
        },
        select: { id: true, cropPath: true },
      })
    : []

  const locations = []

  for (const link of links) {
    const photo = link.photo
    locations.push({ locationCode: 'LINK', objectType: 'PhotoSubject', objectId: link.id, storagePath: null })
    if (photo.redactedPath) {
      locations.push({
        locationCode: 'L6',
        objectType: 'Photo.redactedPath',
        objectId: photo.id,
        storagePath: photo.redactedPath,
      })
    }
    locations.push({
      locationCode: 'L7',
      objectType: 'Photo.personCache',
      objectId: photo.id,
      storagePath: `sessions/${photo.sessionId}/redacted/${photo.id}.person-${subjectId}.jpg`,
    })
    // The grid thumbnail is a picture of this person too. It is derived from the
    // redacted copy and rebuilt on demand, so removing it costs nothing — but
    // leaving it would mean a face survived an erasure in a cache nobody
    // enumerated. Listed by derived path for the same reason L7 is: a cache has
    // no row of its own.
    locations.push({
      locationCode: 'L7',
      objectType: 'Photo.thumbnail',
      objectId: photo.id,
      storagePath: thumbPathFor(photo.sessionId, photo.id),
    })
    locations.push({
      locationCode: 'L2',
      objectType: 'Photo.storagePath',
      objectId: photo.id,
      storagePath: photo.storagePath,
    })
  }

  for (const recording of recordings) {
    locations.push({
      locationCode: 'SEGMENT',
      objectType: 'AudioSegment',
      objectId: recording.id,
      storagePath: null,
    })
    if (recording.redactedPath) {
      locations.push({
        locationCode: 'L15',
        objectType: 'Recording.redactedPath',
        objectId: recording.id,
        storagePath: recording.redactedPath,
      })
    }
    locations.push({
      locationCode: 'L14',
      objectType: 'Recording.storagePath',
      objectId: recording.id,
      storagePath: recording.storagePath,
    })
  }

  for (const face of faces) {
    locations.push({
      locationCode: 'L3',
      objectType: 'FaceDetection',
      objectId: face.id,
      storagePath: face.cropPath,
    })
  }

  for (const enrollment of enrollments) {
    locations.push({
      locationCode: 'L4',
      objectType: 'SubjectFaceEnrollment.imagePath',
      objectId: enrollment.id,
      storagePath: enrollment.imagePath,
    })
    if (enrollment.embedding) {
      locations.push({
        locationCode: 'L5',
        objectType: 'SubjectFaceEnrollment.embedding',
        objectId: enrollment.id,
        storagePath: null,
      })
    }
  }

  for (const enrollment of voiceEnrollments) {
    locations.push({
      locationCode: 'L16',
      objectType: 'SubjectVoiceEnrollment.audioPath',
      objectId: enrollment.id,
      storagePath: enrollment.audioPath,
    })
    if (enrollment.embedding) {
      locations.push({
        locationCode: 'L17',
        objectType: 'SubjectVoiceEnrollment.embedding',
        objectId: enrollment.id,
        storagePath: null,
      })
    }
  }

  // The unique constraint is (purgeJobId, locationCode, objectType, objectId), so
  // two selected items sharing a frame would collide on L2/L6/L7 and the create
  // would fail the whole batch.
  const seen = new Set()
  return locations.filter((l) => {
    const key = `${l.locationCode}:${l.objectType}:${l.objectId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Plans the purge. Runs discovery and materialises one PurgeJobLocation per
 * place the subject exists.
 *
 * Idempotent: re-planning an existing job returns it untouched rather than
 * duplicating locations, so a retried request cannot double-execute.
 *
 * With `items`, plans a SCOPED job instead: locations are derived from the named
 * item index rows rather than from a discovery walk, `scope` is PARTIAL, and the
 * job is excluded from certification. Idempotency for the scoped path lives one
 * level up, on the unique constraint over DsarItemAction — an item action is the
 * only thing that may raise one.
 */
export async function createPurgeJob(dsarRequestId, admin = null, { items = null, batchId = null } = {}) {
  const request = await prisma.dsarRequest.findUnique({ where: { id: dsarRequestId } })
  if (!request) throw new ApiError(404, 'DSAR request not found')

  const scoped = Array.isArray(items)

  // The erasure-type gate applies to whole-subject jobs only. A scoped delete is
  // a handler minimising what is held while working a request of any type, and
  // it destroys only the items an operator named.
  if (!scoped && !['ERASE', 'WITHDRAWAL_ERASURE'].includes(request.type)) {
    throw new ApiError(400, `DSAR type ${request.type} is not an erasure`)
  }

  // A request that names a project erases that project's data, not the person.
  // This is the whole fix for the withdrawal bug: raiseWithdrawalErasure has
  // always carried projectId onto the request, and this executor used to drop it
  // on the floor and walk the entire subject — destroying their data in every
  // other project, crypto-shredding the DEK and anonymising the identity row.
  const projectId = scoped ? null : (request.projectId ?? null)

  if (!scoped) {
    const existing = await prisma.purgeJob.findFirst({
      // scope: FULL matters. Without it a scoped job left PARTIAL by a failed
      // item delete would be returned as "the open erasure" and the whole-subject
      // purge would never be planned at all.
      where: { dsarRequestId, scope: 'FULL', status: { in: ['QUEUED', 'RUNNING', 'PARTIAL'] } },
      include: { locations: true },
    })
    if (existing) return existing
  }

  const discovery = scoped ? null : await runDiscovery(request.subjectId, { projectId })

  // Belt and braces on the thing that actually went wrong. If a project-scoped
  // request ever produces a walk that still names the identity row or the
  // per-subject key, that is a whole-subject erasure wearing a project's label,
  // and it must not be planned at all — a loud refusal is recoverable, an
  // executed one is not.
  if (projectId && discovery) {
    const subjectLevel = discovery.locations.filter(
      (l) => l.locationCode === 'PII' || l.objectType === 'SubjectKey',
    )
    if (subjectLevel.length > 0) {
      throw new ApiError(
        500,
        `Refusing to plan a project-scoped erasure that names ${subjectLevel
          .map((l) => l.objectType)
          .join(', ')}. Those are whole-subject locations and this request covers one project.`,
      )
    }
  }
  const locations = scoped
    ? await locationsForItems(request.subjectId, items)
    : discovery.locations.map((l) => ({
        locationCode: l.locationCode,
        objectType: l.objectType,
        objectId: l.objectId,
        storagePath: l.storagePath,
      }))

  const job = await prisma.purgeJob.create({
    data: {
      dsarRequestId,
      subjectId: request.subjectId,
      status: 'QUEUED',
      scope: scoped ? 'PARTIAL' : projectId ? 'PROJECT' : 'FULL',
      meta: scoped
        ? { batchId, itemIds: items.map((i) => i.id) }
        : projectId
          ? { projectId, unattributedLinks: discovery.counts.unattributedLinks ?? 0 }
          : undefined,
      locationsTotal: locations.length,
      locations: { create: locations.map((l) => ({ ...l, status: 'PENDING' })) },
    },
    include: { locations: true },
  })

  await writeAuditLog({
    entityType: 'DsarRequest',
    entityId: dsarRequestId,
    action: scoped ? 'PURGE_PLANNED_SCOPED' : 'PURGE_PLANNED',
    actorId: admin?.id ?? null,
    payload: {
      purgeJobId: job.id,
      scope: scoped ? 'PARTIAL' : 'FULL',
      locations: locations.length,
      ...(scoped
        ? { batchId, itemIds: items.map((i) => i.id) }
        : { multiSubjectPhotos: discovery.counts.multiSubjectPhotos }),
    },
  })

  return job
}

// Each handler returns 'DONE' or 'SKIPPED'. Throwing marks the location FAILED
// and leaves the job PARTIAL — never silently complete.
const handlers = {
  async LINK(loc) {
    const { count } = await prisma.photoSubject.deleteMany({ where: { id: loc.objectId } })
    return count > 0 ? 'DONE' : 'SKIPPED'
  },

  async L3(loc) {
    if (loc.storagePath && (await fileExists(loc.storagePath))) await shredFile(loc.storagePath)
    const { count } = await prisma.faceDetection.deleteMany({ where: { id: loc.objectId } })
    return count > 0 || loc.storagePath ? 'DONE' : 'SKIPPED'
  },

  async L7(loc) {
    if (!loc.storagePath || !(await fileExists(loc.storagePath))) return 'SKIPPED'
    await shredFile(loc.storagePath)
    return 'DONE'
  },

  async L6(loc, job) {
    // Only reached when this subject was the sole subject on the photo — the
    // multi-subject case was routed to REREDACT during planning. Re-checked here
    // rather than trusted, because planning and execution can be minutes apart
    // and another subject could have been unlinked in between.
    const remaining = await prisma.photoSubject.count({
      where: { photoId: loc.objectId, subjectId: { not: job.subjectId } },
    })
    if (remaining > 0) {
      await rebuildRedactedForRemaining(loc.objectId)
      return 'DONE'
    }
    if (loc.storagePath && (await fileExists(loc.storagePath))) await shredFile(loc.storagePath)
    await prisma.photo.updateMany({ where: { id: loc.objectId }, data: { redactedPath: null } })
    return 'DONE'
  },

  async L2(loc, job) {
    // Invariant 5: erasure operates on the LINK, not on the photo. A frame that
    // still holds B is B's lawfully-collected data, and the original is the part
    // of it that matters — it is what readRawForDsar serves under break-glass and
    // what rebuildRedactedForRemaining needs to blur the NEXT person who erases.
    //
    // Shredding it and keeping only the row is not "keeping the photo for B": it
    // leaves a row pointing at bytes that no longer exist, and it makes the frame
    // permanently un-re-redactable, so a second erasure from the same photo can
    // never be honoured. The bytes go only when the last link does.
    const remaining = await prisma.photoSubject.count({ where: { photoId: loc.objectId } })

    if (remaining > 0) {
      logger.info(
        { photoId: loc.objectId, remaining, purgeJobId: job.id },
        'original retained — other subjects still hold consent to this photo',
      )
      // A's presence in the frame is already handled: the link is gone (LINK) and
      // the derivative was rebuilt with A blurred (L6). Nothing served from this
      // photo shows A any more.
      return 'SKIPPED'
    }

    if (loc.storagePath && (await fileExists(loc.storagePath))) await shredFile(loc.storagePath)
    await prisma.photo.deleteMany({ where: { id: loc.objectId } })
    return 'DONE'
  },

  // --- audio ---------------------------------------------------------------

  async SEGMENT(loc, job) {
    // The rows are NOT deleted, they are stripped of the person.
    //
    // Deleting them would destroy the start/end timings, and those timings are
    // the only thing that can mute this voice out of a recording other speakers
    // are still entitled to. What makes a segment personal data is the
    // attribution — subjectId, consentId, the match score that says "this is
    // them". With those gone the row is redaction metadata: "someone spoke here,
    // and it is muted".
    const { count } = await prisma.audioSegment.updateMany({
      where: { recordingId: loc.objectId, subjectId: job.subjectId },
      data: { subjectId: null, consentId: null, action: 'REDACT_VOICE', matchScore: null },
    })
    return count > 0 ? 'DONE' : 'SKIPPED'
  },

  async L15(loc, job) {
    const remaining = await prisma.audioSegment.count({
      where: { recordingId: loc.objectId, subjectId: { not: null } },
    })

    if (remaining > 0) {
      // Other identified speakers are still on this recording, and their consent
      // to their own voice survives this subject's erasure. Rebuild with the
      // erased speaker muted rather than destroying their recording too.
      await rebuildRedactedForRemainingSpeakers(loc.objectId)
      return 'DONE'
    }

    if (loc.storagePath && (await fileExists(loc.storagePath))) await shredFile(loc.storagePath)
    await prisma.recording.updateMany({ where: { id: loc.objectId }, data: { redactedPath: null } })
    return 'DONE'
  },

  async L14(loc, job) {
    // Mirrors L2 exactly. The original is retained while any identified speaker
    // remains, because it is the source every future re-mute is built from —
    // shredding it would leave a row pointing at bytes that no longer exist and
    // make the recording permanently un-re-mutable, so a second speaker's
    // erasure could never be honoured.
    const remaining = await prisma.audioSegment.count({
      where: { recordingId: loc.objectId, subjectId: { not: null } },
    })

    if (remaining > 0) {
      logger.info(
        { recordingId: loc.objectId, remaining, purgeJobId: job.id },
        'recording original retained — other speakers still hold consent to this recording',
      )
      return 'SKIPPED'
    }

    const { destroyed } = await destroyRecording(loc.objectId)
    return destroyed ? 'DONE' : 'SKIPPED'
  },

  async VLINK(loc) {
    // The clip's consent link. Deleting it is what makes the clip no longer
    // lawfully hold this person — and, because redactVideos derives its
    // keep-visible set from these rows, it is also what makes the L21 rebuild
    // below actually blur them rather than faithfully preserving them.
    const { count } = await prisma.videoSubject.deleteMany({ where: { id: loc.objectId } })
    return count > 0 ? 'DONE' : 'SKIPPED'
  },

  async TRACK(loc, job) {
    // Stripped of the person, not deleted — the same decision SEGMENT makes and
    // for the same reason. The keyframed boxes are the only thing that can blur
    // this face out of a clip other subjects are still entitled to; destroying
    // them would make the erased person permanently un-blurrable and force the
    // whole clip to be destroyed along with everyone else in it.
    //
    // What made the row personal data was the attribution. Without it the row
    // is redaction metadata: "a face was here, and it is blurred".
    const { count } = await prisma.videoFaceTrack.updateMany({
      where: { videoId: loc.objectId, taggedSubjectId: job.subjectId },
      data: { taggedSubjectId: null, tagStatus: 'UNKNOWN', clusterId: null },
    })
    return count > 0 ? 'DONE' : 'SKIPPED'
  },

  async L21(loc, job) {
    // Mirrors L15. Anyone still linked to this clip keeps their footage, with
    // the erased subject blurred out of the rebuilt derivative.
    const remaining = await prisma.videoSubject.count({ where: { videoId: loc.objectId } })

    if (remaining > 0) {
      await rebuildRedactedVideoForRemaining(loc.objectId)
      return 'DONE'
    }

    if (loc.storagePath && (await fileExists(loc.storagePath))) await shredFile(loc.storagePath)
    await prisma.videoAsset.updateMany({ where: { id: loc.objectId }, data: { redactedPath: null } })
    return 'DONE'
  },

  async L20(loc, job) {
    // Mirrors L2 and L14. The original is the source every future re-blur is
    // built from, so it is retained while anyone else is still linked — a row
    // pointing at shredded bytes would make the clip permanently
    // un-re-redactable and a second subject's erasure impossible to honour.
    const remaining = await prisma.videoSubject.count({ where: { videoId: loc.objectId } })

    if (remaining > 0) {
      logger.info(
        { videoId: loc.objectId, remaining, purgeJobId: job.id },
        'clip original retained — other subjects still hold consent to this clip',
      )
      return 'SKIPPED'
    }

    if (loc.storagePath && (await fileExists(loc.storagePath))) await shredFile(loc.storagePath)
    const { count } = await prisma.videoAsset.deleteMany({ where: { id: loc.objectId } })
    return count > 0 || loc.storagePath ? 'DONE' : 'SKIPPED'
  },

  async L4(loc) {
    if (loc.storagePath && (await fileExists(loc.storagePath))) await shredFile(loc.storagePath)
    return 'DONE'
  },

  async L5_ROW(loc) {
    const { count } = await prisma.subjectFaceEnrollment.deleteMany({ where: { id: loc.objectId } })
    return count > 0 ? 'DONE' : 'SKIPPED'
  },

  // The voice pair, identical in shape to L4/L5_ROW. Separate handlers rather
  // than a shared one keyed on objectType: these delete from different tables,
  // and a single handler that guessed which would be one refactor away from
  // reporting DONE on a row it never touched.
  async L16(loc) {
    if (loc.storagePath && (await fileExists(loc.storagePath))) await shredFile(loc.storagePath)
    return 'DONE'
  },

  async L17_ROW(loc) {
    const { count } = await prisma.subjectVoiceEnrollment.deleteMany({ where: { id: loc.objectId } })
    return count > 0 ? 'DONE' : 'SKIPPED'
  },

  async ROSTER(loc) {
    const { count } = await prisma.sessionParticipant.deleteMany({ where: { id: loc.objectId } })
    return count > 0 ? 'DONE' : 'SKIPPED'
  },

  async CONSENT(loc) {
    // Marked PURGED, never deleted. The row is the fiduciary's proof that the
    // collection was lawful when it happened; destroying it on the principal's
    // request would destroy our own defence, and DPDP does not ask for it.
    const { count } = await prisma.projectConsent.updateMany({
      where: { consentId: loc.objectId },
      data: { status: 'PURGED' },
    })
    return count > 0 ? 'DONE' : 'SKIPPED'
  },

  async PII(loc) {
    // Anonymised in place rather than deleted: the row is the anchor for the
    // consent proof above and for this very DSAR request. What is removed is
    // everything that identifies a person.
    const anon = `erased-${loc.objectId.slice(0, 8)}@erased.invalid`
    await prisma.subject.updateMany({
      where: { masterUserId: loc.objectId },
      data: {
        fullName: 'ERASED',
        email: anon,
        phone: null,
        employeeRef: null,
        dateOfBirth: null,
        guardianContact: null,
        nomineeContact: null,
        status: 'ERASED',
      },
    })
    return 'DONE'
  },

  async L9(loc) {
    if (!loc.storagePath || !(await fileExists(loc.storagePath))) return 'SKIPPED'
    await shredFile(loc.storagePath)
    return 'DONE'
  },

  async L10(loc) {
    return handlers.L9(loc)
  },

  async L8() {
    return 'SKIPPED'
  },

  async L11() {
    // Nothing to execute. The location exists so the certificate names it and so
    // the residual risk is on the record instead of being an omission.
    return 'SKIPPED'
  },

  async SUBJECT_KEY(loc, job) {
    await destroySubjectKey(job.subjectId)
    await prisma.purgeJob.update({
      where: { id: job.id },
      data: { keyDestroyedAt: new Date() },
    })
    return 'DONE'
  },
}

/**
 * Executes (or resumes) a purge job.
 *
 * Safe to call repeatedly: locations already DONE or SKIPPED are not revisited,
 * and each handler is written to tolerate the object already being gone.
 */
export async function executePurgeJob(purgeJobId, { admin = null } = {}) {
  const job = await prisma.purgeJob.findUnique({
    where: { id: purgeJobId },
    include: { locations: true },
  })
  if (!job) throw new ApiError(404, 'Purge job not found')
  if (job.status === 'COMPLETED') return job

  await prisma.purgeJob.update({
    where: { id: purgeJobId },
    data: { status: 'RUNNING', startedAt: job.startedAt ?? new Date() },
  })

  const pending = job.locations.filter((l) => l.status === 'PENDING' || l.status === 'FAILED')
  const ordered = [...pending].sort(
    (a, b) => PHASE_ORDER.indexOf(phaseOf(a)) - PHASE_ORDER.indexOf(phaseOf(b)),
  )

  let failures = 0

  for (const loc of ordered) {
    const phase = phaseOf(loc)
    const handler = handlers[phase]

    if (!handler) {
      await prisma.purgeJobLocation.update({
        where: { id: loc.id },
        data: { status: 'FAILED', error: `No handler for phase "${phase}"`, attempts: { increment: 1 } },
      })
      failures += 1
      continue
    }

    try {
      await prisma.purgeJobLocation.update({ where: { id: loc.id }, data: { status: 'RUNNING' } })

      // Captured before the handler runs. This is the only moment the object is
      // both still present and known to be about to be destroyed.
      const hashBefore = loc.hashBefore ?? (loc.storagePath ? await hashOf(loc.storagePath) : null)

      const outcome = await handler(loc, job)

      await prisma.purgeJobLocation.update({
        where: { id: loc.id },
        data: {
          status: outcome,
          hashBefore,
          completedAt: new Date(),
          error: null,
          attempts: { increment: 1 },
        },
      })
    } catch (err) {
      failures += 1
      logger.error({ err, locationId: loc.id, phase, purgeJobId }, 'purge location failed')
      await prisma.purgeJobLocation.update({
        where: { id: loc.id },
        data: { status: 'FAILED', error: String(err?.message ?? err), attempts: { increment: 1 } },
      })
    }
  }

  // ---- Filesystem sweep -----------------------------------------------------
  // Every location above was enumerated by walking database rows, which is the
  // reason a signed certificate could attest to an erasure that did not happen:
  // 1,123 files were referenced by no row at all, so discovery never saw them
  // and purge could not reach them — 383 cropped faces and 135 enrolment
  // selfies among them. A row-based purge cannot find a row-based bug.
  //
  // This walks the disk for anything under the subject's prefixes, or carrying
  // the subject id in its name (the per-person redacted cache is written as
  // `<photoId>.person-<subjectId>.jpg`), that no row references. Whatever it
  // finds is deleted here and recorded as its own location, so the certificate
  // covers it and an auditor can see it was looked for.
  let residueLocations = 0
  if (job.scope !== 'PARTIAL') {
    try {
      const residue = await findSubjectResidue(prisma, job.subjectId)

      for (const relPath of residue) {
        const hashBefore = await hashOf(relPath).catch(() => null)
        let status = 'DONE'
        try {
          await shredFile(relPath)
        } catch (err) {
          status = 'FAILED'
          failures += 1
          logger.error({ err, path: relPath, purgeJobId }, 'could not shred subject residue')
        }

        await prisma.purgeJobLocation.create({
          data: {
            purgeJobId,
            locationCode: 'L-FS',
            objectType: 'OrphanedBlob',
            objectId: null,
            storagePath: relPath,
            status,
            hashBefore,
            completedAt: status === 'DONE' ? new Date() : null,
            attempts: 1,
            error: status === 'FAILED' ? 'shred failed' : null,
          },
        })
        residueLocations += 1
      }

      if (residueLocations > 0) {
        logger.warn(
          { purgeJobId, subjectId: job.subjectId, residueLocations },
          'purge found unreferenced blobs the row walk had missed',
        )
      }
    } catch (err) {
      // A sweep that could not run must not be reported as a sweep that found
      // nothing. It counts as a failure, which blocks the certificate.
      failures += 1
      logger.error({ err, purgeJobId }, 'filesystem residue sweep failed')
      await prisma.purgeJobLocation.create({
        data: {
          purgeJobId,
          locationCode: 'L-FS',
          objectType: 'FilesystemSweep',
          status: 'FAILED',
          attempts: 1,
          error: `sweep failed: ${String(err?.message ?? err).slice(0, 400)}`,
        },
      })
    }
  }

  const done = await prisma.purgeJobLocation.count({
    where: { purgeJobId, status: { in: ['DONE', 'SKIPPED'] } },
  })
  const total = await prisma.purgeJobLocation.count({ where: { purgeJobId } })
  const complete = done === total && failures === 0

  const updated = await prisma.purgeJob.update({
    where: { id: purgeJobId },
    data: {
      status: complete ? 'COMPLETED' : 'PARTIAL',
      locationsDone: done,
      finishedAt: complete ? new Date() : null,
      error: complete ? null : `${total - done} location(s) incomplete`,
    },
  })

  // Project archives that contain this subject.
  //
  // A ZIP cannot be edited in place and a copy already downloaded cannot be
  // recalled — but an archive still sitting in OUR storage that contains a
  // person who asked to be erased is data we still hold, and that part is
  // reachable. Reconciling package retention with the erasure path means
  // destroying it here rather than leaving it to its own expiry clock.
  let exportsRevoked = 0
  if (job.scope !== 'PARTIAL') {
    try {
      const { revokeExportsContaining } = await import('../projects/projectExport.service.js')
      const revoked = await revokeExportsContaining(job.subjectId)
      exportsRevoked = revoked.revoked
    } catch (err) {
      // Not fatal to the purge, which has already destroyed the source media —
      // but loud, because an archive left behind is exactly the gap this whole
      // phase exists to close.
      logger.error({ err, purgeJobId }, 'could not invalidate project exports for this subject')
    }
  }

  await writeAuditLog({
    entityType: 'DsarRequest',
    entityId: job.dsarRequestId,
    action: complete ? 'PURGE_COMPLETED' : 'PURGE_PARTIAL',
    actorId: admin?.id ?? null,
    payload: { purgeJobId, done, total, failures, residueLocations, exportsRevoked },
  })

  return updated
}

/**
 * @param {string} purgeJobId
 * @param {{ dsarRequestId?: string }} [scope]
 *   The parent the caller reached this job THROUGH. Required by every route that
 *   has one.
 *
 * The route is GET /dsar/:requestId/purge-jobs/:purgeJobId, and :requestId was
 * never validated and never used — so any purge job was readable under any
 * request id, including a garbage one. The URL implied a scoping that nothing
 * enforced.
 *
 * A nested resource that ignores its parent is worth grepping for across every
 * nested route: the shape is invisible in review because the path reads as if
 * the constraint is there.
 */
export async function getPurgeJob(purgeJobId, { dsarRequestId = null } = {}) {
  const job = await prisma.purgeJob.findUnique({
    where: { id: purgeJobId },
    include: { locations: { orderBy: { locationCode: 'asc' } } },
  })
  if (!job) throw new ApiError(404, 'Purge job not found')

  // 404, not 403: a job that does not belong to this request does not exist as
  // far as this URL is concerned, and saying "wrong parent" would confirm the
  // id is real.
  if (dsarRequestId && job.dsarRequestId !== dsarRequestId) {
    throw new ApiError(404, 'Purge job not found')
  }

  return job
}
