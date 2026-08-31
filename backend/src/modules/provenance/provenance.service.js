import { createHash } from 'node:crypto'

import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { readFile } from '../../lib/storage.js'
import { readStamp, subjectRefFor } from '../../lib/imageMetadata.js'
import { recordAccess } from '../../lib/accessLog.js'
import { logger } from '../../lib/logger.js'

// Reading provenance back OUT of an image that has left the platform.
//
// lib/imageMetadata.js has stamped every exported JPEG since the export pipeline
// landed — signed EXIF + XMP carrying projectId, exportId, photoId,
// captureSessionId, consentId and export-scoped subject refs. It also exports
// readStamp(), whose docstring says it is "used by the round-trip test and by the
// verification endpoint". There was no verification endpoint: a repo-wide grep
// for readStamp found the test and nothing else. Every image that ever left the
// platform carried an answer nobody could ask it for.
//
// This is that endpoint. Given a file someone found on a training-data share, it
// answers: is this ours, which project and session did it come from, which export
// took it out and on whose authority, who is in it, and is their consent still
// standing.

/** Ties a stamp field back to a live row, tolerating rows that are legitimately gone. */
async function resolveProject(projectId) {
  if (!projectId) return null
  return prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, purpose: true, retention: true, status: true, createdAt: true },
  })
}

async function resolveSession(sessionId) {
  if (!sessionId) return null
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      id: true, code: true, status: true, location: true, type: true,
      createdAt: true, endedAt: true, archivedAt: true,
      agent: { select: { id: true, email: true, role: true } },
      project: { select: { id: true, name: true, status: true } },
      _count: { select: { photos: true, participants: true } },
    },
  })
  return session
}

async function resolveExport(exportId) {
  if (!exportId) return null
  return prisma.projectExport.findUnique({
    where: { id: exportId },
    select: {
      id: true, status: true, scope: true, createdAt: true, finishedAt: true,
      expiresAt: true, photosTotal: true, subjectCount: true,
      downloadCount: true, lastDownloadedAt: true,
      requestedBy: { select: { id: true, email: true, role: true } },
    },
  })
}

async function resolveConsent(consentId) {
  if (!consentId) return null
  return prisma.projectConsent.findUnique({
    where: { consentId },
    select: {
      consentId: true, status: true, policyVersion: true,
      consentedAt: true, revokedAt: true, projectId: true, subjectId: true,
    },
  })
}

/**
 * Turns export-scoped pseudonyms back into people.
 *
 * The refs are HMAC(subjectId) under a key derived from the export id, so they
 * cannot be inverted — they can only be RE-derived and compared. The candidate
 * set is therefore the subjects the platform still links to this photo, which is
 * both cheap and precise: a few rows, not a scan of every subject.
 *
 * A ref that matches nobody is reported rather than dropped. It means the person
 * was erased after the export — which is the single most important thing this
 * page can tell a DPO, because the copy in their hand is data that survived a
 * deletion the principal was told was complete.
 */
async function resolveSubjects(photoId, exportId, subjectRefs) {
  const refs = new Set(subjectRefs ?? [])
  if (refs.size === 0) return { identified: [], unmatchedRefs: [] }

  const links = photoId
    ? await prisma.photoSubject.findMany({
        where: { photoId },
        select: {
          subjectId: true,
          consent: { select: { consentId: true, status: true, consentedAt: true, revokedAt: true } },
          subject: { select: { masterUserId: true, fullName: true, email: true, status: true } },
        },
      })
    : []

  const identified = []
  const matched = new Set()

  for (const link of links) {
    const ref = subjectRefFor(link.subjectId, exportId)
    if (!refs.has(ref)) continue
    matched.add(ref)
    identified.push({
      ref,
      subjectId: link.subject.masterUserId,
      fullName: link.subject.fullName,
      email: link.subject.email,
      subjectStatus: link.subject.status,
      consent: link.consent,
    })
  }

  return {
    identified,
    unmatchedRefs: [...refs].filter((r) => !matched.has(r)),
  }
}

/**
 * Does the source this image was made from still hash to what the stamp claims?
 *
 * The stamp's contentHash is of the bytes BEFORE stamping — a stamp cannot cover
 * itself — which is exactly the redacted derivative on disk. Re-reading it and
 * re-hashing therefore answers "has the source changed since this left", without
 * needing to strip the stamp back off the uploaded copy.
 */
async function checkSourceIntegrity(photo, claimedHash) {
  if (!photo?.redactedPath || !claimedHash) return { checked: false, reason: 'NO_SOURCE_ON_DISK' }
  try {
    const live = await readFile(photo.redactedPath)
    const hash = createHash('sha256').update(live).digest('hex')
    return { checked: true, matches: hash === claimedHash, liveHash: hash }
  } catch (err) {
    logger.warn({ err, photoId: photo.id }, 'provenance: could not re-read the source derivative')
    return { checked: false, reason: 'SOURCE_UNREADABLE' }
  }
}

