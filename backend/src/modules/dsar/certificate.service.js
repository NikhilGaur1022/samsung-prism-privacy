import { createHash, sign as edSign, verify as edVerify } from 'node:crypto'
import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { getSigningKey } from '../../lib/signingKey.js'

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
  if (!job.keyDestroyedAt) {
    throw new ApiError(409, 'Cannot certify: the subject key has not been destroyed')
  }

  const { privateKey, keyId } = getSigningKey()
  const subjectPseudonym = pseudonymFor(job.subjectId, keyId)
  const completedAt = job.finishedAt ?? new Date()

  const payload = {
    version: 1,
    certificateType: 'DPDP_ERASURE',
    dsarRequestId: job.dsarRequestId,
    dsarType: job.request.type,
    purgeJobId: job.id,
    subjectPseudonym,
    requestedAt: job.request.createdAt.toISOString(),
    completedAt: completedAt.toISOString(),
    keyDestroyedAt: job.keyDestroyedAt.toISOString(),
    locationsCount: job.locations.length,
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
    residualNote:
      'Backup snapshots taken before this date cannot be rewritten. The per-subject encryption key has been destroyed, rendering biometric material in those snapshots undecryptable.',
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
