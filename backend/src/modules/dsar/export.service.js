import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { recordAccess } from '../../lib/accessLog.js'
import { readFile, writeFile, shredFile, fileExists } from '../../lib/storage.js'
import { createZip } from '../../lib/zip.js'
import { logger } from '../../lib/logger.js'
import { extensionFor } from '../recordings/recording.service.js'
import { isUnresolved } from '../../lib/photoState.js'

// DPDP §11 fulfilment: the summary of personal data being processed, plus the
// data itself, packaged for one principal.
//
// Two rules shape what goes in:
//   - Redacted derivatives only. The package will land in a personal mailbox or
//     downloads folder, entirely outside our control. Shipping originals would
//     export every bystander in the frame along with the requester, which is a
//     disclosure of other people's data made in the name of privacy.
//   - No embeddings, ever (invariant 3). A face template is the one artifact that
//     is both irrevocable and directly re-identifying; §11 asks for a summary of
//     what is processed, and "a 512-dimension vector" is that summary.

const PACKAGE_TTL_DAYS = Number(process.env.DSAR_PACKAGE_TTL_DAYS ?? 30)

// The archive is built in memory because storage.writeFile seals the whole blob
// under one AES-GCM envelope — there is no partial-seal API to stream into, and
// inventing one would put an unsealed temp file on disk, which is the thing the
// sealed-media guarantee exists to prevent. So the cap is the mitigation: a
// package that would exceed it fails with an instruction instead of taking the
// API process down with it. Selective export (below) is what keeps real requests
// under it.
const PACKAGE_MAX_BYTES = Number(process.env.DSAR_PACKAGE_MAX_BYTES ?? 512 * 1024 * 1024)

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Resolves what the operator asked to package into a set of PhotoSubject link
 * ids, or null for "everything".
 *
 * Selection is expressed over the ITEM INDEX rather than over photos, so the
 * package and the item grid are describing the same objects with the same ids.
 * The subject scope on every query is what stops an id list from another
 * principal's grid pulling their photos into this package.
 */
async function resolveSelection(subjectId, dsarRequestId, selection) {
  if (!selection || selection === 'ALL') {
    return { linkIds: null, recordingIds: null, descriptor: { mode: 'ALL' } }
  }

  let items
  let descriptor

  if (selection === 'SELECTED') {
    // Phase 5's EXPORT action is a marker with no side effect. This is where it
    // acquires one: whatever the operator ticked for export, gets exported.
    const actions = await prisma.dsarItemAction.findMany({
      where: { dsarRequestId, kind: 'EXPORT', status: 'DONE' },
      select: { itemId: true },
    })
    items = await prisma.subjectDataItem.findMany({
      where: { id: { in: actions.map((a) => a.itemId) }, subjectId },
      select: { sourceTable: true, sourceId: true },
    })
    descriptor = { mode: 'SELECTED', markedItems: actions.length }
  } else if (Array.isArray(selection.itemIds)) {
    items = await prisma.subjectDataItem.findMany({
      where: { id: { in: selection.itemIds }, subjectId },
      select: { id: true, sourceTable: true, sourceId: true },
    })
    if (items.length !== new Set(selection.itemIds).size) {
      throw new ApiError(403, "Some selected items do not belong to this request's data principal")
    }
    descriptor = { mode: 'ITEM_IDS', itemIds: selection.itemIds }
  } else if (selection.filter) {
    const { type, origin, projectId, from, to } = selection.filter
    items = await prisma.subjectDataItem.findMany({
      where: {
        subjectId,
        deletedAt: null,
        ...(type ? { type } : {}),
        ...(origin ? { origin } : {}),
        ...(projectId ? { projectId } : {}),
        ...(from || to
          ? { capturedAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } }
          : {}),
      },
      select: { sourceTable: true, sourceId: true },
    })
    descriptor = { mode: 'FILTER', filter: selection.filter }
  } else {
    throw new ApiError(400, "selection must be 'ALL', 'SELECTED', { itemIds } or { filter }")
  }

  return {
    linkIds: new Set(items.filter((i) => i.sourceTable === 'photo_subjects').map((i) => i.sourceId)),
    recordingIds: new Set(items.filter((i) => i.sourceTable === 'recordings').map((i) => i.sourceId)),
    descriptor,
  }
}

