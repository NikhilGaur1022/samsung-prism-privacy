import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { signConsent } from '../../lib/consent.js'

// Subject-facing. The subject grants consent to a whole project from the
// user-portal; the collection agent only ever reads the result of this.
export async function listProjectsForSubject(subjectId) {
  const projects = await prisma.project.findMany({
    where: { status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
    include: { consents: { where: { subjectId } } },
  })

  return projects.map(({ consents, ...project }) => {
    const consent = consents[0] ?? null
    return {
      ...project,
      consent: consent && {
        consentId: consent.consentId,
        status: consent.status,
        consentedAt: consent.consentedAt,
        revokedAt: consent.revokedAt,
        policyVersion: consent.policyVersion,
      },
    }
  })
}

async function getActiveProject(projectId) {
  const project = await prisma.project.findUnique({ where: { id: projectId } })
  if (!project || project.status === 'CLOSED') throw new ApiError(404, 'Project not found')
  return project
}

export async function grantConsent(subjectId, projectId) {
  const project = await getActiveProject(projectId)

  const existing = await prisma.projectConsent.findUnique({
    where: { subjectId_projectId: { subjectId, projectId } },
  })
  if (existing?.status === 'ACTIVE') return existing
  if (existing?.status === 'PURGED') {
    throw new ApiError(409, 'This project’s data was purged — consent cannot be re-granted')
  }

  const consentedAt = new Date()
  const signatureHash = signConsent({
    subjectId,
    projectId,
    policyVersion: project.policyVersion,
    signedAt: consentedAt,
  })

  // Re-granting after a revoke reuses the same row (the unique constraint is
  // subject×project) but re-signs it against the current policy version.
  const consent = existing
    ? await prisma.projectConsent.update({
        where: { consentId: existing.consentId },
        data: {
          status: 'ACTIVE',
          consentedAt,
          revokedAt: null,
          policyVersion: project.policyVersion,
          signatureHash,
        },
      })
    : await prisma.projectConsent.create({
        data: {
          subjectId,
          projectId,
          policyVersion: project.policyVersion,
          signatureHash,
          consentedAt,
        },
      })

  await writeAuditLog({
    entityType: 'ProjectConsent',
    entityId: consent.consentId,
    action: existing ? 'CONSENT_REGRANTED' : 'CONSENT_GRANTED',
    actorId: subjectId,
    payload: { projectId, policyVersion: consent.policyVersion },
  })

  return consent
}

export async function revokeConsent(subjectId, projectId) {
  const consent = await prisma.projectConsent.findUnique({
    where: { subjectId_projectId: { subjectId, projectId } },
  })
  if (!consent || consent.status !== 'ACTIVE') {
    throw new ApiError(404, 'No active consent for this project')
  }

  const updated = await prisma.$transaction(async (tx) => {
    const revoked = await tx.projectConsent.update({
      where: { consentId: consent.consentId },
      data: { status: 'REVOKED', revokedAt: new Date() },
    })

    // Pull them out of any session roster that hasn't been archived yet. Faces
    // already detected for them are dropped by the finalize-time re-check.
    await tx.sessionParticipant.deleteMany({
      where: {
        consentId: consent.consentId,
        session: { status: { in: ['ACTIVE', 'PROCESSING', 'TAGGING'] } },
      },
    })

    return revoked
  })

  await writeAuditLog({
    entityType: 'ProjectConsent',
    entityId: consent.consentId,
    action: 'CONSENT_REVOKED',
    actorId: subjectId,
    payload: { projectId },
  })

  return updated
}
