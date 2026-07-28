import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { recordAccess } from '../../lib/accessLog.js'
import { readFile, writeFile, shredFile, fileExists } from '../../lib/storage.js'
import { createZip } from '../../lib/zip.js'
import { logger } from '../../lib/logger.js'

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

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Builds the §11 access package.
 *
 * The archive is written through storage.writeFile under an export scope, so at
 * rest it is sealed with a key that is not the project key — destroying that key
 * crypto-shreds the package independently of everything else.
 */
export async function buildAccessPackage(dsarRequestId, admin = null) {
  const request = await prisma.dsarRequest.findUnique({ where: { id: dsarRequestId } })
  if (!request) throw new ApiError(404, 'DSAR request not found')
  if (request.type !== 'ACCESS') {
    throw new ApiError(400, `DSAR type ${request.type} does not produce an access package`)
  }

  const subjectId = request.subjectId

  const [subject, consents, links, enrollments, accessEvents] = await Promise.all([
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
          },
        },
      },
    }),
    prisma.subjectFaceEnrollment.findMany({
      where: { subjectId },
      select: { id: true, pose: true, source: true, createdAt: true, embeddingDim: true },
    }),
    prisma.accessEvent.findMany({
      where: { objectId: subjectId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { objectType: true, action: true, purpose: true, breakGlass: true, createdAt: true },
    }),
  ])

  if (!subject) throw new ApiError(404, 'Subject not found')

  const files = []
  const photoManifest = []

  for (const link of links) {
    const photo = link.photo
    const entry = {
      photoId: photo.id,
      sessionId: photo.sessionId,
      takenAt: photo.takenAt,
      linkedAt: link.createdAt,
      consentId: link.consentId,
      included: false,
      reason: null,
    }

    // Fail closed here too. A photo whose masking was never confirmed is not
    // shipped — an unmasked derivative leaving in a §11 package is the same
    // breach as one leaving through the API, just with a nicer filename.
    if (!photo.redactedPath || photo.piiStatus === 'DEFERRED' || photo.piiStatus === 'FAILED') {
      entry.reason = 'REDACTION_INCOMPLETE — excluded pending masking; re-request once processing completes'
      photoManifest.push(entry)
      continue
    }

    try {
      const buffer = await readFile(photo.redactedPath)
      const name = `photos/${photo.id}.jpg`
      files.push({ name, data: buffer, date: photo.createdAt })
      entry.included = true
      entry.file = name
      entry.sha256 = createHash('sha256').update(buffer).digest('hex')
    } catch (err) {
      logger.error({ err, photoId: photo.id }, 'access package: could not read redacted derivative')
      entry.reason = 'UNREADABLE — the derivative could not be read at packaging time'
    }
    photoManifest.push(entry)
  }

  const manifest = {
    version: 1,
    packageType: 'DPDP_SECTION_11_ACCESS',
    dsarRequestId,
    generatedAt: new Date().toISOString(),
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
    },
    photos: photoManifest,
    processingSummary: {
      purposesInForce: consents.filter((c) => c.status === 'ACTIVE').map((c) => c.project?.purpose),
      processors: [
        { name: 'face-worker', role: 'face detection and blurring', dataSeen: 'photo pixels, in memory only' },
        { name: 'image-pii-worker', role: 'text PII detection and masking', dataSeen: 'photo pixels, in memory only' },
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
        '',
        'Images are redacted: other people in the frame are blurred and sensitive text',
        'is masked. Originals are not included, because exporting them would disclose',
        'other people to you.',
        '',
        'Face templates are never included in any export.',
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
      label: 'DPDP §11 access package',
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
      },
    },
  })

  await writeAuditLog({
    entityType: 'DsarRequest',
    entityId: dsarRequestId,
    action: 'ACCESS_PACKAGE_BUILT',
    actorId: admin?.id ?? null,
    payload: { evidenceId: evidence.id, contentHash, sizeBytes: archive.length },
  })

  // The raw token is returned exactly once, here, and never stored.
  return { evidenceId: evidence.id, token: rawToken, expiresAt, contentHash, sizeBytes: archive.length }
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