/**
 * Builds the §11 access package.
 *
 * The archive is written through storage.writeFile under an export scope, so at
 * rest it is sealed with a key that is not the project key — destroying that key
 * crypto-shreds the package independently of everything else.
 *
 * `selection` narrows what goes in. It defaults to 'ALL', which is the whole
 * subject and the behaviour every existing caller and test relies on. A narrowed
 * package is self-describing: the manifest states the selection, how many items
 * it covered and how many were left out, so a partial package can never be read
 * as a complete §11 answer.
 */
export async function buildAccessPackage(dsarRequestId, admin = null, { selection = 'ALL' } = {}) {
  const request = await prisma.dsarRequest.findUnique({ where: { id: dsarRequestId } })
  if (!request) throw new ApiError(404, 'DSAR request not found')
  // An ACCESS request produces the principal's own §11 package on any path. Any
  // other type produces one only when a handler asked for it: a package built
  // while working an erasure or a grievance is a handler's working copy, and it
  // is recorded as EXPORT_PACKAGE evidence exactly like the §11 one so it cannot
  // be produced off the record.
  if (request.type !== 'ACCESS' && !admin) {
    throw new ApiError(400, `DSAR type ${request.type} does not produce an access package`)
  }

  const subjectId = request.subjectId
  const { linkIds, recordingIds, descriptor } = await resolveSelection(subjectId, dsarRequestId, selection)

  // prettier-ignore
  const [subject, consents, links, recordings, enrollments, voiceEnrollments, accessEvents, textSpans] = await Promise.all([
    prisma.subject.findUnique({
      where: { masterUserId: subjectId },
      select: {
        masterUserId: true,
        fullName: true,
        email: true,
        phone: true,
        group: true,
        status: true,
        employeeRef: true,
        registrationChannel: true,
        dateOfBirth: true,
        guardianContact: true,
        nomineeContact: true,
        createdAt: true,
      },
    }),
    prisma.projectConsent.findMany({
      where: { subjectId },
      select: {
        consentId: true,
        status: true,
        consentedAt: true,
        revokedAt: true,
        policyVersion: true,
        signatureHash: true,
        project: { select: { id: true, name: true, purpose: true, retention: true, policyVersion: true } },
      },
    }),
    prisma.photoSubject.findMany({
      where: { subjectId },
      select: {
        id: true,
        photoId: true,
        consentId: true,
        createdAt: true,
        photo: {
          select: {
            id: true,
            sessionId: true,
            redactedPath: true,
            piiStatus: true,
            takenAt: true,
            createdAt: true,
            mimeType: true,
            // How many principals are on the frame. A shared frame is the reason
            // the package ships a redacted derivative rather than the original,
            // and the manifest states how many times that substitution happened.
            _count: { select: { subjects: true } },
          },
        },
      },
    }),
    // Recordings the principal is a speaker in. Selected through the segments,
    // because a recording carries no subject of its own — the attribution lives
    // on the spans, exactly as it does for a face in a group photo.
    prisma.recording.findMany({
      where: { segments: { some: { subjectId } } },
      select: {
        id: true,
        sessionId: true,
        redactedPath: true,
        mimeType: true,
        status: true,
        durationSec: true,
        createdAt: true,
        segments: {
          select: { speakerId: true, subjectId: true, startSec: true, endSec: true, action: true },
        },
      },
    }),
    prisma.subjectFaceEnrollment.findMany({
      where: { subjectId },
      select: { id: true, pose: true, source: true, createdAt: true, embeddingDim: true },
    }),
    prisma.subjectVoiceEnrollment.findMany({
      where: { subjectId, deletedAt: null },
      select: { id: true, source: true, durationSec: true, createdAt: true, embeddingDim: true },
    }),
    prisma.accessEvent.findMany({
      where: { objectId: subjectId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { objectType: true, action: true, purpose: true, breakGlass: true, createdAt: true },
    }),
    // Text documents the principal is named in, selected through the spans for
    // the same reason recordings are selected through their segments.
    prisma.textSpan.findMany({
      where: { subjectId },
      include: {
        document: {
          include: {
            spans: true,
          },
        },
      },
    }),
  ])

  if (!subject) throw new ApiError(404, 'Subject not found')

  const files = []
  const photoManifest = []
  // Items whose row exists but whose bytes do not. Collected across all three
  // media loops and raised together, because "which of my items are missing" is
  // a different question from "is anything missing".
  const missingBlobs = []
  const recordingManifest = []
  let redactedSubstitutions = 0
  let bytes = 0

  for (const link of links) {
    const photo = link.photo
    const shared = photo._count.subjects > 1
    const entry = {
      photoId: photo.id,
      sessionId: photo.sessionId,
      takenAt: photo.takenAt,
      linkedAt: link.createdAt,
      consentId: link.consentId,
      // Stated per photo, not only in the totals: a principal reading the
      // manifest should be able to see which of their images were withheld in
      // original form because someone else was in the frame.
      sharedFrame: shared,
      included: false,
      reason: null,
    }

    // Selection is applied before anything is read from storage — a photo the
    // operator did not select must not be decrypted at all, let alone packaged.
    if (linkIds && !linkIds.has(link.id)) {
      entry.reason = 'NOT_SELECTED — outside the selection this package was built for'
      photoManifest.push(entry)
      continue
    }

    // Fail closed here too. A photo whose masking was never confirmed is not
    // shipped — an unmasked derivative leaving in a §11 package is the same
    // breach as one leaving through the API, just with a nicer filename.
    if (isUnresolved(photo)) {
      entry.reason = 'REDACTION_INCOMPLETE — excluded pending masking; re-request once processing completes'
      photoManifest.push(entry)
      continue
    }

    try {
      const buffer = await readFile(photo.redactedPath)
      bytes += buffer.length
      if (bytes > PACKAGE_MAX_BYTES) {
        throw new ApiError(
          413,
          `This package exceeds the ${Math.round(PACKAGE_MAX_BYTES / 1024 / 1024)} MB build ceiling. Build it in parts with a narrower selection.`,
        )
      }
      const name = `photos/${photo.id}.jpg`
      files.push({ name, data: buffer, date: photo.createdAt })
      entry.included = true
      entry.file = name
      entry.sha256 = createHash('sha256').update(buffer).digest('hex')
      if (shared) redactedSubstitutions += 1
    } catch (err) {
      if (err instanceof ApiError) throw err
      logger.error({ err, photoId: photo.id }, 'access package: could not read redacted derivative')
      entry.reason = 'UNREADABLE — the derivative could not be read at packaging time'
      // A row that points at a file which is not there. 167 of these existed,
      // 88 of them in the DSAR index itself, and the previous behaviour was to
      // note the reason in the manifest and ship the package short — while
      // `totals.all`, the completeness contract the grid renders, went on
      // counting the item. Recorded here and raised after the loop so the
      // failure names every missing item rather than the first one.
      missingBlobs.push({ type: 'PHOTO', id: photo.id, path: photo.redactedPath })
    }
    photoManifest.push(entry)
  }

  // Audio, on exactly the terms photographs get. The redacted derivative is the
  // only thing that ships: the original carries every other speaker in the room
  // in full, and handing a principal a recording of their colleagues because
  // they asked for their own data is the disclosure §11 is supposed to prevent.
  for (const recording of recordings) {
    const mine = recording.segments.filter((s) => s.subjectId === subjectId)
    const otherSpeakers = new Set(
      recording.segments.filter((s) => s.subjectId && s.subjectId !== subjectId).map((s) => s.subjectId),
    )
    const entry = {
      recordingId: recording.id,
      sessionId: recording.sessionId,
      recordedAt: recording.createdAt,
      durationSec: recording.durationSec,
      // The principal's own share of the audio, which is the part of it that is
      // their personal data. The rest of the timeline is other people's.
      yourSpeakingSeconds: Number(
        mine.reduce((total, s) => total + Math.max(0, s.endSec - s.startSec), 0).toFixed(2),
      ),
      yourSegments: mine.length,
      sharedRecording: otherSpeakers.size > 0,
      otherSpeakerCount: otherSpeakers.size,
      included: false,
      reason: null,
    }

    if (recordingIds && !recordingIds.has(recording.id)) {
      entry.reason = 'NOT_SELECTED — outside the selection this package was built for'
      recordingManifest.push(entry)
      continue
    }

    // Fail closed, same rule as photographs: a recording whose muting was never
    // confirmed is not shipped. DEFERRED means the audio worker could not be
    // reached, and "we could not check" is never "there was nothing to mute".
    if (!recording.redactedPath || recording.status === 'DEFERRED' || recording.status === 'PENDING_ANALYSIS') {
      entry.reason = 'REDACTION_INCOMPLETE — excluded pending voice masking; re-request once processing completes'
      recordingManifest.push(entry)
      continue
    }

    try {
      const buffer = await readFile(recording.redactedPath)
      bytes += buffer.length
      if (bytes > PACKAGE_MAX_BYTES) {
        throw new ApiError(
          413,
          `This package exceeds the ${Math.round(PACKAGE_MAX_BYTES / 1024 / 1024)} MB build ceiling. Build it in parts with a narrower selection.`,
        )
      }
      const name = `recordings/${recording.id}.${extensionFor(recording.mimeType)}`
      files.push({ name, data: buffer, date: recording.createdAt })
      entry.included = true
      entry.file = name
      entry.sha256 = createHash('sha256').update(buffer).digest('hex')
      if (otherSpeakers.size > 0) redactedSubstitutions += 1
    } catch (err) {
      if (err instanceof ApiError) throw err
      logger.error({ err, recordingId: recording.id }, 'access package: could not read redacted recording')
      entry.reason = 'UNREADABLE — the derivative could not be read at packaging time'
      missingBlobs.push({ type: 'RECORDING', id: recording.id, path: recording.redactedPath })
    }
    recordingManifest.push(entry)
  }

  // Text documents, on exactly the terms audio gets. Only the redacted copy
  // ships: the original carries every other person named in the document in
  // full.
  const textManifest = []
  const seenDocuments = new Set()

  for (const span of textSpans) {
    const doc = span.document
    if (!doc || seenDocuments.has(doc.id)) continue
    seenDocuments.add(doc.id)

    const spans = doc.spans ?? []
    const mine = spans.filter((sp) => sp.subjectId === subjectId)
    const otherSubjects = new Set(
      spans.filter((sp) => sp.subjectId && sp.subjectId !== subjectId).map((sp) => sp.subjectId),
    )

    const entry = {
      documentId: doc.id,
      sessionId: doc.sessionId,
      name: doc.name,
      capturedAt: doc.createdAt,
      // The principal's own share of the document, which is the part of it that
      // is their personal data. The rest of the text is other people's.
      yourSpans: mine.length,
      yourCharacters: mine.reduce((n, sp) => n + Math.max(0, sp.endChar - sp.startChar), 0),
      sharedDocument: otherSubjects.size > 0,
      otherSubjectCount: otherSubjects.size,
      included: false,
      reason: null,
    }

    // Fail closed, same rule as photographs and recordings: a document whose
    // redaction was never confirmed is not shipped. DEFERRED means the text
    // service could not be reached, and "we could not check" is never "there
    // was nothing to redact".
    if (!doc.redactedPath || doc.status !== 'REDACTED') {
      entry.reason = 'REDACTION_INCOMPLETE — excluded pending redaction; re-request once processing completes'
      textManifest.push(entry)
      continue
    }

    try {
      const buffer = await readFile(doc.redactedPath)
      bytes += buffer.length
      if (bytes > PACKAGE_MAX_BYTES) {
        throw new ApiError(
          413,
          `This package exceeds the ${Math.round(PACKAGE_MAX_BYTES / 1024 / 1024)} MB build ceiling. Build it in parts with a narrower selection.`,
        )
      }
      const name = `documents/${doc.id}.redacted.txt`
      files.push({ name, data: buffer, date: doc.createdAt })
      entry.included = true
      entry.file = name
      entry.sha256 = createHash('sha256').update(buffer).digest('hex')
      if (otherSubjects.size > 0) redactedSubstitutions += 1
    } catch (err) {
      if (err instanceof ApiError) throw err
      logger.error({ err, documentId: doc.id }, 'access package: could not read redacted text derivative')
      entry.reason = 'UNREADABLE — the derivative could not be read at packaging time'
      missingBlobs.push({ type: 'TEXT_DOCUMENT', id: doc.id, path: doc.redactedPath })
    }
    textManifest.push(entry)
  }

  // Fail loudly, naming the items.
  //
  // A §11 package that silently omits data the index says exists is a false
  // answer to a statutory request, and the principal has no way to know. The
  // operator gets a 409 with the list; the fix is to repair the index or restore
  // the blob, and neither can happen if the package quietly builds.
  if (missingBlobs.length > 0) {
    logger.error(
      { dsarRequestId, missing: missingBlobs.length, sample: missingBlobs.slice(0, 5) },
      'PACKAGE BUILD REFUSED — referenced blobs are missing from storage',
    )
    throw new ApiError(
      409,
      `Cannot build this package: ${missingBlobs.length} item(s) are indexed but their files are not in storage. ` +
        'Shipping the package would answer a §11 request with a silently incomplete record.',
      { missingItems: missingBlobs.slice(0, 50) },
    )
  }

  const included = [...photoManifest, ...recordingManifest, ...textManifest].filter((e) => e.included)
  const excluded = [...photoManifest, ...recordingManifest, ...textManifest].filter((e) => !e.included)

  const manifest = {
    version: 3,
    packageType: 'DPDP_SECTION_11_ACCESS',
    dsarRequestId,
    generatedAt: new Date().toISOString(),
    // What this package is and is not. A narrowed package that did not say so
    // could be read as the complete §11 answer, which is the one thing a partial
    // export must never be mistaken for.
    selection: {
      ...descriptor,
      complete: descriptor.mode === 'ALL',
      itemCount: included.length,
      excludedCount: excluded.length,
      excludedBySelection: excluded.filter((p) => p.reason?.startsWith('NOT_SELECTED')).length,
      // Every image and every recording here is a redacted derivative; this
      // counts the ones where that substitution withheld something — a frame or
      // a timeline holding other people.
      redactedSubstitutions,
      byType: {
        photos: { included: photoManifest.filter((p) => p.included).length, excluded: photoManifest.filter((p) => !p.included).length },
        recordings: { included: recordingManifest.filter((r) => r.included).length, excluded: recordingManifest.filter((r) => !r.included).length },
      },
      note:
        descriptor.mode === 'ALL'
          ? 'This package covers every image and recording held for this data principal at the time of generation.'
          : 'This package covers a selected subset. It is not a complete record of what is held.',
    },
    dataPrincipal: {
      id: subject.masterUserId,
      fullName: subject.fullName,
      email: subject.email,
      phone: subject.phone,
      group: subject.group,
      status: subject.status,
      employeeRef: subject.employeeRef,
      registrationChannel: subject.registrationChannel,
      dateOfBirth: subject.dateOfBirth,
      guardianContact: subject.guardianContact,
      nomineeContact: subject.nomineeContact,
      registeredAt: subject.createdAt,
    },
    consents: consents.map((c) => ({
      consentId: c.consentId,
      status: c.status,
      consentedAt: c.consentedAt,
      revokedAt: c.revokedAt,
      policyVersion: c.policyVersion ?? c.project?.policyVersion,
      signatureHash: c.signatureHash,
      project: c.project,
    })),
    // §11(b): a summary of the processing, not the artifacts of it. The count and
    // the dimension say what exists; the template itself never leaves.
    biometrics: {
      enrollments: enrollments.length,
      poses: enrollments.map((e) => e.pose).filter(Boolean),
      embeddingsHeld: enrollments.filter((e) => e.embeddingDim).length,
      note: 'Face templates are held encrypted and are never exported, displayed, or disclosed to any operator.',
      // Voice reported on the same terms as face, and deliberately as a summary
      // rather than as files. The reference clip is withheld for the same reason
      // the enrollment selfie is: the template derived from it is the biometric,
      // and the manifest's job under §11(b) is to state what is held and why,
      // not to re-issue the sample. A principal who wants the clip gone raises an
      // ERASE — which now destroys it (L16) and its vector (L17) by name.
      voice: {
        enrollments: voiceEnrollments.length,
        totalSeconds: Number(
          voiceEnrollments.reduce((n, e) => n + (e.durationSec ?? 0), 0).toFixed(2),
        ),
        embeddingsHeld: voiceEnrollments.filter((e) => e.embeddingDim).length,
        capturedAt: voiceEnrollments.map((e) => e.createdAt),
        note: 'Voice templates are held encrypted under a key unique to you, are used only to tell your voice apart from other speakers in a recording, and are never exported or played back to any operator.',
      },
    },
    photos: photoManifest,
    recordings: recordingManifest,
    textDocuments: textManifest,
    processingSummary: {
      purposesInForce: consents.filter((c) => c.status === 'ACTIVE').map((c) => c.project?.purpose),
      processors: [
        { name: 'face-worker', role: 'face detection and blurring', dataSeen: 'photo pixels, in memory only' },
        { name: 'image-pii-worker', role: 'text PII detection and masking', dataSeen: 'photo pixels, in memory only' },
        { name: 'audio-worker', role: 'speaker diarisation and voice/PII muting', dataSeen: 'recording samples, in memory only' },
      ],
      recentAccessEvents: accessEvents,
    },
    yourRights: {
      correction: 'Raise a CORRECT request from the portal to fix any field above.',
      erasure: 'Raise an ERASE request. You will receive a signed deletion certificate.',
      grievance: 'Raise a GRIEVANCE request; the DPO owns the response.',
      nomination: 'DPDP §14 — nominate someone to exercise these rights on your behalf.',
    },
  }

  const manifestJson = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')
  files.unshift({ name: 'manifest.json', data: manifestJson })
  files.push({
    name: 'README.txt',
    data: Buffer.from(
      [
        'Samsung PRISM — DPDP §11 access package',
        '',
        `Request: ${dsarRequestId}`,
        `Generated: ${manifest.generatedAt}`,
        '',
        'manifest.json holds your profile, your consents, and a summary of how your',
        'data is processed. photos/ holds the redacted copies of images you appear in.',
        'recordings/ holds the redacted copies of audio you were recorded speaking in.',
        'documents/ holds the redacted copies of text documents you are named in.',
        '',
        manifest.selection.complete
          ? 'This package covers every image, recording and document held for you at the time it was generated.'
          : `This package covers a SELECTED SUBSET: ${manifest.selection.itemCount} item(s) included, ${manifest.selection.excludedCount} not included. It is not a complete record of what is held.`,
        '',
        'Images are redacted: other people in the frame are blurred and sensitive text',
        'is masked. Recordings are redacted the same way: everyone else who spoke is',
        'muted, so what you hear is your own voice. Documents are redacted the same way:',
        'other people named in them are blanked. Originals are not included, because',
        'exporting them would disclose other people to you.',
        '',
        'Face templates and voice templates are never included in any export.',
        '',
        `This package expires ${PACKAGE_TTL_DAYS} days after issue and the download link is single-use.`,
      ].join('\n'),
      'utf8',
    ),
  })

  const archive = createZip(files)
  const storagePath = `dsar/${dsarRequestId}/package.zip`
  // The export DEK is minted here and exists nowhere but the evidence row, wrapped
  // under the KEK. Dropping that field is what makes the package unrecoverable at
  // expiry — see expirePackages.
  const { wrapped } = await writeFile(storagePath, archive, {
    scope: 'export',
    scopeId: dsarRequestId,
  })

  const contentHash = createHash('sha256').update(archive).digest('hex')
  const rawToken = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + PACKAGE_TTL_DAYS * 24 * 60 * 60 * 1000)

  // Evidence row doubles as the download record: the token is stored hashed, and
  // consumed on first use.
  const evidence = await prisma.dsarEvidence.create({
    data: {
      dsarRequestId,
      kind: 'EXPORT_PACKAGE',
      label:
        descriptor.mode === 'ALL'
          ? 'DPDP §11 access package'
          : `DPDP §11 access package — selected subset (${descriptor.mode})`,
      storagePath,
      contentHash,
      createdByAdminId: admin?.id ?? null,
      payload: {
        tokenHash: tokenHash(rawToken),
        wrappedKey: wrapped ? wrapped.toString('base64') : null,
        expiresAt: expiresAt.toISOString(),
        consumedAt: null,
        sizeBytes: archive.length,
        fileCount: files.length,
        photosIncluded: photoManifest.filter((p) => p.included).length,
        photosExcluded: photoManifest.filter((p) => !p.included).length,
        selection: manifest.selection,
      },
    },
  })

  await writeAuditLog({
    entityType: 'DsarRequest',
    entityId: dsarRequestId,
    action: 'ACCESS_PACKAGE_BUILT',
    actorId: admin?.id ?? null,
    payload: {
      evidenceId: evidence.id,
      contentHash,
      sizeBytes: archive.length,
      selection: manifest.selection,
    },
  })

  // The raw token is returned exactly once, here, and never stored.
  return {
    evidenceId: evidence.id,
    token: rawToken,
    expiresAt,
    contentHash,
    sizeBytes: archive.length,
    selection: manifest.selection,
  }
}

