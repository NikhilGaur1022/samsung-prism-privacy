import { prisma } from '../../config/prisma.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { ApiError } from '../../middleware/errorHandler.js'

// employeeRef is the primary dedupe key for the 4 employee groups (deterministic,
// doesn't rot like shared/reassigned corporate email aliases). Email (citext,
// case-insensitive at the DB level) is the fallback for volunteers who may lack one.
async function findExistingSubject({ employeeRef, email }) {
  if (employeeRef) {
    const byRef = await prisma.subject.findUnique({ where: { employeeRef } })
    if (byRef) return byRef
  }
  if (email) {
    const byEmail = await prisma.subject.findUnique({ where: { email } })
    if (byEmail) return byEmail
  }
  return null
}

export async function registerSubject(input, actorId) {
  const existing = await findExistingSubject(input)
  if (existing) {
    throw new ApiError(409, 'Subject already registered', { masterUserId: existing.masterUserId })
  }

  const subject = await prisma.subject.create({ data: input })

  await writeAuditLog({
    entityType: 'Subject',
    entityId: subject.masterUserId,
    action: 'CREATE',
    actorId,
    payload: { group: subject.group, registrationChannel: subject.registrationChannel },
  })

  return subject
}

export async function getSubject(masterUserId) {
  const subject = await prisma.subject.findUnique({ where: { masterUserId } })
  if (!subject) throw new ApiError(404, 'Subject not found')
  return subject
}

export async function listSubjects({ group, status, limit, cursor }) {
  const subjects = await prisma.subject.findMany({
    where: { ...(group && { group }), ...(status && { status }) },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(cursor && { cursor: { masterUserId: cursor }, skip: 1 }),
  })

  const hasMore = subjects.length > limit
  const items = hasMore ? subjects.slice(0, limit) : subjects

  return {
    items,
    nextCursor: hasMore ? items[items.length - 1].masterUserId : null,
  }
}

export async function updateConsent(masterUserId, consentFlags, actorId) {
  const subject = await getSubject(masterUserId)

  const updated = await prisma.subject.update({
    where: { masterUserId: subject.masterUserId },
    data: consentFlags,
  })

  await writeAuditLog({
    entityType: 'Subject',
    entityId: masterUserId,
    action: 'CONSENT_UPDATE',
    actorId,
    payload: consentFlags,
  })

  return updated
}

export async function updateStatus(masterUserId, status, actorId) {
  await getSubject(masterUserId)

  const updated = await prisma.subject.update({ where: { masterUserId }, data: { status } })

  await writeAuditLog({
    entityType: 'Subject',
    entityId: masterUserId,
    action: 'STATUS_CHANGE',
    actorId,
    payload: { status },
  })

  return updated
}

export async function updateGroup(masterUserId, group, actorId) {
  await getSubject(masterUserId)

  const updated = await prisma.subject.update({ where: { masterUserId }, data: { group } })

  await writeAuditLog({
    entityType: 'Subject',
    entityId: masterUserId,
    action: 'GROUP_CHANGE',
    actorId,
    payload: { group },
  })

  return updated
}

// Stubbed: accepts any OTP for now (real OTP provider is a separate future decision).
// Transitions PENDING -> ACTIVE directly, no DPO-approval step (confirmed against the
// DSAR flow diagrams — DPO approves the project/consent-template once, not per subject).
export async function verifyOtp(masterUserId, actorId) {
  await getSubject(masterUserId)

  const updated = await prisma.subject.update({
    where: { masterUserId },
    data: { otpVerifiedAt: new Date(), status: 'ACTIVE' },
  })

  await writeAuditLog({
    entityType: 'Subject',
    entityId: masterUserId,
    action: 'STATUS_CHANGE',
    actorId,
    payload: { status: 'ACTIVE', reason: 'otp_verified' },
  })

  return updated
}
