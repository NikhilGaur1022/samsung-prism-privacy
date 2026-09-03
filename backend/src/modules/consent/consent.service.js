import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { signConsent } from '../../lib/consent.js'
import { deleteAllEnrollments } from '../enrollment/enrollment.service.js'
import { labelForDataType } from '../../lib/dataTypes.js'
import { logger } from '../../lib/logger.js'

// Subject-facing. The subject grants consent to a whole project from the
// user-portal; the collection agent only ever reads the result of this.
export async function listProjectsForSubject(subjectId) {
  // APPROVED is the collectable state a project reaches after DPO sign-off
  // (project.service.assertCollectable). Filtering on ACTIVE alone predates that
  // workflow and meant the portal showed a principal nothing they could actually
  // consent to — every governed project is APPROVED, never ACTIVE. ACTIVE is kept
  // for the legacy rows that still carry it.
  const projects = await prisma.project.findMany({
    where: { status: { in: ['APPROVED', 'ACTIVE'] } },
    orderBy: { createdAt: 'desc' },
    include: { consents: { where: { subjectId } } },
  })

  return projects.map(({ consents, ...project }) => {
    const consent = consents[0] ?? null
    return {
      ...project,
      // Resolved here rather than in the portal, because lib/dataTypes.js is the
      // one place the vocabulary lives and its own header argues against a
      // second copy — "the copy that drifts is the one that makes a lawful
      // project unapprovable". The consent screen was rendering a hardcoded list
      // (photographs, face data, full name) that had no relationship to what the
      // project declares: a project collecting FACE, VOICE and TEXT showed the
      // principal no mention of voice or text, and offered them a name field the
      // notice never claimed. That is the §5 notice being wrong on the screen
      // where consent is actually given.
      //
      // /api/v1/data-types cannot serve this — it is behind requireAdminAuth,
      // and rightly so.
      dataTypeLabels: Array.isArray(project.dataTypes)
        ? project.dataTypes.map((code) => labelForDataType(code)).filter(Boolean)
        : [],
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

  const { updated: revoked, dropped } = await prisma.$transaction(async (tx) => {
    const revoked = await tx.projectConsent.update({
      where: { consentId: consent.consentId },
      data: { status: 'REVOKED', revokedAt: new Date() },
    })

    // Read the rows before deleting them so the drop is auditable — otherwise a
    // participant silently disappears from a live session roster with no record of
    // why (this is the trail that was missing when a re-joined subject vanished
    // from a session between add and end).
    const rosterRows = await tx.sessionParticipant.findMany({
      where: {
        consentId: consent.consentId,
        session: { status: { in: ['ACTIVE', 'PROCESSING', 'TAGGING'] } },
      },
      select: { sessionId: true },
    })

    // Pull them out of any session roster that hasn't been archived yet. Faces
    // already detected for them are dropped by the finalize-time re-check.
    await tx.sessionParticipant.deleteMany({
      where: {
        consentId: consent.consentId,
        session: { status: { in: ['ACTIVE', 'PROCESSING', 'TAGGING'] } },
      },
    })

    return { updated: revoked, dropped: rosterRows.map((r) => r.sessionId) }
  })

  await writeAuditLog({
    entityType: 'ProjectConsent',
    entityId: consent.consentId,
    action: 'CONSENT_REVOKED',
    actorId: subjectId,
    payload: { projectId, droppedFromSessions: dropped },
  })

  // The enrollment selfie is biometric data held on the basis of consent. If any
  // other project still has active consent it stays — it is lawfully held for that
  // one. Only when nothing is left does it lose its basis and get purged.
  const remaining = await prisma.projectConsent.count({
    where: { subjectId, status: 'ACTIVE' },
  })
  if (remaining === 0) {
    await deleteAllEnrollments(subjectId, subjectId, 'ALL_CONSENT_REVOKED')
  }

  // §6(4): withdrawal must be as easy as giving consent, and §8(7) requires the
  // data to go once its basis has. Raising an internal DSAR rather than deleting
  // here means the withdrawal walks the same audited, resumable, certificate-
  // issuing executor a hand-filed erasure does — instead of a second, quieter
  // deletion path with no evidence trail and no SLA clock on it.
  //
  // Imported lazily: consent.service is loaded by the join flow, and dsar.service
  // pulls in the purge executor and the whole storage/keyring stack behind it.
  // A static import would make every consent read pay for that.
  try {
    const { raiseWithdrawalErasure } = await import('../dsar/dsar.service.js')
    await raiseWithdrawalErasure(subjectId, projectId)
  } catch (err) {
    // The revocation itself has already committed and must stand — processing has
    // stopped, which is the part with immediate legal effect. A failure to open
    // the erasure request is loud so it can be raised by hand.
    logger.error(
      { err, subjectId, projectId },
      'consent revoked but the withdrawal erasure request could not be raised — raise it manually',
    )
  }

  return revoked
}
