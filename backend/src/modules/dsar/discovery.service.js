import { prisma } from '../../config/prisma.js'
import { fileExists } from '../../lib/storage.js'

// Answers "everywhere this person exists", in the same L-code vocabulary the
// privacy dataflow and the DPIA use, so a discovery result, a purge job and a
// deletion certificate all name the same places the same way.
//
// It is read-only and it over-reports rather than under-reports: a location that
// turns out to be already empty costs one SKIPPED row, whereas a location the
// walk failed to name is data that survives an erasure the principal was told
// was complete.

export const LOCATIONS = {
  L2_ORIGINAL: 'L2',
  L3_FACE_CROP: 'L3',
  L4_ENROLLMENT_SELFIE: 'L4',
  L5_EMBEDDING: 'L5',
  L6_REDACTED: 'L6',
  L7_PER_PERSON: 'L7',
  L8_VAULT: 'L8',
  L9_EXPORT: 'L9',
  L10_DSAR_PACKAGE: 'L10',
  L11_BACKUP: 'L11',
}

function location(locationCode, objectType, objectId, storagePath = null, meta = {}) {
  return { locationCode, objectType, objectId: objectId ?? null, storagePath, ...meta }
}

/**
 * Walks everything reachable from one subject.
 *
 * @returns {Promise<{subjectId, generatedAt, counts, locations, multiSubjectPhotos}>}
 *   `multiSubjectPhotos` is the list that makes erasure safe: photos where this
 *   subject is not the only one present. Those photos must survive, be
 *   re-redacted, and never be handed to a delete.
 */
