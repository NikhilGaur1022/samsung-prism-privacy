import { randomBytes } from 'node:crypto'
import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { grantConsent } from '../consent/consent.service.js'
import { addParticipantInternal } from '../sessions/session.service.js'
import { getEnrollmentStatus } from '../enrollment/enrollment.service.js'

const INVITE_TTL_MS = Number(process.env.SESSION_INVITE_TTL_MINUTES ?? 240) * 60 * 1000
const USER_PORTAL_URL = process.env.USER_PORTAL_URL ?? 'http://localhost:5173'

function joinUrl(token) {
  return `${USER_PORTAL_URL.replace(/\/$/, '')}/join/${token}`
}

// Agent-owned sessions only — reuses the same ownership rule the rest of the
// session API enforces rather than inventing a second one.
async function loadOwnedSession(sessionId, admin) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { project: { select: { id: true, name: true } } },
  })
  if (!session) throw new ApiError(404, 'Session not found')
  if (admin.role === 'collectionAgent' && session.agentId !== admin.id) {
    throw new ApiError(403, 'This session belongs to another agent')
  }
  return session
}

// Create-or-rotate. Rotating revokes every live invite first, so a QR printed an
// hour ago stops working the moment a new one is generated — that is the whole
// point of a token separate from Session.code.
export async function createInvite(sessionId, admin) {
  const session = await loadOwnedSession(sessionId, admin)
  if (session.status !== 'ACTIVE') {
    throw new ApiError(409, `Session is ${session.status} — people can only join an active session`)
  }

  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS)

  const invite = await prisma.$transaction(async (tx) => {
    await tx.sessionInvite.updateMany({
      where: { sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    return tx.sessionInvite.create({
      data: { sessionId, token, expiresAt, createdBy: admin.id },
    })
  })

  await writeAuditLog({
    entityType: 'Session',
    entityId: sessionId,
    action: 'SESSION_INVITE_CREATED',
    actorId: admin.id,
    // The token itself is a bearer credential — the id identifies it in the log.
    payload: { inviteId: invite.id, expiresAt },
  })

  return { token: invite.token, url: joinUrl(invite.token), expiresAt: invite.expiresAt }
}

export async function getActiveInvite(sessionId, admin) {
  await loadOwnedSession(sessionId, admin)
  const invite = await prisma.sessionInvite.findFirst({
    where: { sessionId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  })
  if (!invite) return { invite: null }
  return {
    invite: { token: invite.token, url: joinUrl(invite.token), expiresAt: invite.expiresAt },
  }
}

export async function revokeInvite(sessionId, admin) {
  await loadOwnedSession(sessionId, admin)

  const { count } = await prisma.sessionInvite.updateMany({
    where: { sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  })

  await writeAuditLog({
    entityType: 'Session',
    entityId: sessionId,
    action: 'SESSION_INVITE_REVOKED',
    actorId: admin.id,
    payload: { count },
  })

  return { revoked: count }
}

// Distinct, human-readable failures: someone standing in a room holding a phone
// needs to know whether to ask for a new code or whether they are simply too late.
async function loadInvite(token) {
  const invite = await prisma.sessionInvite.findUnique({
    where: { token },
    include: {
      session: {
        include: {
          project: { select: { id: true, name: true, purpose: true, policyVersion: true } },
          agent: { select: { email: true } },
        },
      },
    },
  })

  if (!invite) throw new ApiError(404, 'This join link is not valid. Ask the agent for a new QR code.')
  if (invite.revokedAt) throw new ApiError(410, 'This join link has been revoked. Ask the agent for a new QR code.')
  if (invite.expiresAt <= new Date()) {
    throw new ApiError(410, 'This join link has expired. Ask the agent for a new QR code.')
  }
  if (invite.session.status !== 'ACTIVE') {
    throw new ApiError(409, 'This session has already finished — there is nothing to join.')
  }

  return invite
}

// PUBLIC. Returns what a stranger needs to decide whether to consent, and nothing
// else: no subject data, no session id, no roster, no counts.
export async function describeInvite(token) {
  const invite = await loadInvite(token)
  const { session } = invite

  return {
    projectName: session.project.name,
    purpose: session.project.purpose,
    policyVersion: session.project.policyVersion,
    consentText:
      `By joining, you consent to ${session.project.name} collecting and processing photographs of you ` +
      `for the purpose of: ${session.project.purpose}. Consent covers the whole project, including ` +
      `automatic face matching where you have enrolled a photo. You can withdraw it at any time from ` +
      `your Consent Hub, which deletes the photos linked to you and any face data held for you.`,
    sessionLocation: session.location,
    agentName: session.agent?.email ?? null,
    expiresAt: invite.expiresAt,
  }
}

// The scan is not consent — this is. It runs only after the subject has read the
// text above and pressed the agree button, so signConsent() records an actual
// human act and the audit signature means something.
export async function acceptInvite(token, subjectId) {
  const invite = await loadInvite(token)
  const { session } = invite

  const existing = await prisma.sessionParticipant.findUnique({
    where: { sessionId_subjectId: { sessionId: session.id, subjectId } },
  })

  if (!existing) {
    // grantConsent and addParticipantInternal are the single authority for
    // consent signing and the consent gate — this reuses them rather than
    // reimplementing either.
    await grantConsent(subjectId, session.projectId)
    await addParticipantInternal(session.id, subjectId, subjectId)

    await writeAuditLog({
      entityType: 'Session',
      entityId: session.id,
      action: 'SESSION_JOINED_VIA_QR',
      actorId: subjectId,
      payload: { inviteId: invite.id, subjectId },
    })
  }

  const enrollment = await getEnrollmentStatus(subjectId)

  return {
    sessionCode: session.code,
    projectId: session.projectId,
    projectName: session.project.name,
    alreadyJoined: Boolean(existing),
    enrollmentComplete: enrollment.complete,
    biometricConsent: enrollment.biometricConsent,
  }
}
