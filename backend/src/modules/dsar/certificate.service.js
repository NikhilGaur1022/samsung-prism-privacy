import { createHash, sign as edSign, verify as edVerify } from 'node:crypto'
import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { getSigningKey } from '../../lib/signingKey.js'
import { findProjectResidue, findSubjectResidue } from '../../lib/storageSweep.js'
import { logger } from '../../lib/logger.js'

// The one record in the system that is meant to be shown to an outsider.
//
// It exists because the audit chain deliberately stores hashes and no payload —
// excellent for tamper-evidence, useless as evidence of *what* happened. A
// principal asking "prove you deleted my data" cannot be answered with a chain of
// HMACs over content nobody kept. This table keeps the content, and signs it.
//
// The certificate never carries the principal's identity. Its audience is the DPO
// and external auditors, neither of whom has a basis to learn who the subject
// was; a stable pseudonym lets them correlate without identifying.

// Deterministic and non-reversible. Salted with the signing keyId so the same
// subject does not present the same pseudonym across a key rotation boundary,
// which would let an auditor link certificates over time.
function pseudonymFor(subjectId, keyId) {
  return `SUB-${createHash('sha256').update(`${keyId}:${subjectId}`).digest('hex').slice(0, 12)}`
}

// Canonical JSON: keys sorted at every level, so the bytes that were signed can be
// reconstructed exactly by a verifier that only has the parsed object. Without
// this, a round-trip through any JSON library reorders keys and every signature
// fails to verify for reasons that have nothing to do with tampering.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
}

// Which location code carries the ORIGINAL for each medium, and which carries the
// derivative that gets rebuilt when other people are still in the frame.
//
// The counts below are read from these rows and nothing else. Deriving them from
// the live database instead would be a different claim — "what is there now",
// months later — where the certificate has to say what THIS job did.
const MEDIA_LOCATIONS = Object.freeze([
  { original: 'L2', rebuild: 'L6', noun: 'photo' },
  { original: 'L14', rebuild: 'L15', noun: 'recording' },
  { original: 'L20', rebuild: 'L21', noun: 'video' },
])

/**
 * How many objects were destroyed outright, and how many were kept and rebuilt
 * with this person removed.
 *
 * The distinction is the whole substance of a shared-object erasure, and it is
 * legible in the job's own rows: the original's location is DONE when this
 * subject was the last one linked to it and the bytes were shredded, and SKIPPED
 * when somebody else is still lawfully entitled to that frame — in which case the
 * rebuild location re-rendered it with this person blurred out.
 *
 * A principal reading "3 erased, 9 redacted" learns something true and useful.
 * "12 locations processed" — which is all the certificate could previously say —
 * tells them nothing about what happened to their face.
 */
export function summariseOutcome(locations) {
  const byMedium = {}
  let erased = 0
  let redacted = 0

  for (const { original, rebuild, noun } of MEDIA_LOCATIONS) {
    // An object is counted once, under its original's row. The rebuild row is
    // consulted only to confirm a redaction actually happened, never counted on
    // its own — both rows exist for the same object, and counting each would
    // double every figure.
    const originals = locations.filter((l) => l.locationCode === original)
    const rebuilt = new Set(
      locations.filter((l) => l.locationCode === rebuild && l.status === 'DONE').map((l) => l.objectId),
    )

    const destroyed = originals.filter((l) => l.status === 'DONE').length
    const kept = originals.filter((l) => l.status === 'SKIPPED' && rebuilt.has(l.objectId)).length

    if (destroyed || kept) byMedium[noun] = { erased: destroyed, redacted: kept }
    erased += destroyed
    redacted += kept
  }

  return { erased, redacted, total: erased + redacted, byMedium }
}

/**
 * Issues the certificate for a completed purge.
 *
 * Refuses on anything less than 100% completion. A "partially deleted" assurance
 * is not an assurance, and a signed one is a false statement with our name on it.
 */