// Short life on a re-issued link. The original token is minted when the package
// is built and mailed out; this one is minted in response to a live, authenticated
// click, so there is no reason for it to outlive the session that asked for it.
const REISSUE_TTL_MINUTES = Number(process.env.DSAR_PACKAGE_REISSUE_TTL_MINUTES ?? 15)

/**
 * Mints a fresh single-use download token for the principal who owns the request.
 *
 * Without this the §11 package was undeliverable in the portal: the only token
 * ever produced is returned once, at build time, to the operator — so a principal
 * had to be sent it out of band and paste it in. Re-issuing does not weaken
 * single-use, which exists to stop a *link* living forever in a mailbox: each
 * token is still spent on first redemption, and minting one requires the subject
 * cookie plus ownership of the request.
 */
export async function issuePackageToken(dsarRequestId, subjectId) {
  const request = await prisma.dsarRequest.findUnique({
    where: { id: dsarRequestId },
    select: { id: true, subjectId: true },
  })
  if (!request) throw new ApiError(404, 'DSAR request not found')
  if (request.subjectId !== subjectId) {
    throw new ApiError(403, 'This request belongs to another data principal')
  }

  const evidence = await prisma.dsarEvidence.findFirst({
    where: { dsarRequestId, kind: 'EXPORT_PACKAGE' },
    orderBy: { createdAt: 'desc' },
  })
  if (!evidence?.storagePath) throw new ApiError(404, 'No package has been issued for this request')

  const payload = evidence.payload ?? {}
  if (payload.shreddedAt) throw new ApiError(410, 'This package has been shredded and is no longer retrievable')
  // The build-time expiry is the retention boundary; a re-issued token cannot
  // reach past it, only fall short of it.
  const hardExpiry = payload.expiresAt ? new Date(payload.expiresAt) : null
  if (hardExpiry && hardExpiry < new Date()) throw new ApiError(410, 'This package has expired')

  const rawToken = randomBytes(32).toString('base64url')
  const softExpiry = new Date(Date.now() + REISSUE_TTL_MINUTES * 60 * 1000)
  const expiresAt = hardExpiry && hardExpiry < softExpiry ? hardExpiry : softExpiry

  await prisma.dsarEvidence.update({
    where: { id: evidence.id },
    data: {
      payload: {
        ...payload,
        tokenHash: tokenHash(rawToken),
        // Clearing consumedAt is what makes the new link usable. The old token
        // is already unusable — its hash is gone.
        consumedAt: null,
        reissuedAt: new Date().toISOString(),
        tokenExpiresAt: expiresAt.toISOString(),
      },
    },
  })

  await writeAuditLog({
    entityType: 'DsarRequest',
    entityId: dsarRequestId,
    action: 'ACCESS_PACKAGE_TOKEN_REISSUED',
    actorId: null,
    payload: { evidenceId: evidence.id, expiresAt: expiresAt.toISOString(), bySubject: true },
  })

  return { token: rawToken, expiresAt, sizeBytes: payload.sizeBytes ?? null }
}

