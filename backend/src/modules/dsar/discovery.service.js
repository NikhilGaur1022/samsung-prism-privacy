import { prisma } from '../../config/prisma.js'
import { fileExists } from '../../lib/storage.js'
import { indexSubject } from './itemIndex.service.js'
import { logger } from '../../lib/logger.js'

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
  L12_IMPORT_ORIGINAL: 'L12',
  L13_IMPORT_REDACTED: 'L13',
  L14_RECORDING: 'L14',
  L15_RECORDING_REDACTED: 'L15',
  // The voice counterpart of L4/L5. Given their own codes rather than folded
  // into L4/L5 because the purge handlers dispatch on the location code and then
  // delete by id from ONE table — an L5 row carrying a voice enrollment's id
  // would hit subjectFaceEnrollment.deleteMany, match nothing, and report
  // SKIPPED while the voice print survived. A certificate that names the wrong
  // table is worse than one that names an extra code.
  L16_VOICE_ENROLLMENT: 'L16',
  L17_VOICE_EMBEDDING: 'L17',
  // The text counterpart of L14/L15, and split off for the same reason those
  // were: a purge handler dispatches on the code and then deletes from ONE
  // table, so a TextDocument reported under L2 would be handed to the photo
  // handler, match nothing, and report SKIPPED while the document survived.
  L18_TEXT_DOCUMENT: 'L18',
  L19_TEXT_DOCUMENT_REDACTED: 'L19',
  // The video counterpart of L14/L15, split off for exactly the reason those
  // were: a purge handler dispatches on the code and deletes from ONE table, so
  // a VideoAsset reported under L2 would be handed to the photo handler, match
  // nothing, and report SKIPPED while the clip survived — and the certificate
  // would say the erasure was complete.
  L20_VIDEO: 'L20',
  L21_VIDEO_REDACTED: 'L21',
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
  const [
    subject,
    consents,
    photoLinks,
    enrollments,
    voiceEnrollments,
    participations,
    dsarRequests,
    textSpans,
  ] = await Promise.all([
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
    prisma.subjectVoiceEnrollment.findMany({
      where: { subjectId },
      select: { id: true, audioPath: true, sha256: true, embedding: true, encKeyId: true, deletedAt: true },
    }),
    prisma.sessionParticipant.findMany({
      where: { subjectId },
      select: { id: true, sessionId: true, consentId: true },
    }),
    prisma.dsarRequest.findMany({
      where: { subjectId },
      select: { id: true, type: true, status: true, createdAt: true },
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

  // Every recording this subject is audible in, with the whole segment set so
  // the sole-speaker test is made against the recording and not against this
  // subject's slice of it.
  const recordings = await prisma.recording.findMany({
    where: { segments: { some: { subjectId } } },
    select: {
      id: true,
      sessionId: true,
      storagePath: true,
      redactedPath: true,
      status: true,
      sha256: true,
      segments: { select: { id: true, subjectId: true, startSec: true, endSec: true, action: true } },
    },
  })

  // Every clip this subject was tagged in, with the whole track set so the
  // sole-appearance test is made against the clip and not against this
  // subject's slice of it — the same shape as `recordings` above.
  const videos = await prisma.videoAsset.findMany({
    where: {
      OR: [
        { subjects: { some: { subjectId } } },
        { tracks: { some: { taggedSubjectId: subjectId } } },
      ],
    },
    select: {
      id: true,
      sessionId: true,
      storagePath: true,
      redactedPath: true,
      status: true,
      sha256: true,
      tracks: {
        select: { id: true, taggedSubjectId: true, tagStatus: true, startSec: true, endSec: true, cropPath: true },
      },
      subjects: { select: { id: true, subjectId: true, consentId: true } },
    },
  })

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
  const multiSpeakerRecordings = []
  // Voice attributions are the erasure key for audio exactly as PhotoSubject is
  // for stills, so the summary has to state how many of them exist. It listed
  // recordings only, which counts the files and not the claims about who is on
  // them — and the claims are what a deletion certificate has to account for.
  let audioSegments = 0
  // Same reasoning as audioSegments: the summary has to state how many
  // attributions exist, not just how many files, because the attributions are
  // what the certificate has to account for.
  let videoTracks = 0
  const multiSubjectVideos = []

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

  // ---- L14 recordings, L15 muted derivatives, SEGMENT attributions ----------
  // Shaped exactly like the photo block above, and for the same reason: a
  // recording holding A and B, where A erases, must survive for B with A's spans
  // muted. The difference is that audio CAN be selectively rewritten, so unlike
  // an L2 original a multi-speaker L14 is re-redacted rather than destroyed.
  for (const recording of recordings) {
    const mine = recording.segments.filter((s) => s.subjectId === subjectId)
    const otherSpeakers = [
      ...new Set(
        recording.segments.map((s) => s.subjectId).filter((id) => id && id !== subjectId),
      ),
    ]
    const soleSpeaker = otherSpeakers.length === 0

    if (!soleSpeaker) {
      multiSpeakerRecordings.push({ recordingId: recording.id, otherSpeakers })
    }

    // The attribution rows are the erasure key, exactly as PhotoSubject is. They
    // always go: after this, nothing in the system says this voice was theirs.
    audioSegments += mine.length
    locations.push(
      location('SEGMENT', 'AudioSegment', recording.id, null, {
        recordingId: recording.id,
        segmentIds: mine.map((s) => s.id),
        segments: mine.length,
        note: 'voice attributions — deleted per subject, never per recording',
      }),
    )

    locations.push(
      location(LOCATIONS.L14_RECORDING, 'Recording.storagePath', recording.id, recording.storagePath, {
        sha256: recording.sha256 || null,
        sessionId: recording.sessionId,
        soleSpeaker,
        // Unlike an L2 photo original, audio is selectively rewritable: the
        // subject's spans can be muted out of the file while the remaining
        // speakers keep theirs. Destroying a shared recording outright would
        // erase consenting speakers' data along with this subject's.
        action: soleSpeaker ? 'DELETE' : 'MUTE_SPEAKER',
        mutedSeconds: Number(
          mine.reduce((n, s) => n + Math.max(0, s.endSec - s.startSec), 0).toFixed(2),
        ),
      }),
    )

    if (recording.redactedPath) {
      locations.push(
        location(
          LOCATIONS.L15_RECORDING_REDACTED,
          'Recording.redactedPath',
          recording.id,
          recording.redactedPath,
          { soleSpeaker, action: soleSpeaker ? 'DELETE' : 'REBUILD' },
        ),
      )
    }
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

  // ---- L16 voice clips + L17 voice embeddings -------------------------------
  // Same structure as L4/L5 above, because a voice print is §2 sensitive
  // personal data on the same footing as a face embedding. Both are sealed under
  // the per-subject DEK, so the SubjectKey location below crypto-shreds them
  // together as a backstop — but the row and the file are still destroyed
  // explicitly, because a certificate must name what it destroyed.
  for (const enrollment of voiceEnrollments) {
    locations.push(
      location(
        LOCATIONS.L16_VOICE_ENROLLMENT,
        'SubjectVoiceEnrollment.audioPath',
        enrollment.id,
        enrollment.audioPath,
        {
          sha256: enrollment.sha256,
          alreadySoftDeleted: Boolean(enrollment.deletedAt),
        },
      ),
    )
    if (enrollment.embedding) {
      locations.push(
        location(LOCATIONS.L17_VOICE_EMBEDDING, 'SubjectVoiceEnrollment.embedding', enrollment.id, null, {
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

  // ---- L20 clips, L21 blurred derivatives, TRACK attributions ---------------
  // Shaped exactly like the recording block, and for the same reason: a clip
  // holding A and B, where A erases, must survive for B with A blurred out.
  // Video CAN be selectively re-blurred — rebuildRedactedVideoForRemaining
  // exists for precisely this — so a multi-subject L20 is re-redacted rather
  // than destroyed, exactly as a multi-speaker L14 is.
  //
  // None of this was reachable before 2026-08-21: discovery had no video query
  // at all, so a subject tagged in a clip could be purged, certified and told
  // their data was destroyed while their face was still in the footage.
  for (const video of videos) {
    const mine = video.tracks.filter((t) => t.taggedSubjectId === subjectId)
    // Judged from the consent LINKS, not from the tracks: the link is what makes
    // another person's presence lawful, and it is what redactVideos reads to
    // decide who stays visible. A clip can hold a track for someone whose link
    // was never written, and treating that as "another subject is here" would
    // spare an original that nobody is entitled to.
    const otherSubjects = [
      ...new Set(
        [
          ...video.subjects.map((l) => l.subjectId),
          ...video.tracks.map((t) => t.taggedSubjectId),
        ].filter((id) => id && id !== subjectId),
      ),
    ]
    const soleSubject = otherSubjects.length === 0

    if (!soleSubject) {
      multiSubjectVideos.push({ videoId: video.id, otherSubjects })
    }

    // The attribution rows are the erasure key, exactly as PhotoSubject and
    // AudioSegment are. They always go: after this, nothing in the system says
    // this face was theirs.
    videoTracks += mine.length

    // The consent link, and the video counterpart of LINK. Deleting it is what
    // makes the clip no longer lawfully hold this person, and — because
    // redactVideos derives its keep-visible set from exactly these rows — it is
    // also what makes a rebuilt derivative blur them.
    for (const link of video.subjects.filter((l) => l.subjectId === subjectId)) {
      locations.push(
        location('VLINK', 'VideoSubject', link.id, null, {
          videoId: video.id,
          consentId: link.consentId,
          note: 'video consent link — the erasure key for this clip',
        }),
      )
    }

    locations.push(
      location('TRACK', 'VideoFaceTrack', video.id, null, {
        videoId: video.id,
        trackIds: mine.map((t) => t.id),
        tracks: mine.length,
        note: 'face attributions in video — deleted per subject, never per clip',
      }),
    )

    // The track crops are separate files, cut per track, and are the video
    // equivalent of L3. Missing them would leave a recognisable face on disk
    // after a signed certificate said otherwise.
    for (const track of mine) {
      if (!track.cropPath) continue
      locations.push(
        location(LOCATIONS.L3_FACE_CROP, 'VideoFaceTrack.cropPath', track.id, track.cropPath, {
          videoId: video.id,
          note: 'video track representative crop',
        }),
      )
    }

    if (video.redactedPath) {
      locations.push(
        location(LOCATIONS.L21_VIDEO_REDACTED, 'VideoAsset.redactedPath', video.id, video.redactedPath, {
          soleSubject,
          action: soleSubject ? 'DELETE' : 'REREDACT',
        }),
      )
    }

    locations.push(
      location(LOCATIONS.L20_VIDEO, 'VideoAsset.storagePath', video.id, video.storagePath, {
        sha256: video.sha256 || null,
        sessionId: video.sessionId,
        soleSubject,
        action: soleSubject ? 'DELETE' : 'RETAIN',
      }),
    )
  }

  // ---- L18 text documents, L19 redacted derivatives, SPAN attributions -----
  // Shaped exactly like the L14/L15 audio block above, and for the same reason:
  // a document naming A and B, where A erases, must survive for B with A's
  // spans blanked. Text is selectively rewritable in the same way audio is, so a
  // shared document is re-redacted rather than destroyed.
  //
  // Discovery only. purge.service.js plans its own location list and has no L18/
  // L19/SPAN handler yet, so an erasure will not touch these — they are listed
  // here so a DSAR access request is complete and so the gap is visible rather
  // than silent.
  const seenDocuments = new Set()
  for (const span of textSpans) {
    if (!span.document || seenDocuments.has(span.document.id)) continue
    seenDocuments.add(span.document.id)

    const mine = textSpans.filter((sp) => sp.documentId === span.documentId)

    locations.push(
      location('SPAN', 'TextSpan', span.document.id, null, {
        documentId: span.document.id,
        spanIds: mine.map((sp) => sp.id),
        spans: mine.length,
        note: 'text attributions — deleted per subject, never per document',
      }),
    )

    locations.push(
      location(
        LOCATIONS.L18_TEXT_DOCUMENT,
        'TextDocument.storagePath',
        span.document.id,
        span.document.storagePath,
        { sessionId: span.document.sessionId, action: 'REREDACT' },
      ),
    )

    if (span.document.redactedPath) {
      locations.push(
        location(
          LOCATIONS.L19_TEXT_DOCUMENT_REDACTED,
          'TextDocument.redactedPath',
          span.document.id,
          span.document.redactedPath,
          { sessionId: span.document.sessionId, action: 'REBUILD' },
        ),
      )
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

  // The item index is a projection of exactly this walk, refreshed here so a
  // discovery result and the index can never disagree about what is held.
  //
  // Deliberately non-fatal, and the one place in this module that swallows an
  // error: the index is derived data, while runDiscovery() is what
  // createPurgeJob() builds an erasure from. Failing the walk because a
  // rebuildable projection could not be written would block a deletion the
  // principal is entitled to, which is strictly worse than a stale index — and
  // the next discovery run rebuilds it.
  //
  // Non-fatal is NOT silent. Since Phase 4 the DSAR item grid serves its
  // completeness claim from this index, so a failure here is an operator-visible
  // condition: it goes to the structured logger under a fixed `alert` key so it
  // can be alerted on, and the next listing cross-checks the index against the
  // source tables and rebuilds it before serving.
  try {
    await indexSubject(subjectId)
  } catch (err) {
    logger.error(
      { alert: 'ITEM_INDEX_REFRESH_FAILED', err, subjectId, at: 'runDiscovery' },
      'item index refresh failed during discovery — DSAR completeness may be stale until the next listing repairs it',
    )
  }

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
      voiceEnrollments: voiceEnrollments.length,
      consents: consents.length,
      recordings: recordings.length,
      audioSegments,
      videos: videos.length,
      videoTracks,
      multiSubjectVideos: multiSubjectVideos.length,
      multiSpeakerRecordings: multiSpeakerRecordings.length,
      textSpans: textSpans.length,
      textDocuments: seenDocuments.size,
    },
    multiSubjectPhotos,
    multiSpeakerRecordings,
    multiSubjectVideos,
    locations,
  }
}
