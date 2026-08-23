import { prisma } from '../../config/prisma.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { assertResendCooldown, createOtp, devOtp } from '../../lib/otp.js'
import { sendOtpEmail } from '../../lib/resend.js'
import { deleteAllEnrollments } from '../enrollment/enrollment.service.js'

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

  // Registration immediately triggers the same OTP the subject will later use to
  // verify — no separate "confirm your email" step before verification can start.
  await assertResendCooldown(subject.email, 'SUBJECT_LOGIN')
  const { code } = await createOtp(subject.email, 'SUBJECT_LOGIN')
  await sendOtpEmail(subject.email, code)

  // Same two gates as the login path. Attached to the returned object so an
  // agent registering someone in person can read it off their own screen
  // instead of hunting through a server log.
  const exposed = devOtp(code, subject.email)
  return exposed ? { ...subject, devOtp: exposed } : subject
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

  // A subject who is no longer active has no live basis for us to hold their
  // biometric enrollment image — drop it with the status change, not later.
  if (status === 'INACTIVE' || status === 'REJECTED') {
    await deleteAllEnrollments(masterUserId, actorId, 'SUBJECT_STATUS_CHANGE')
  }

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