/**
 * Redeems a single-use download token and returns the package bytes.
 *
 * Single-use is enforced by marking consumedAt before the bytes are returned. A
 * link that has been clicked is spent even if the download then fails — the
 * alternative leaves a live link in a mailbox indefinitely, and re-issuing a
 * package is cheap.
 */
export async function downloadPackage(dsarRequestId, token, { req = null, subjectId = null } = {}) {
  const evidence = await prisma.dsarEvidence.findFirst({
    where: { dsarRequestId, kind: 'EXPORT_PACKAGE' },
    orderBy: { createdAt: 'desc' },
  })
  if (!evidence?.storagePath) throw new ApiError(404, 'No package has been issued for this request')

  const request = await prisma.dsarRequest.findUnique({ where: { id: dsarRequestId } })
  if (subjectId && request?.subjectId !== subjectId) {
    throw new ApiError(403, 'This package belongs to another data principal')
  }

  const payload = evidence.payload ?? {}
  const expected = payload.tokenHash
  const provided = tokenHash(token ?? '')
  const expectedBuf = Buffer.from(String(expected ?? ''), 'utf8')
  const providedBuf = Buffer.from(provided, 'utf8')

  if (
    !expected ||
    expectedBuf.length !== providedBuf.length ||
    !timingSafeEqual(expectedBuf, providedBuf)
  ) {
    throw new ApiError(403, 'Invalid download token')
  }
  if (payload.consumedAt) throw new ApiError(410, 'This download link has already been used')
  // Two clocks: the package retention boundary set at build time, and the short
  // TTL on a token re-issued to the principal. Whichever expires first wins.
  const deadlines = [payload.expiresAt, payload.tokenExpiresAt].filter(Boolean).map((d) => new Date(d))
  if (deadlines.some((d) => d < new Date())) {
    throw new ApiError(410, 'This download link has expired')
  }

  await prisma.dsarEvidence.update({
    where: { id: evidence.id },
    data: { payload: { ...payload, consumedAt: new Date().toISOString() } },
  })

  // Invariant 6: logged before the blob is opened.
  await recordAccess({
    objectType: 'DSAR_PACKAGE',
    objectId: evidence.id,
    action: 'DOWNLOAD',
    purpose: 'DSAR_ACCESS_FULFILMENT',
    dsarRequestId,
    req,
  })

  const buffer = await readFile(evidence.storagePath, {
    scope: 'export',
    scopeId: dsarRequestId,
    wrapped: payload.wrappedKey ? Buffer.from(payload.wrappedKey, 'base64') : undefined,
  })
  return { buffer, filename: `prism-data-${dsarRequestId}.zip` }
}

// Called by the retention sweep. Shredding the sealed archive and dropping the
// wrapped key are both done because either alone is weaker than the pair.
export async function expirePackages(now = new Date()) {
  const candidates = await prisma.dsarEvidence.findMany({
    where: { kind: 'EXPORT_PACKAGE', storagePath: { not: null } },
    select: { id: true, storagePath: true, payload: true },
  })

  let expired = 0
  for (const item of candidates) {
    const expiresAt = item.payload?.expiresAt ? new Date(item.payload.expiresAt) : null
    if (!expiresAt || expiresAt > now) continue
    if (!(await fileExists(item.storagePath))) continue

    await shredFile(item.storagePath)
    // Drop the wrapped DEK as well as the bytes: shredding alone leaves a key for
    // an object, and dropping the key alone leaves an object for a key.
    const { wrappedKey: _dropped, ...rest } = item.payload ?? {}
    await prisma.dsarEvidence.update({
      where: { id: item.id },
      data: { payload: { ...rest, wrappedKey: null, shreddedAt: now.toISOString() } },
    })
    expired += 1
  }
  return expired
}