export async function issueCertificate(purgeJobId, admin = null) {
  const job = await prisma.purgeJob.findUnique({
    where: { id: purgeJobId },
    include: { locations: true, request: true },
  })
  if (!job) throw new ApiError(404, 'Purge job not found')

  // A scoped job deletes the items an operator ticked. It never touches the
  // subject key, the consent rows or the identity row, so signing it would be a
  // statement that the principal's data is gone when most of it is still held.
  // Checked before the idempotent-return above it would still be wrong; checked
  // here it fails loudly for the only caller that could get this wrong — a worker
  // certifying whatever job it just finished.
  if (job.scope === 'PARTIAL') {
    throw new ApiError(
      409,
      'Cannot certify a scoped purge job. A deletion certificate attests to a whole-subject erasure; this job deleted a named subset of items.',
    )
  }

  // A project erasure gets its OWN certificate type, not this one.
  //
  // It used to be refused outright, on the grounds that DPDP_ERASURE asserts
  // everything held about a person is gone and a project erasure deliberately
  // leaves the person, their key and their other projects intact. That reasoning
  // is right about DPDP_ERASURE and wrong about certificates in general — the
  // schema's own note on PurgeJobScope.PROJECT says the scope is "certifiable,
  // but the certificate must name the project rather than claim a whole-subject
  // erasure", and that is exactly what DPDP_PROJECT_ERASURE does.
  //
  // The two gates below are the ones that could not hold at this scope, and each
  // has a scoped replacement rather than being waived:
  //   - keyDestroyedAt: a project purge must NOT destroy the per-subject DEK, or
  //     every other project's material for that subject becomes unreadable. Not
  //     required here; the certificate says so in `keyDestroyed: false`.
  //   - the residue sweep: findSubjectResidue walks every prefix for the subject
  //     and would see the other projects' files, which are lawfully held. The
  //     project-scoped sweep walks only this project's sessions.
  const projectScoped = job.scope === 'PROJECT'
  if (projectScoped && !job.request.projectId) {
    throw new ApiError(
      409,
      'Cannot certify a project-scoped purge whose request names no project. The certificate has to state which project was erased, and there is nothing to state.',
    )
  }

  const existing = await prisma.deletionCertificate.findUnique({
    where: { dsarRequestId: job.dsarRequestId },
  })
  if (existing) return existing

  const unfinished = job.locations.filter((l) => l.status !== 'DONE' && l.status !== 'SKIPPED')
  if (job.status !== 'COMPLETED' || unfinished.length > 0) {
    throw new ApiError(
      409,
      `Cannot certify: ${unfinished.length} location(s) are not complete. A certificate is issued at 100% or not at all.`,
    )
  }
  if (!projectScoped && !job.keyDestroyedAt) {
    throw new ApiError(409, 'Cannot certify: the subject key has not been destroyed')
  }

  // The last gate, and the one that makes the signature mean something.
  //
  // Every check above reads the purge job's own rows, and the purge job's rows
  // were themselves built by walking database rows — so the whole chain could be
  // green while 518 biometric files sat on disk, unreferenced by anything and
  // therefore invisible to all of it. A certificate that attests to an erasure
  // it never verified is worse than no certificate: it is a signed false
  // statement in a compliance record.
  //
  // So the disk is read, here, immediately before signing. If anything is left,
  // this refuses and names the count — the purge runs a sweep of its own, so
  // residue at this point means either the sweep failed or something wrote after
  // it ran, and both need a person.
  const residue = projectScoped
    ? await findProjectResidue(prisma, job.subjectId, job.request.projectId)
    : await findSubjectResidue(prisma, job.subjectId)
  if (residue.length > 0) {
    logger.error(
      {
        purgeJobId,
        subjectId: job.subjectId,
        scope: job.scope,
        residue: residue.length,
        sample: residue.slice(0, 5),
      },
      'CERTIFICATE REFUSED — files remain on disk for this subject',
    )
    throw new ApiError(
      409,
      `Cannot certify: ${residue.length} file(s) for this subject are still on disk. ` +
        (projectScoped
          ? "A project erasure certificate is issued only when a sweep of this project's sessions finds nothing left carrying this subject's id."
          : 'A deletion certificate is issued only when a filesystem sweep of every path prefix for this subject returns nothing.'),
      { unresolvedCount: residue.length },
    )
  }

  const { privateKey, keyId } = getSigningKey()
  const subjectPseudonym = pseudonymFor(job.subjectId, keyId)
  const completedAt = job.finishedAt ?? new Date()

  // Read from the job's rows, not from the database as it stands now.
  const outcome = summariseOutcome(job.locations)

  // Named on the certificate, because "which project" is the first question a
  // project-scoped erasure raises and a pseudonymised id cannot answer it. The
  // project's NAME is not personal data — it is the fiduciary's own label for a
  // collection — so it can appear next to the pseudonym without re-identifying.
  const project = projectScoped
    ? await prisma.project.findUnique({
        where: { id: job.request.projectId },
        select: { id: true, name: true },
      })
    : null

  const payload = {
    version: 2,
    certificateType: projectScoped ? 'DPDP_PROJECT_ERASURE' : 'DPDP_ERASURE',
    dsarRequestId: job.dsarRequestId,
    dsarType: job.request.type,
    purgeJobId: job.id,
    scope: job.scope,
    subjectPseudonym,
    requestedAt: job.request.createdAt.toISOString(),
    // When the principal themselves confirmed, having seen what the erasure
    // covered. Distinct from requestedAt: asking and confirming are two acts, and
    // an auditor checking that an irreversible deletion was authorised needs the
    // second one.
    subjectConfirmedAt: job.request.subjectConfirmedAt
      ? job.request.subjectConfirmedAt.toISOString()
      : null,
    completedAt: completedAt.toISOString(),
    keyDestroyed: Boolean(job.keyDestroyedAt),
    keyDestroyedAt: job.keyDestroyedAt ? job.keyDestroyedAt.toISOString() : null,
    ...(project ? { project: { id: project.id, name: project.name } } : {}),
    // What actually happened to the material, in the terms the principal asked
    // the question in. `erased` were destroyed outright — this person was the
    // last one entitled to them. `redacted` were kept because somebody else still
    // is, and were re-rendered with this person masked out.
    outcome: {
      erased: outcome.erased,
      redacted: outcome.redacted,
      total: outcome.total,
      byMedium: outcome.byMedium,
    },
    locationsCount: job.locations.length,
    // Recorded in the SIGNED payload, not merely in a log: the claim being made
    // is "we looked at the filesystem and it was empty", and a verifier has to
    // be able to see that the claim was made at all.
    filesystemSweep: {
      performed: true,
      residueFound: 0,
      sweptAt: new Date().toISOString(),
    },
    // Per-location hashes captured BEFORE deletion. After the delete there is
    // nothing left to hash, so this is the only evidence that the object existed
    // and that this is the object that was destroyed.
    locations: job.locations
      .map((l) => ({
        locationCode: l.locationCode,
        objectType: l.objectType,
        // Several locations — PII, SUBJECT_KEY, L8, L11 — are keyed by the subject
        // itself, so a verbatim objectId put the principal's real id on a document
        // whose whole point is that it does not identify them, right next to the
        // pseudonym meant to stand in for it. Anyone holding the certificate could
        // join that id straight back to the person. Substituted, not dropped: the
        // rows still have to be countable and comparable.
        objectId: l.objectId === job.subjectId ? subjectPseudonym : l.objectId,
        status: l.status,
        hashBefore: l.hashBefore,
        completedAt: l.completedAt ? l.completedAt.toISOString() : null,
      }))
      .sort((a, b) =>
        `${a.locationCode}:${a.objectType}:${a.objectId}`.localeCompare(
          `${b.locationCode}:${b.objectType}:${b.objectId}`,
        ),
      ),
    // Stated on the certificate rather than left for someone to discover: backup
    // media cannot be rewritten, so the guarantee there is cryptographic, not
    // physical. Claiming otherwise would be the one lie that matters here.
    //
    // And the two scopes cannot share a sentence. The whole-subject note's
    // assurance rests on the per-subject key being destroyed; at project scope it
    // deliberately is NOT, because destroying it would make the subject's other
    // projects unreadable. Reusing that wording here would put a false
    // cryptographic guarantee on a signed compliance record — precisely the lie
    // the note above exists to avoid.
    residualNote: projectScoped
      ? 'Backup snapshots taken before this date cannot be rewritten and may still contain this material. The per-subject encryption key is deliberately NOT destroyed by a project-scoped erasure: the same key protects this principal\'s data in their other projects, which they have not asked to erase. This certificate attests to the erasure of one project\'s data, not to the removal of everything held about this person.'
      : 'Backup snapshots taken before this date cannot be rewritten. The per-subject encryption key has been destroyed, rendering biometric material in those snapshots undecryptable.',
    issuer: process.env.DSAR_CERTIFICATE_ISSUER ?? 'Samsung PRISM Data Fiduciary',
  }

  const canonical = canonicalJson(payload)
  const payloadHash = createHash('sha256').update(canonical).digest('hex')
  // Ed25519 signs the message directly — the algorithm argument must be null.
  const signature = edSign(null, Buffer.from(canonical), privateKey).toString('base64')

  const certificate = await prisma.deletionCertificate.create({
    data: {
      dsarRequestId: job.dsarRequestId,
      purgeJobId: job.id,
      subjectPseudonym,
      locationsCount: job.locations.length,
      payload,
      payloadHash,
      signature,
      signingKeyId: keyId,
      algorithm: 'ed25519',
      issuedByAdminId: admin?.id ?? null,
      completedAt,
    },
  })

  await writeAuditLog({
    entityType: 'DsarRequest',
    entityId: job.dsarRequestId,
    action: 'DELETION_CERTIFICATE_ISSUED',
    actorId: admin?.id ?? null,
    payload: { certificateId: certificate.id, payloadHash, signingKeyId: keyId },
  })

  return certificate
}