export async function identifyImage(buffer, { req, admin }) {
  let read
  try {
    read = await readStamp(buffer)
  } catch (err) {
    // sharp throws on anything that is not a decodable image. That is a 415 about
    // the upload, not a 500 about us.
    throw new ApiError(415, 'That file could not be read as an image.', { cause: err.message })
  }

  const uploadedHash = createHash('sha256').update(buffer).digest('hex')

  if (!read.found) {
    // No stamp. Not necessarily "not ours": a screenshot, a re-encode, or a
    // social-platform upload strips APPn segments, and originals were never
    // stamped at all (the stamp is written at export). An exact byte match
    // against the stored corpus still identifies those.
    return withFallback(uploadedHash, read.reason, { req, admin })
  }

  const payload = read.payload ?? {}

  const photo = payload.photoId
    ? await prisma.photo.findUnique({
        where: { id: payload.photoId },
        select: {
          id: true, sessionId: true, redactedPath: true, piiStatus: true,
          takenAt: true, createdAt: true, mimeType: true, width: true, height: true,
        },
      })
    : null

  const [project, session, exportJob, consent, subjects, integrity] = await Promise.all([
    resolveProject(payload.projectId),
    resolveSession(payload.captureSessionId),
    resolveExport(payload.exportId),
    resolveConsent(payload.consentId),
    resolveSubjects(payload.photoId, payload.exportId, payload.subjectRefs),
    checkSourceIntegrity(photo, payload.contentHash),
  ])

  // Invariant 6, and the reason the answer above is allowed to name people:
  // de-pseudonymising an export ref is itself an intrusion, so it goes on the
  // record against the administrator who did it, per subject, before the
  // response is built. recordAccess throws on write failure — no log, no answer.
  await recordAccess({
    objectType: 'PHOTO',
    objectId: payload.photoId ?? uploadedHash,
    action: 'SEARCH',
    purpose: 'PROVENANCE_LOOKUP',
    projectId: payload.projectId ?? null,
    req,
  })
  for (const person of subjects.identified) {
    await recordAccess({
      objectType: 'SUBJECT_PII',
      objectId: person.subjectId,
      action: 'SEARCH',
      purpose: 'PROVENANCE_LOOKUP_IDENTIFIED',
      projectId: payload.projectId ?? null,
      req,
    })
  }

  return {
    identified: true,
    method: 'STAMP',
    stamp: {
      carrier: read.carrier,
      signature: read.valid ? 'VALID' : (read.reason ?? 'INVALID'),
      // A stamp signed under a rotated key is a real stamp that this process
      // cannot check. Saying which is more useful than calling it invalid.
      keyId: read.keyId ?? null,
      stampedAt: payload.stampedAt ?? null,
      redaction: payload.redaction ?? null,
      version: payload.v ?? null,
    },
    uploadedHash,
    photo: photo
      ? { ...photo, present: true }
      : { id: payload.photoId ?? null, present: false, note: 'The photo row is gone — erased, or the project was purged.' },
    project: project ?? (payload.projectId ? { id: payload.projectId, present: false } : null),
    session: session ?? (payload.captureSessionId ? { id: payload.captureSessionId, present: false } : null),
    export: exportJob ?? (payload.exportId ? { id: payload.exportId, present: false } : null),
    consent,
    subjects,
    sourceIntegrity: integrity,
  }
}

/**
 * The unstamped path: an exact byte match against the stored corpus.
 *
 * Deliberately exact rather than perceptual. A near-match would need a
 * confidence score, and a provenance answer that says "probably this session" is
 * worse than one that says "I cannot tell" — an auditor cannot act on a maybe.
 */
async function withFallback(uploadedHash, reason, { req }) {
  const photo = await prisma.photo.findFirst({
    where: { sha256: uploadedHash },
    select: {
      id: true, sessionId: true, takenAt: true, createdAt: true,
      mimeType: true, piiStatus: true, redactedPath: true, width: true, height: true,
    },
  })

  if (!photo) {
    return {
      identified: false,
      method: null,
      reason: reason === 'NO_METADATA' ? 'NO_METADATA' : 'NO_STAMP_NO_HASH_MATCH',
      uploadedHash,
      note:
        'No PRISM stamp, and the bytes do not match any image held here. Either it did not come from this platform, or it was re-encoded — a screenshot, a resize or a social upload strips the stamp and changes every byte.',
    }
  }

  const session = await resolveSession(photo.sessionId)

  await recordAccess({
    objectType: 'PHOTO',
    objectId: photo.id,
    action: 'SEARCH',
    purpose: 'PROVENANCE_LOOKUP_BY_HASH',
    projectId: session?.project?.id ?? null,
    req,
  })

  return {
    identified: true,
    method: 'CONTENT_HASH',
    stamp: null,
    uploadedHash,
    photo: { ...photo, present: true },
    project: session?.project ? await resolveProject(session.project.id) : null,
    session,
    export: null,
    consent: null,
    // Without a stamp there is no exportId, so there is no key to re-derive the
    // refs under. The people on the frame are knowable from the live link rows —
    // but that is an identity lookup this endpoint was not asked for, and it is
    // what the DSAR discovery workspace exists to do under a request id.
    subjects: { identified: [], unmatchedRefs: [], note: 'Unstamped match — identities are not resolved here.' },
    sourceIntegrity: { checked: false, reason: 'NO_STAMP' },
    note:
      'Matched by exact content hash against the stored original. This image carries no stamp, so it was either taken before the export pipeline stamped it, or copied from storage rather than exported.',
  }
}