export async function runDiscovery(subjectId) {
  const [subject, consents, photoLinks, enrollments, participations, dsarRequests, audioSegments, textSpans] = await Promise.all([
    prisma.subject.findUnique({
      where: { masterUserId: subjectId },
      select: { masterUserId: true, fullName: true, email: true, status: true, createdAt: true },
    }),
    prisma.projectConsent.findMany({
      where: { subjectId },
      select: { consentId: true, projectId: true, status: true, consentedAt: true, revokedAt: true },
    }),
    prisma.photoSubject.findMany({
      where: { subjectId },
      select: {
        id: true,
        photoId: true,
        consentId: true,
        photo: {
          select: {
            id: true,
            sessionId: true,
            storagePath: true,
            redactedPath: true,
            sha256: true,
            subjects: { select: { subjectId: true } },
          },
        },
      },
    }),
    prisma.subjectFaceEnrollment.findMany({
      where: { subjectId },
      select: { id: true, imagePath: true, sha256: true, embedding: true, encKeyId: true, deletedAt: true },
    }),
    prisma.sessionParticipant.findMany({
      where: { subjectId },
      select: { id: true, sessionId: true, consentId: true },
    }),
    prisma.dsarRequest.findMany({
      where: { subjectId },
      select: { id: true, type: true, status: true, createdAt: true },
    }),
    prisma.audioSegment.findMany({
      where: { subjectId },
      include: {
        recording: {
          select: {
            id: true,
            sessionId: true,
            storagePath: true,
            redactedPath: true,
            status: true,
          },
        },
      },
    }),
    prisma.textSpan.findMany({
      where: { subjectId },
      include: {
        document: {
          select: {
            id: true,
            sessionId: true,
            storagePath: true,
            redactedPath: true,
            status: true,
          },
        },
      },
    }),
  ])

  const faces = await prisma.faceDetection.findMany({
    where: {
      OR: [
        { taggedSubjectId: subjectId },
        // Crops on photos this subject appears in but which were never tagged to
        // anyone are still potentially crops OF this subject — an untagged face
        // on a two-person photo is not evidence that it belongs to the other one.
        { photoId: { in: photoLinks.map((l) => l.photoId) }, taggedSubjectId: null },
      ],
    },
    select: { id: true, photoId: true, cropPath: true, taggedSubjectId: true },
  })

  const locations = []
  const multiSubjectPhotos = []

  // ---- L2 originals, L6 redacted, L7 per-person cache -----------------------
  for (const link of photoLinks) {
    const photo = link.photo
    const otherSubjects = photo.subjects.map((s) => s.subjectId).filter((id) => id !== subjectId)
    const soleSubject = otherSubjects.length === 0

    if (!soleSubject) {
      multiSubjectPhotos.push({ photoId: photo.id, otherSubjects })
    }

    // The link row itself is the erasure key. It always goes.
    locations.push(
      location('LINK', 'PhotoSubject', link.id, null, {
        photoId: photo.id,
        consentId: link.consentId,
        note: 'consent link — deleted per subject, never per photo',
      }),
    )

    // §6.2: the original is unredactable evidence, so it goes as soon as ANY
    // subject on it has erased — including when others remain, because there is
    // no way to blur one person out of a file we are keeping byte-for-byte.
    locations.push(
      location(LOCATIONS.L2_ORIGINAL, 'Photo.storagePath', photo.id, photo.storagePath, {
        sha256: photo.sha256,
        sessionId: photo.sessionId,
        soleSubject,
      }),
    )

    if (photo.redactedPath) {
      locations.push(
        location(LOCATIONS.L6_REDACTED, 'Photo.redactedPath', photo.id, photo.redactedPath, {
          soleSubject,
          // The distinction the multi-subject rule turns on: delete only when
          // nobody else is lawfully in the frame, otherwise rebuild it with this
          // subject blurred so the remaining subject keeps their photo.
          action: soleSubject ? 'DELETE' : 'REREDACT',
        }),
      )
    }

    locations.push(
      location(
        LOCATIONS.L7_PER_PERSON,
        'Photo.personCache',
        photo.id,
        `sessions/${photo.sessionId}/redacted/${photo.id}.person-${subjectId}.jpg`,
        { note: 'per-person derivative cache' },
      ),
    )
  }

  // ---- L3 face crops --------------------------------------------------------
  for (const face of faces) {
    locations.push(
      location(LOCATIONS.L3_FACE_CROP, 'FaceDetection', face.id, face.cropPath, {
        photoId: face.photoId,
        tagged: Boolean(face.taggedSubjectId),
      }),
    )
  }

  // ---- L4 selfies + L5 embeddings ------------------------------------------
  for (const enrollment of enrollments) {
    locations.push(
      location(LOCATIONS.L4_ENROLLMENT_SELFIE, 'SubjectFaceEnrollment.imagePath', enrollment.id, enrollment.imagePath, {
        sha256: enrollment.sha256,
        alreadySoftDeleted: Boolean(enrollment.deletedAt),
      }),
    )
    if (enrollment.embedding) {
      locations.push(
        location(LOCATIONS.L5_EMBEDDING, 'SubjectFaceEnrollment.embedding', enrollment.id, null, {
          encKeyId: enrollment.encKeyId,
          note: 'row deleted and per-subject DEK destroyed',
        }),
      )
    }
  }

  // The key itself is a location. It is deliberately the LAST thing destroyed —
  // destroying it early would make the blobs we still have to hash unreadable,
  // and the hash-before is the evidence.
  locations.push(
    location(LOCATIONS.L5_EMBEDDING, 'SubjectKey', subjectId, null, {
      note: 'per-subject DEK — crypto-shred, executed last',
    }),
  )

  // ---- Identity, consents, roster ------------------------------------------
  for (const consent of consents) {
    locations.push(
      location('CONSENT', 'ProjectConsent', consent.consentId, null, {
        projectId: consent.projectId,
        status: consent.status,
        // §6.2: the row survives with status PURGED. Deleting it would destroy
        // the proof that consent was ever given, which the fiduciary must keep to
        // show the collection was lawful at the time.
        action: 'MARK_PURGED',
      }),
    )
  }

  for (const participation of participations) {
    locations.push(
      location('ROSTER', 'SessionParticipant', participation.id, null, {
        sessionId: participation.sessionId,
      }),
    )
  }

    if (subject) {
    locations.push(location('PII', 'Subject', subject.masterUserId, null, { action: 'ANONYMISE' }))
  }

  // ---- Audio recordings & segments ------------------------------------------
  const seenRecordings = new Set()
  for (const seg of audioSegments) {
    locations.push(
      location('AUDIO_SEGMENT', 'AudioSegment', seg.id, null, {
        recordingId: seg.recordingId,
        consentId: seg.consentId,
        startSec: seg.startSec,
        endSec: seg.endSec,
        action: seg.action,
        reason: seg.reason,
      }),
    )

    if (seg.recording && !seenRecordings.has(seg.recording.id)) {
      seenRecordings.add(seg.recording.id)
      locations.push(
        location(LOCATIONS.L2_ORIGINAL, 'Recording.storagePath', seg.recording.id, seg.recording.storagePath, {
          sessionId: seg.recording.sessionId,
          consentId: seg.consentId,
        }),
      )
      if (seg.recording.redactedPath) {
        locations.push(
          location(LOCATIONS.L6_REDACTED, 'Recording.redactedPath', seg.recording.id, seg.recording.redactedPath, {
            sessionId: seg.recording.sessionId,
            consentId: seg.consentId,
            action: 'REREDACT',
          }),
        )
      }
    }
  }

  // ---- Text documents & spans ---------------------------------------------
  const seenDocuments = new Set()
  for (const span of textSpans) {
    locations.push(
      location('TEXT_SPAN', 'TextSpan', span.id, null, {
        documentId: span.documentId,
        consentId: span.consentId,
        startChar: span.startChar,
        endChar: span.endChar,
        action: span.action,
        reason: span.reason,
      }),
    )

    if (span.document && !seenDocuments.has(span.document.id)) {
      seenDocuments.add(span.document.id)
      locations.push(
        location(LOCATIONS.L2_ORIGINAL, 'TextDocument.storagePath', span.document.id, span.document.storagePath, {
          sessionId: span.document.sessionId,
          consentId: span.consentId,
        }),
      )
      if (span.document.redactedPath) {
        locations.push(
          location(LOCATIONS.L6_REDACTED, 'TextDocument.redactedPath', span.document.id, span.document.redactedPath, {
            sessionId: span.document.sessionId,
            consentId: span.consentId,
            action: 'REREDACT',
          }),
        )
      }
    }
  }

  // ---- L9/L10 packages ------------------------------------------------------
  const evidence = await prisma.dsarEvidence.findMany({
    where: { dsarRequestId: { in: dsarRequests.map((r) => r.id) }, storagePath: { not: null } },
    select: { id: true, storagePath: true, kind: true },
  })
  for (const item of evidence) {
    locations.push(
      location(
        item.kind === 'EXPORT_PACKAGE' ? LOCATIONS.L10_DSAR_PACKAGE : LOCATIONS.L9_EXPORT,
        'DsarEvidence.storagePath',
        item.id,
        item.storagePath,
      ),
    )
  }

  // ---- L8 vault, L11 backups ------------------------------------------------
  // Both are reported as tombstones rather than omitted. L8 has no implementation
  // yet, and silently leaving it out of a discovery result would make the result
  // read as "there is nothing there" instead of "this is not built". L11 exists
  // and genuinely cannot be rewritten; crypto-shredding is the whole answer.
  locations.push(
    location(LOCATIONS.L8_VAULT, 'VaultObject', subjectId, null, {
      action: 'TOMBSTONE',
      note: 'vault ingest is not implemented; nothing to purge, recorded so the gap is visible',
    }),
  )
  locations.push(
    location(LOCATIONS.L11_BACKUP, 'Backup', subjectId, null, {
      action: 'TOMBSTONE',
      note: 'backup media cannot be rewritten; covered by destroying the per-subject DEK',
    }),
  )

  // Existence check on disk, so the purge does not report "deleted" for objects
  // that were already gone and does not silently skip ones that are still there.
  await Promise.all(
    locations
      .filter((l) => l.storagePath)
      .map(async (l) => {
        l.present = await fileExists(l.storagePath).catch(() => false)
      }),
  )

  return {
    subjectId,
    generatedAt: new Date().toISOString(),
    subjectExists: Boolean(subject),
    counts: {
      total: locations.length,
      photos: photoLinks.length,
      multiSubjectPhotos: multiSubjectPhotos.length,
      faceCrops: faces.length,
      enrollments: enrollments.length,
      consents: consents.length,
      audioSegments: audioSegments.length,
      recordings: seenRecordings.size,
      textSpans: textSpans.length,
      textDocuments: seenDocuments.size,
    },
    multiSubjectPhotos,
    locations,
  }
}