/**
 * Verifies a stored certificate against the current signing key.
 *
 * Reports the two failure modes separately: a hash mismatch means the stored
 * payload was edited, a signature mismatch means the signature does not belong to
 * this payload or was made under a different key. Collapsing both into "invalid"
 * would hide which of the two happened, and they call for different responses.
 */
export async function verifyCertificate(certificateId) {
  const certificate = await prisma.deletionCertificate.findUnique({ where: { id: certificateId } })
  if (!certificate) throw new ApiError(404, 'Certificate not found')

  const canonical = canonicalJson(certificate.payload)
  const recomputedHash = createHash('sha256').update(canonical).digest('hex')
  const hashMatches = recomputedHash === certificate.payloadHash

  const { publicKey, keyId } = getSigningKey()
  const keyMatches = keyId === certificate.signingKeyId

  let signatureValid = false
  try {
    signatureValid = edVerify(
      null,
      Buffer.from(canonical),
      publicKey,
      Buffer.from(certificate.signature, 'base64'),
    )
  } catch {
    signatureValid = false
  }

  return {
    certificateId,
    valid: hashMatches && signatureValid,
    hashMatches,
    signatureValid,
    keyMatches,
    signingKeyId: certificate.signingKeyId,
    currentKeyId: keyId,
    note: keyMatches
      ? null
      : 'This certificate was issued under a different signing key. Verify it against that key’s published public key, not this one.',
  }
}

export async function getCertificateForRequest(dsarRequestId) {
  return prisma.deletionCertificate.findUnique({ where: { dsarRequestId } })
}

// Published so a principal or auditor can verify a certificate without us. It is
// a public key; exposing it is the point.
export function publicKeyInfo() {
  const { keyId, publicKeyPem, source } = getSigningKey()
  return { keyId, algorithm: 'ed25519', publicKeyPem, source }
}
