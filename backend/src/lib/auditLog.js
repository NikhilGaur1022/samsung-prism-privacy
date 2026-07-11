import { createHmac } from 'node:crypto'
import { prisma } from '../config/prisma.js'

const HMAC_SECRET = process.env.AUDIT_HMAC_SECRET ?? 'dev-only-secret-change-in-prod'

function canonicalize(payload) {
  return JSON.stringify(payload, Object.keys(payload).sort())
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
  const canonicalPayload = canonicalize({ entityType, entityId, action, actorId, payload, prevHash })
  const payloadHash = createHmac('sha256', HMAC_SECRET).update(canonicalPayload).digest('hex')

  return prisma.auditLog.create({
    data: {
      entityType,
      entityId,
      action,
      actorId,
      payloadHash,
      prevHash,
    },
  })
}
