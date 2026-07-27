import { createHash, createHmac } from 'node:crypto'
import { prisma } from '../config/prisma.js'

export const DEFAULT_AUDIT_SECRET = 'dev-only-secret-change-in-prod'
const HMAC_SECRET = process.env.AUDIT_HMAC_SECRET ?? DEFAULT_AUDIT_SECRET

function canonicalize(payload) {
  return JSON.stringify(payload, Object.keys(payload).sort())
}

// Payload plaintext is never persisted (invariant 7); its digest is, so that the
// chain HMAC can be recomputed later from stored columns alone.
export function digestPayload(payload) {
  return createHash('sha256').update(canonicalize(payload ?? {})).digest('hex')
}

// The single definition of the chain hash. verifyChain recomputes with this exact
// function — two copies of this formula would eventually disagree, and a
// verifier that disagrees with the writer reports tampering that never happened.
export function computeChainHash({ entityType, entityId, action, actorId, payloadDigest, prevHash }) {
  const canonical = canonicalize({ entityType, entityId, action, actorId, payloadDigest, prevHash })
  return createHmac('sha256', HMAC_SECRET).update(canonical).digest('hex')
}

// Single place every module writes audit entries through — avoids each module
// (subjects today, media/consent/purge/dsar later) hand-rolling its own hash
// chain that wouldn't actually unify into one verifiable ledger.
export async function writeAuditLog({ entityType, entityId, action, actorId = null, payload = {} }) {
  const lastEntry = await prisma.auditLog.findFirst({
    where: { entityType, entityId },
    orderBy: { createdAt: 'desc' },
  })

  const prevHash = lastEntry?.payloadHash ?? null
  const payloadDigest = digestPayload(payload)
  const payloadHash = computeChainHash({ entityType, entityId, action, actorId, payloadDigest, prevHash })

  return prisma.auditLog.create({
    data: {
      entityType,
      entityId,
      action,
      actorId,
      payloadHash,
      payloadDigest,
      prevHash,
    },
  })
}
