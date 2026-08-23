import { createHash } from 'node:crypto'
import { createWriteStream, createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { logger } from '../../lib/logger.js'
import { readFile, resolvePath } from '../../lib/storage.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { recordAccess } from '../../lib/accessLog.js'
import { consentVerdict, isEligible } from '../../lib/consent.js'
import { RESOLVED_PHOTO_WHERE, UNRESOLVED_PHOTO_WHERE } from '../../lib/photoState.js'
import { zipStream } from '../../lib/zipStream.js'
import {
  stampImage,
  subjectRefFor,
  formatSupportsStamp,
  signStamp,
  buildStampPayload,
} from '../../lib/imageMetadata.js'
import { withAdvisoryLock, LOCK_NAMESPACE } from '../../lib/advisoryLock.js'
import { assertOversight } from './project.service.js'

// The project-wide export.
//
// Scope, as decided and not re-litigated here:
//
//   originals or derivatives   REDACTED DERIVATIVES ONLY. No originals path is
//                              built. This matches ProcessedData.jsx's existing
//                              stance that raw originals stay out of reach for
//                              this role.
//   approval workflow          NONE. The dataOwner exports their own project
//                              directly. The mandatory AccessEvent replaces the
//                              approval gate, which is why it is not optional.
//   who                        dataOwner, own project only, via assertOversight()
//   consent filtering          revoked and expired subjects excluded at BUILD
//                              time, and the exclusion counted in the manifest
//   unresolved frames          a photo that is not terminal never enters the
//                              archive; the build fails and names them
//   delivery                   async job, progress, resumable download
//   archive format             streaming ZIP64, never materialised in memory
//
// ---------------------------------------------------------------------------
// Why the unresolved-frame refusal is the load-bearing part
// ---------------------------------------------------------------------------
// redactBystanders() leaves visible only the boxes tagged to a consented
// participant and blurs everything else — so a redacted derivative shows the
// consented subject and blurs bystanders and PII text. That is what makes
// redacted-only fit for purpose.
//
// But visibility keys on `tagStatus === 'TAGGED'`, so any face the pipeline
// failed to resolve is blurred. An export taken from a session whose processing
// quietly stalled would therefore ship images with the SUBJECT blurred out — and
// it would look like a successful export. There is no error attached to that
// failure anywhere, which is precisely why the build refuses rather than warns.

const EXPORT_TTL_MS = Number(process.env.PROJECT_EXPORT_TTL_MS ?? 7 * 24 * 60 * 60 * 1000)

/** Where a built archive lives. Under the media root, so it is sealed like everything else. */
function exportPath(exportId) {
  return `exports/projects/${exportId}.zip`
}

/** File extension for a stored derivative, from its recorded mime type. */
function extensionFromMime(mimeType, fallback) {
  const known = {
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
    'video/webm': 'webm',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
    'audio/webm': 'webm',
  }
  return known[mimeType] ?? fallback
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export async function requestProjectExport(projectId, admin) {
  const project = await assertOversight(projectId, admin)

  // dpo and dataAdmin reach assertOversight for read-only oversight. Taking a
  // copy of the media out is a different act: it is the data owner's own project
  // and their own accountability, so the floor is narrower than the read floor.
  if (!['dataOwner', 'super_admin'].includes(admin.role)) {
    throw new ApiError(403, 'Only the project owner may export a project')
  }

  const alreadyRunning = await prisma.projectExport.findFirst({
    where: { projectId, status: { in: ['QUEUED', 'RUNNING'] } },
  })
  if (alreadyRunning) return alreadyRunning

  // Refuse up front rather than half-way through a build. The operator needs to
  // know that processing is incomplete BEFORE they wait for an archive.
  const unresolved = await prisma.photo.count({
    where: { session: { projectId }, ...UNRESOLVED_PHOTO_WHERE },
  })
  if (unresolved > 0) {
    const sample = await prisma.photo.findMany({
      where: { session: { projectId }, ...UNRESOLVED_PHOTO_WHERE },
      select: { id: true, sessionId: true, piiStatus: true },
      take: 20,
    })
    throw new ApiError(
      409,
      `Cannot export: ${unresolved} frame(s) in this project have not finished redaction. ` +
        'Exporting now would ship images with the subject blurred out, because redaction only leaves ' +
        'a face visible once it has been tagged. Wait for processing to complete or re-run it.',
      { unresolvedCount: unresolved, unresolvedPhotoIds: sample.map((p) => p.id) },
    )
  }

  const job = await prisma.projectExport.create({
    data: {
      projectId,
      requestedByAdminId: admin.id,
      status: 'QUEUED',
      expiresAt: new Date(Date.now() + EXPORT_TTL_MS),
    },
  })

  await writeAuditLog({
    entityType: 'Project',
    entityId: projectId,
    action: 'PROJECT_EXPORT_REQUESTED',
    actorId: admin.id,
    payload: { exportId: job.id, projectName: project.name },
  })

  const { enqueueProjectExport } = await import('../../lib/exportQueue.js')
  await enqueueProjectExport(job.id)

  return job
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Collects everything the archive will contain, with consent applied.
 *
 * Consent is evaluated HERE, at build time, not at request time. A subject who
 * withdraws while the job is queued must not appear in the archive, and the only
 * way to guarantee that is to read the consent state at the moment the bytes are
 * assembled.
 */
async function collectEntries(exportJob) {
  const { projectId } = exportJob

  const links = await prisma.photoSubject.findMany({
    where: { photo: { session: { projectId }, ...RESOLVED_PHOTO_WHERE } },
    select: {
      id: true,
      subjectId: true,
      consentId: true,
      photo: {
        select: {
          id: true,
          sessionId: true,
          redactedPath: true,
          mimeType: true,
          takenAt: true,
          createdAt: true,
          session: { select: { code: true } },
        },
      },
    },
  })

  const subjectIds = [...new Set(links.map((l) => l.subjectId))]
  const [subjects, consents] = await Promise.all([
    prisma.subject.findMany({ where: { masterUserId: { in: subjectIds } } }),
    prisma.projectConsent.findMany({ where: { projectId, subjectId: { in: subjectIds } } }),
  ])

  const subjectById = new Map(subjects.map((s) => [s.masterUserId, s]))
  const consentBySubject = new Map(consents.map((c) => [c.subjectId, c]))

  const eligible = new Set(
    subjectIds.filter((id) =>
      isEligible(consentVerdict(subjectById.get(id), consentBySubject.get(id))),
    ),
  )

  const excludedSubjects = subjectIds
    .filter((id) => !eligible.has(id))
    .map((id) => ({
      subjectRef: subjectRefFor(id, exportJob.id),
      reason: consentVerdict(subjectById.get(id), consentBySubject.get(id))?.reason ?? 'NOT_ELIGIBLE',
    }))

  // One entry per PHOTO, carrying every eligible subject on it. A photo of two
  // consented people is one file, not two.
  const byPhoto = new Map()
  let excludedPhotos = 0

  for (const link of links) {
    if (!eligible.has(link.subjectId)) continue
    const existing = byPhoto.get(link.photo.id)
    if (existing) {
      existing.subjectIds.add(link.subjectId)
      if (!existing.consentId) existing.consentId = link.consentId
    } else {
      byPhoto.set(link.photo.id, {
        photo: link.photo,
        subjectIds: new Set([link.subjectId]),
        consentId: link.consentId,
      })
    }
  }

  // A photo whose every subject was excluded is a photo that leaves the archive
  // entirely — it is not shipped "with nobody on it".
  const allPhotoIds = new Set(links.map((l) => l.photo.id))
  excludedPhotos = allPhotoIds.size - byPhoto.size

  const media = await collectOtherMedia(projectId, exportJob.id, eligible)

  return {
    photos: [...byPhoto.values()],
    excludedPhotos,
    excludedSubjects,
    eligibleSubjectIds: [...eligible],
    subjectById,
    consentBySubject,
    ...media,
  }
}

/**
 * The clips, recordings and documents, under exactly the photo rules.
 *
 * A project is not only stills. Until this existed the archive shipped photos
 * and silently omitted every video, recording and document in the same project —
 * a manifest that listed 40 files for a session that held 40 photos, one clip
 * and two interviews, with nothing anywhere saying the other three were left
 * behind. An export that is quietly partial is worse than one that refuses.
 *
 * The three rules the photo path already applies are applied here unchanged:
 *
 *   consent      evaluated at BUILD time, per subject, against the same
 *                `eligible` set — one verdict for the whole archive.
 *   derivatives  redacted only. `storagePath` (the original) is never read for
 *                any of these; only `redactedPath` is.
 *   terminal     an item that has not finished redaction does not enter the
 *                archive, and its presence fails the build rather than being
 *                dropped. Same reasoning as UNRESOLVED_PHOTO_WHERE: a clip
 *                whose analysis stalled has no track boxes, so a redaction pass
 *                over it blurs nothing and writes a derivative stamped clean.
 */
async function collectOtherMedia(projectId, exportId, eligible) {
  const inProject = { session: { projectId } }

  const [videoLinks, recordings, documents] = await Promise.all([
    prisma.videoSubject.findMany({
      where: { video: inProject },
      select: {
        subjectId: true,
        consentId: true,
        video: {
          select: {
            id: true,
            sessionId: true,
            status: true,
            redactedPath: true,
            mimeType: true,
            durationSec: true,
            createdAt: true,
            session: { select: { code: true } },
          },
        },
      },
    }),
    prisma.recording.findMany({
      where: inProject,
      select: {
        id: true,
        sessionId: true,
        status: true,
        redactedPath: true,
        mimeType: true,
        durationSec: true,
        createdAt: true,
        session: { select: { code: true } },
        segments: {
          where: { action: 'KEEP' },
          select: { subjectId: true, consentId: true },
        },
      },
    }),
    prisma.textDocument.findMany({
      where: inProject,
      select: {
        id: true,
        sessionId: true,
        name: true,
        status: true,
        redactedPath: true,
        charCount: true,
        createdAt: true,
        session: { select: { code: true } },
        spans: { select: { subjectId: true, consentId: true } },
      },
    }),
  ])

  const unresolved = []

  // --- videos: one entry per clip, carrying every eligible subject on it ------
  const byVideo = new Map()
  for (const link of videoLinks) {
    const { video } = link
    if (video.status !== 'REDACTED' || !video.redactedPath) {
      unresolved.push({ type: 'VIDEO', id: video.id, status: video.status })
      continue
    }
    if (!eligible.has(link.subjectId)) continue
    const existing = byVideo.get(video.id)
    if (existing) {
      existing.subjectIds.add(link.subjectId)
      if (!existing.consentId) existing.consentId = link.consentId
    } else {
      byVideo.set(video.id, {
        asset: video,
        subjectIds: new Set([link.subjectId]),
        consentId: link.consentId,
      })
    }
  }

  // --- recordings: speakers come from the KEEP segments -----------------------
  // A recording's identified speakers are exactly the people a KEEP decision was
  // made for. Everyone else in the room was muted, so they are not "on" the
  // derivative and must not be listed as if they were.
  const audio = []
  for (const rec of recordings) {
    if (rec.status !== 'REDACTED' || !rec.redactedPath) {
      unresolved.push({ type: 'RECORDING', id: rec.id, status: rec.status })
      continue
    }
    const speakers = new Set(rec.segments.map((s) => s.subjectId).filter(Boolean))
    const kept = [...speakers].filter((id) => eligible.has(id))
    if (kept.length === 0 && speakers.size > 0) continue
    audio.push({
      asset: rec,
      subjectIds: new Set(kept),
      consentId: rec.segments.find((s) => s.consentId)?.consentId ?? null,
    })
  }

  // --- documents --------------------------------------------------------------
  const text = []
  for (const doc of documents) {
    if (doc.status !== 'REDACTED' || !doc.redactedPath) {
      unresolved.push({ type: 'DOCUMENT', id: doc.id, status: doc.status })
      continue
    }
    const tagged = new Set(doc.spans.map((s) => s.subjectId).filter(Boolean))
    const kept = [...tagged].filter((id) => eligible.has(id))
    if (kept.length === 0 && tagged.size > 0) continue
    text.push({
      asset: doc,
      subjectIds: new Set(kept),
      consentId: doc.spans.find((s) => s.consentId)?.consentId ?? null,
    })
  }

  return { videos: [...byVideo.values()], audio, text, unresolvedMedia: unresolved }
}

// The archive folder for each kind, and the singular name that goes in the
// manifest. Kept together so the two cannot drift: `kind.toUpperCase()` gave
// rows of PHOTO next to rows of VIDEOS and AUDIO, which a consumer grouping by
// mediaType has to special-case for no reason.
const MEDIA_KINDS = {
  videos: 'VIDEO',
  audio: 'AUDIO',
  text: 'TEXT',
}

/** Turns a collected item into its archive path and manifest row. */
function mediaEntry(kind, item, exportId, { extension, extra = {} }) {
  const { asset, subjectIds, consentId } = item
  const subjectRefs = [...subjectIds].map((id) => subjectRefFor(id, exportId))
  return {
    name: `${kind}/${asset.session.code}/${asset.id}.${extension}`,
    path: asset.redactedPath,
    row: {
      photoId: undefined,
      mediaType: MEDIA_KINDS[kind] ?? kind.toUpperCase(),
      itemId: asset.id,
      captureSessionId: asset.sessionId,
      sessionCode: asset.session.code,
      subjectRefs,
      consentId,
      takenAt: asset.createdAt,
      redaction: 'REDACTED',
      ...extra,
    },
  }
}

/**
 * Builds the archive, streaming it to disk as it goes.
 *
 * Nothing here holds more than one image at a time. The previous writer
 * assembled the whole archive with Buffer.concat before the response started,
 * which at project scale takes the API process down for every other user.
 */
export async function buildProjectExport(exportId) {
  const { acquired, result } = await withAdvisoryLock(
    LOCK_NAMESPACE.EXPORT_PROJECT,
    exportId,
    () => runBuild(exportId),
  )
  if (!acquired) return { skipped: 'ALREADY_BUILDING' }
  return result
}

async function runBuild(exportId) {
  const job = await prisma.projectExport.findUnique({
    where: { id: exportId },
    include: { project: true, requestedBy: { select: { id: true, email: true } } },
  })
  if (!job) throw new ApiError(404, 'Export not found')
  if (job.status === 'READY') return job

  await prisma.projectExport.update({
    where: { id: exportId },
    data: { status: 'RUNNING', startedAt: new Date() },
  })

  try {
    const collected = await collectEntries(job)

    // Second unresolved check, at build time. The request-time check can be
    // hours stale by the time a queued job runs, and this is the check that
    // actually protects the archive's contents.
    const unresolved = await prisma.photo.count({
      where: { session: { projectId: job.projectId }, ...UNRESOLVED_PHOTO_WHERE },
    })
    if (unresolved > 0) {
      throw new ApiError(
        409,
        `Build refused: ${unresolved} frame(s) became unresolved after this export was requested.`,
        { unresolvedCount: unresolved },
      )
    }

    // The same gate for the other three media types. collectOtherMedia records
    // anything it found in a non-terminal state rather than skipping it
    // silently, because "your archive is missing the interview" and "your
    // archive is complete" must not look identical from the outside.
    if (collected.unresolvedMedia.length > 0) {
      const byType = collected.unresolvedMedia.reduce((acc, m) => {
        acc[m.type] = (acc[m.type] ?? 0) + 1
        return acc
      }, {})
      throw new ApiError(
        409,
        'Cannot export: ' +
          Object.entries(byType)
            .map(([type, n]) => `${n} ${type.toLowerCase()}(s)`)
            .join(', ') +
          ' in this project have not finished redaction. Finish or retry them, then export again.',
        { unresolvedMedia: collected.unresolvedMedia.slice(0, 20) },
      )
    }

    await prisma.projectExport.update({
      where: { id: exportId },
      data: {
        // Every file the archive will contain, not only the stills. `written`
        // counts clips, recordings and documents as well, and serialise()
        // divides the two — so a photos-only denominator reported 175% on a
        // project that also held video.
        photosTotal:
          collected.photos.length +
          collected.videos.length +
          collected.audio.length +
          collected.text.length,
        photosExcluded: collected.excludedPhotos,
        subjectCount: collected.eligibleSubjectIds.length,
      },
    })

    const target = exportPath(exportId)
    const absolute = resolvePath(target)
    await fs.mkdir(path.dirname(absolute), { recursive: true })

    const manifestEntries = []
    let written = 0
    let stampFailures = 0

    // Generator: each photo is read, stamped and handed to the zip writer one at
    // a time, and released before the next. This is the whole reason the export
    // can outlive the 4 GiB / 65,535-entry / heap ceilings of the old writer.
    async function* entries() {
      for (const item of collected.photos) {
        const { photo, subjectIds, consentId } = item
        const subjectRefs = [...subjectIds].map((id) => subjectRefFor(id, exportId))

        let buffer
        try {
          buffer = await readFile(photo.redactedPath)
        } catch (err) {
          // A referenced blob that is not on disk. Never shipped silently — the
          // whole build fails, because a project archive that is quietly short
          // is worse than one that did not build.
          throw new ApiError(
            409,
            `Cannot export: the redacted derivative for photo ${photo.id} is not in storage.`,
            { missingItems: [{ type: 'PHOTO', id: photo.id, path: photo.redactedPath }] },
          )
        }

        const name = `photos/${photo.session.code}/${photo.id}.jpg`
        let payload
        let outBuffer = buffer

        if (formatSupportsStamp(photo.mimeType ?? 'image/jpeg')) {
          const stamped = await stampImage(buffer, {
            projectId: job.projectId,
            exportId,
            photoId: photo.id,
            subjectRefs,
            consentId,
            captureSessionId: photo.sessionId,
            redaction: 'REDACTED',
          })
          outBuffer = stamped.buffer
          payload = stamped.payload
        } else {
          // Reported, not hidden. sharp writes EXIF on JPEG/WebP/AVIF but not
          // PNG, and a manifest that claims every image is stamped while some
          // are not is the kind of small lie an auditor finds.
          stampFailures += 1
          payload = null
        }

        manifestEntries.push({
          file: name,
          // mediaType and itemId are carried by every row whatever its kind, so
          // a consumer can walk the manifest uniformly. photoId is kept
          // alongside them because it is the field the existing readers of this
          // file already key on.
          mediaType: 'PHOTO',
          itemId: photo.id,
          photoId: photo.id,
          captureSessionId: photo.sessionId,
          sessionCode: photo.session.code,
          subjectRefs,
          consentId,
          takenAt: photo.takenAt ?? photo.createdAt,
          redaction: 'REDACTED',
          stamped: Boolean(payload),
          contentHash: createHash('sha256').update(outBuffer).digest('hex'),
        })

        written += 1
        if (written % 25 === 0) {
          await prisma.projectExport
            .update({ where: { id: exportId }, data: { photosWritten: written } })
            .catch(() => {})
        }

        yield { name, data: outBuffer, date: photo.takenAt ?? photo.createdAt }
      }

      // Clips, recordings and documents, after the stills. None of these three
      // carries an embedded stamp: EXIF is an image container's feature, and
      // there is no equivalent that survives in an MP4, a WAV and a text file
      // alike. So their provenance lives in manifest.json only, and the
      // manifest row says `stamped: false` rather than implying otherwise.
      const others = [
        ...collected.videos.map((v) =>
          mediaEntry('videos', v, exportId, {
            extension: extensionFromMime(v.asset.mimeType, 'mp4'),
            extra: { durationSec: v.asset.durationSec ?? null },
          }),
        ),
        ...collected.audio.map((a) =>
          mediaEntry('audio', a, exportId, {
            extension: extensionFromMime(a.asset.mimeType, 'wav'),
            extra: { durationSec: a.asset.durationSec ?? null },
          }),
        ),
        ...collected.text.map((t) =>
          mediaEntry('text', t, exportId, {
            extension: 'txt',
            extra: { documentName: t.asset.name, charCount: t.asset.charCount ?? null },
          }),
        ),
      ]

      for (const entry of others) {
        let buffer
        try {
          buffer = await readFile(entry.path)
        } catch {
          // Identical posture to a missing photo derivative: the build fails
          // rather than shipping an archive that is quietly short one file.
          throw new ApiError(
            409,
            `Cannot export: the redacted derivative for ${entry.row.mediaType} ${entry.row.itemId} is not in storage.`,
            { missingItems: [{ type: entry.row.mediaType, id: entry.row.itemId, path: entry.path }] },
          )
        }

        manifestEntries.push({
          file: entry.name,
          ...entry.row,
          stamped: false,
          contentHash: createHash('sha256').update(buffer).digest('hex'),
        })

        written += 1
        yield { name: entry.name, data: buffer, date: entry.row.takenAt ?? new Date() }
      }

      // The manifest goes LAST, because it names every file and their hashes and
      // therefore cannot be written until they exist.
      const manifest = buildManifest(job, collected, manifestEntries, stampFailures)
      yield {
        name: 'manifest.json',
        data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
        store: false,
      }
      yield {
        name: 'subjects.json',
        data: Buffer.from(JSON.stringify(buildSubjectMap(job, collected), null, 2), 'utf8'),
        store: false,
      }
      yield {
        name: 'README.txt',
        data: Buffer.from(README, 'utf8'),
        store: false,
      }
    }

    const hash = createHash('sha256')
    let bytes = 0

    await pipeline(
      Readable.from(
        (async function* () {
          for await (const chunk of zipStream(entries())) {
            hash.update(chunk)
            bytes += chunk.length
            yield chunk
          }
        })(),
      ),
      createWriteStream(absolute),
    )

    const finished = await prisma.projectExport.update({
      where: { id: exportId },
      data: {
        status: 'READY',
        photosWritten: written,
        sizeBytes: BigInt(bytes),
        storagePath: target,
        contentHash: hash.digest('hex'),
        finishedAt: new Date(),
        error: null,
      },
    })

    await writeAuditLog({
      entityType: 'Project',
      entityId: job.projectId,
      action: 'PROJECT_EXPORT_BUILT',
      actorId: job.requestedByAdminId,
      payload: {
        exportId,
        photos: written,
        excludedPhotos: collected.excludedPhotos,
        excludedSubjects: collected.excludedSubjects.length,
        sizeBytes: bytes,
        unstamped: stampFailures,
      },
    })

    logger.info({ exportId, photos: written, bytes }, 'project export built')
    return finished
  } catch (err) {
    logger.error({ err, exportId }, 'project export failed')
    await prisma.projectExport.update({
      where: { id: exportId },
      data: {
        status: 'FAILED',
        error: String(err?.message ?? err).slice(0, 1000),
        finishedAt: new Date(),
      },
    })
    throw err
  }
}

const README = `PRISM project export
====================

WHAT THIS IS
  Redacted derivatives only, across all four capture types:

    photos/     stills. Every face other than a consented participant's is
                blurred, and printed PII (Aadhaar, PAN, plates, ID cards)
                mosaicked.
    videos/     clips. Same rule, applied per track across the frames.
    audio/      recordings. Every span that was not an identified, consented
                speaker is muted, as is every span where spoken PII was found.
    text/       documents. Detected PII and unconsented passages are masked.

  No original capture is included in any of the four, and there is no route in
  the platform that would add one to an archive like this.

IDENTIFIERS
  Images carry a pseudonymous "subjectRef", never a name and never an email.
  The mapping from subjectRef to a real person is in subjects.json, which is one
  access-controlled file rather than 5,000 images each carrying an identity.
  A subjectRef is scoped to THIS export: the same person in a different export
  has a different ref, and neither can be reversed without the signing key.

THE EMBEDDED STAMP
  Each JPEG carries a signed stamp in EXIF (ImageDescription, with a copy in
  UserComment) naming the project, the export, the capture session, the
  subjectRefs, the redaction state and a hash of the image bytes. It is signed
  with the platform's Ed25519 key, so it is tamper-evident.

  It SURVIVES:      renaming, copying, moving, most archive round-trips.
  It does NOT survive: a screenshot, a re-encode that strips metadata, or most
                       social-platform uploads.

  Video, audio and text carry NO embedded stamp — there is no metadata field
  common to MP4, WAV and plain text that would survive the same handling. Their
  provenance is in manifest.json only, and their manifest rows say
  "stamped": false rather than implying a stamp that is not there. If you move
  one of those files out of this archive, take manifest.json with it.

MANIFEST ROWS
  Every file has a row in manifest.json carrying, at minimum: the archive path,
  mediaType, the capture session id and its human code, the subjectRefs present
  in that file, the consent id it was collected under, the capture time, the
  redaction state, and a SHA-256 of the exact bytes shipped. That is what lets
  you answer, later, "who is in this file and which session and project did it
  come from" — for every one of the four media types, not only the stills.

CONSENT
  Subjects who had revoked or expired consent at the moment this archive was
  BUILT are excluded, and manifest.json counts the exclusion. Consent can change
  after this file was written; the manifest's generatedAt is the moment the
  statement was true.

RETENTION
  This archive is personal data. It has an expiry recorded in manifest.json.
  An export taken before an erasure still contains the erased subject — delete
  it when its purpose is served.
`

function buildManifest(job, collected, entries, stampFailures) {
  const body = {
    version: 1,
    packageType: 'PRISM_PROJECT_EXPORT',
    exportId: job.id,
    project: {
      id: job.project.id,
      name: job.project.name,
      purpose: job.project.purpose,
      policyVersion: job.project.policyVersion ?? null,
      retentionDays: job.project.retentionDays ?? null,
    },
    scope: {
      contents: 'REDACTED_DERIVATIVES_ONLY',
      originalsIncluded: false,
      approvalWorkflow: 'NONE — recorded as an AccessEvent instead',
    },
    counts: {
      files: entries.length,
      // Broken out by kind, because "40 files" tells an auditor nothing about
      // whether the clip and the two interviews they know exist are in here.
      photos: entries.filter((e) => e.photoId).length,
      videos: collected.videos.length,
      recordings: collected.audio.length,
      documents: collected.text.length,
      subjects: collected.eligibleSubjectIds.length,
      photosExcludedByConsent: collected.excludedPhotos,
      subjectsExcludedByConsent: collected.excludedSubjects.length,
      imagesWithoutStamp: stampFailures,
    },
    // Named, not just counted. "Three people were excluded" is a fact an auditor
    // can act on only if they can tell WHICH pseudonyms and why.
    excludedSubjects: collected.excludedSubjects,
    requestedBy: job.requestedByAdminId,
    generatedAt: new Date().toISOString(),
    expiresAt: job.expiresAt?.toISOString() ?? null,
    files: entries,
  }

  // The manifest carries its own signature so the file list and the counts are
  // tamper-evident independently of the per-image stamps.
  const signature = signStamp(buildStampPayload({
    projectId: job.projectId,
    exportId: job.id,
    photoId: 'MANIFEST',
    subjectRefs: [],
    redaction: 'REDACTED',
    contentHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  }))

  return { ...body, signature }
}

function buildSubjectMap(job, collected) {
  return {
    note:
      'The subjectRef -> identity mapping for this export. Access-controlled by ' +
      'construction: it is one file, and the images themselves carry only the refs.',
    exportId: job.id,
    subjects: collected.eligibleSubjectIds.map((id) => {
      const subject = collected.subjectById.get(id)
      const consent = collected.consentBySubject.get(id)
      return {
        subjectRef: subjectRefFor(id, job.id),
        masterUserId: id,
        fullName: subject?.fullName ?? null,
        email: subject?.email ?? null,
        employeeRef: subject?.employeeRef ?? null,
        group: subject?.group ?? null,
        consentId: consent?.consentId ?? null,
        consentGrantedAt: consent?.grantedAt ?? null,
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// Read and download
// ---------------------------------------------------------------------------

export async function listProjectExports(projectId, admin) {
  await assertOversight(projectId, admin)
  const rows = await prisma.projectExport.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: 25,
  })
  return rows.map(serialise)
}

export async function getProjectExport(projectId, exportId, admin) {
  await assertOversight(projectId, admin)
  const row = await prisma.projectExport.findFirst({ where: { id: exportId, projectId } })
  if (!row) throw new ApiError(404, 'Export not found')
  return serialise(row)
}

function serialise(row) {
  return {
    ...row,
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
    // The storage path never leaves the process. It is a location for sealed
    // bytes and no client has any use for it.
    storagePath: undefined,
    progress:
      row.photosTotal > 0 ? Math.round((row.photosWritten / row.photosTotal) * 100) : 0,
  }
}

/**
 * Opens a built archive for download, with Range support.
 *
 * Resumable because these are large: a 4 GiB download that has to restart from
 * zero on a dropped connection is a download that never completes on a hotel
 * wifi. The AccessEvent is written BEFORE any byte is read, and it is written on
 * every request including a resumed one — the audit record is the thing that
 * replaces the approval gate, so it is not optional and it is not once-per-file.
 */
export async function openProjectExport(projectId, exportId, admin, { range, req } = {}) {
  await assertOversight(projectId, admin)

  if (!['dataOwner', 'super_admin'].includes(admin.role)) {
    throw new ApiError(403, 'Only the project owner may download a project export')
  }

  const row = await prisma.projectExport.findFirst({ where: { id: exportId, projectId } })
  if (!row) throw new ApiError(404, 'Export not found')
  if (row.status !== 'READY') {
    throw new ApiError(409, `This export is ${row.status.toLowerCase()}, not ready to download`)
  }
  if (row.expiresAt && row.expiresAt < new Date()) {
    await prisma.projectExport.update({ where: { id: exportId }, data: { status: 'EXPIRED' } })
    throw new ApiError(410, 'This export has expired. Request a new one.')
  }

  await recordAccess({
    objectType: 'EXPORT',
    objectId: exportId,
    action: 'EXPORT',
    purpose: 'PROJECT_EXPORT',
    projectId,
    req,
  })

  const absolute = resolvePath(row.storagePath)
  const stat = await fs.stat(absolute).catch(() => null)
  if (!stat) {
    await prisma.projectExport.update({
      where: { id: exportId },
      data: { status: 'FAILED', error: 'archive missing from storage' },
    })
    throw new ApiError(410, 'The archive is no longer in storage. Request a new export.')
  }

  await prisma.projectExport.update({
    where: { id: exportId },
    data: { downloadCount: { increment: 1 }, lastDownloadedAt: new Date() },
  })

  const total = stat.size
  const parsed = parseRange(range, total)

  if (parsed === 'unsatisfiable') {
    throw new ApiError(416, 'Requested range not satisfiable', { limitBytes: total })
  }

  const { start, end } = parsed ?? { start: 0, end: total - 1 }

  return {
    stream: createReadStream(absolute, { start, end }),
    total,
    start,
    end,
    partial: parsed !== null,
    contentHash: row.contentHash,
    filename: `prism-project-${projectId}-${exportId.slice(0, 8)}.zip`,
  }
}

// Single-range only, which is all any real client sends for a resume. A
// multi-range request gets the whole file rather than a wrong answer.
function parseRange(header, total) {
  if (!header || typeof header !== 'string') return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null

  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null

  let start
  let end

  if (rawStart === '') {
    // Suffix range: the last N bytes.
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable'
    start = Math.max(0, total - suffix)
    end = total - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? total - 1 : Number(rawEnd)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'unsatisfiable'
  if (start > end || start >= total) return 'unsatisfiable'
  return { start, end: Math.min(end, total - 1) }
}

/**
 * Deletes archives past their expiry.
 *
 * An export built before an erasure still contains the erased subject, and
 * nothing about the purge path can reach inside a ZIP. Reconciling the two means
 * the archive has to have a life of its own that ENDS, and this is what ends it.
 */
export async function expireProjectExports() {
  const expired = await prisma.projectExport.findMany({
    where: { status: 'READY', expiresAt: { lt: new Date() } },
    select: { id: true, storagePath: true, projectId: true },
  })

  for (const row of expired) {
    if (row.storagePath) {
      await fs.rm(resolvePath(row.storagePath), { force: true }).catch((err) => {
        logger.error({ err, exportId: row.id }, 'could not delete expired export archive')
      })
    }
    await prisma.projectExport.update({
      where: { id: row.id },
      data: { status: 'EXPIRED', storagePath: null, finishedAt: new Date() },
    })
    await writeAuditLog({
      entityType: 'Project',
      entityId: row.projectId,
      action: 'PROJECT_EXPORT_EXPIRED',
      payload: { exportId: row.id },
    }).catch(() => {})
  }

  return { expired: expired.length }
}

/**
 * Invalidates every built archive that contains a subject, immediately.
 *
 * Called from the purge path. A ZIP cannot be edited in place and a downloaded
 * copy cannot be recalled, but an archive still sitting in our storage that
 * contains a person who asked to be erased is data WE still hold — and that part
 * is reachable.
 */
export async function revokeExportsContaining(subjectId) {
  const projects = await prisma.photoSubject.findMany({
    where: { subjectId },
    select: { photo: { select: { session: { select: { projectId: true } } } } },
  })
  const projectIds = [...new Set(projects.map((p) => p.photo?.session?.projectId).filter(Boolean))]
  if (projectIds.length === 0) return { revoked: 0 }

  const affected = await prisma.projectExport.findMany({
    where: { projectId: { in: projectIds }, status: 'READY' },
    select: { id: true, storagePath: true, projectId: true },
  })

  for (const row of affected) {
    if (row.storagePath) {
      await fs.rm(resolvePath(row.storagePath), { force: true }).catch(() => {})
    }
    await prisma.projectExport.update({
      where: { id: row.id },
      data: {
        status: 'EXPIRED',
        storagePath: null,
        error: 'invalidated: contained a subject who exercised erasure',
      },
    })
    await writeAuditLog({
      entityType: 'Project',
      entityId: row.projectId,
      action: 'PROJECT_EXPORT_INVALIDATED_BY_ERASURE',
      payload: { exportId: row.id },
    }).catch(() => {})
  }

  logger.warn({ subjectId, revoked: affected.length }, 'invalidated project exports containing an erased subject')
  return { revoked: affected.length }
}
