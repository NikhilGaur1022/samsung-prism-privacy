import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { assertResendCooldown, createOtp, devOtp, verifyOtp as verifyOtpCode } from '../../lib/otp.js'
import { sendOtpEmail } from '../../lib/resend.js'
import {
  signSubjectAccessToken,
  issueSubjectRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
} from '../../lib/tokens.js'

async function findSubjectByEmail(email) {
  const subject = await prisma.subject.findUnique({ where: { email } })
  if (!subject) throw new ApiError(404, 'No account found for this email')
  return subject
}

export async function requestLogin(email) {
  const subject = await findSubjectByEmail(email)

  await assertResendCooldown(email, 'SUBJECT_LOGIN')
  const { code } = await createOtp(email, 'SUBJECT_LOGIN')
  await sendOtpEmail(email, code)

  await writeAuditLog({
    entityType: 'Subject',
    entityId: subject.masterUserId,
    action: 'LOGIN_OTP_REQUESTED',
    actorId: subject.masterUserId,
  })

  // Called once and held: devOtp also emits the server-side log line, so calling
  // it twice would log the same code twice and make the log read as two separate
  // issuances. Returns the code only when the environment is non-hardened AND
  // EXPOSE_DEV_OTP=on; everywhere else it is undefined and nothing is spread.
  const exposed = devOtp(code, email)
  return { requested: true, ...(exposed ? { devOtp: exposed } : {}) }
}

// Used for both registration-verify and returning-subject login — a subject's
// very first successful OTP verify also transitions them PENDING -> ACTIVE.
export async function verifyLoginAndIssueSession(email, otp) {
  const subject = await findSubjectByEmail(email)

  await verifyOtpCode(email, 'SUBJECT_LOGIN', otp)

  const wasFirstVerification = subject.status === 'PENDING'
  const updated = wasFirstVerification
    ? await prisma.subject.update({
        where: { masterUserId: subject.masterUserId },
        data: { otpVerifiedAt: new Date(), status: 'ACTIVE' },
      })
    : subject

  await writeAuditLog({
    entityType: 'Subject',
    entityId: subject.masterUserId,
    action: wasFirstVerification ? 'STATUS_CHANGE' : 'LOGIN',
    actorId: subject.masterUserId,
    payload: wasFirstVerification ? { status: 'ACTIVE', reason: 'otp_verified' } : {},
  })

  const accessToken = signSubjectAccessToken({ masterUserId: updated.masterUserId })
  const refreshToken = await issueSubjectRefreshToken(updated.masterUserId)

  return { subject: updated, accessToken, refreshToken }
}

export async function refreshSession(rawRefreshToken) {
  const { raw, subjectId } = await rotateRefreshToken(rawRefreshToken, 'subjectId')

  // The admin side re-checks status here; the subject side did not, so a
  // deactivated subject went on minting fresh 15-minute access tokens for the
  // full week of their refresh-token life. Deactivation has to mean the same
  // thing for both principal types.
  const subject = await prisma.subject.findUnique({ where: { masterUserId: subjectId } })
  if (!subject || subject.status !== 'ACTIVE') {
    throw new ApiError(401, 'Not authenticated')
  }

  const accessToken = signSubjectAccessToken({ masterUserId: subjectId })
  return { accessToken, refreshToken: raw }
}

export function logout(rawRefreshToken) {
  return revokeRefreshToken(rawRefreshToken)
}

export async function getMe(masterUserId) {
  const subject = await prisma.subject.findUnique({ where: { masterUserId } })
  if (!subject) throw new ApiError(404, 'Subject not found')
  return {
    masterUserId: subject.masterUserId,
    fullName: subject.fullName,
    email: subject.email,
    phone: subject.phone,
    group: subject.group,
    status: subject.status,
  }
}
