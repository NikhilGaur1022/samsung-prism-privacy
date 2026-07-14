import bcrypt from 'bcrypt'
import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { sendAdminInviteEmail, sendPasswordResetEmail } from '../../lib/resend.js'
import {
  signAdminAccessToken,
  issueAdminRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokensForAdmin,
  generateOpaqueToken,
  hashOpaqueToken,
} from '../../lib/tokens.js'

const BCRYPT_COST = 12
const MAX_FAILED_ATTEMPTS = 10
const LOCKOUT_MINUTES = 30
const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000

function adminAppUrl(path) {
  const base = process.env.ADMIN_APP_BASE_URL ?? 'http://localhost:5180'
  return `${base}${path}`
}

// Independent of IP-based rate limiting — closes the gap where a slow, distributed
// attack against one admin email would otherwise sail under IP limits untouched.
export async function login(email, password) {
  const admin = await prisma.adminUser.findUnique({ where: { email } })
  if (!admin) throw new ApiError(401, 'Invalid email or password')

  if (admin.status === 'INVITED') throw new ApiError(403, 'Please accept your invite first')
  if (admin.status === 'DISABLED') throw new ApiError(403, 'This account has been disabled')

  if (admin.lockedUntil && admin.lockedUntil > new Date()) {
    throw new ApiError(423, 'Account temporarily locked due to failed attempts', {
      lockedUntil: admin.lockedUntil,
    })
  }

  const passwordOk = admin.passwordHash && (await bcrypt.compare(password, admin.passwordHash))
  if (!passwordOk) {
    const failedLoginAttempts = admin.failedLoginAttempts + 1
    const lockingNow = failedLoginAttempts >= MAX_FAILED_ATTEMPTS

    await prisma.adminUser.update({
      where: { id: admin.id },
      data: {
        failedLoginAttempts: lockingNow ? 0 : failedLoginAttempts,
        lockedUntil: lockingNow ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000) : null,
      },
    })

    await writeAuditLog({
      entityType: 'AdminUser',
      entityId: admin.id,
      action: 'LOGIN_FAILED',
      actorId: admin.id,
      payload: { locked: lockingNow },
    })

    throw new ApiError(401, 'Invalid email or password')
  }

  await prisma.adminUser.update({
    where: { id: admin.id },
    data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
  })

  await writeAuditLog({ entityType: 'AdminUser', entityId: admin.id, action: 'LOGIN', actorId: admin.id })

  const accessToken = signAdminAccessToken({ id: admin.id, role: admin.role })
  const refreshToken = await issueAdminRefreshToken(admin.id)

  return { admin, accessToken, refreshToken }
}

export async function invite(email, role, invitedByAdminId) {
  const existing = await prisma.adminUser.findUnique({ where: { email } })
  if (existing) throw new ApiError(409, 'An admin with this email already exists')

  const admin = await prisma.adminUser.create({
    data: { email, role, status: 'INVITED', invitedByAdminId },
  })

  const rawToken = generateOpaqueToken()
  await prisma.authToken.create({
    data: {
      adminUserId: admin.id,
      purpose: 'ADMIN_INVITE',
      tokenHash: hashOpaqueToken(rawToken),
      expiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS),
    },
  })

  await sendAdminInviteEmail(email, adminAppUrl(`/accept-invite?token=${rawToken}`))

  await writeAuditLog({
    entityType: 'AdminUser',
    entityId: admin.id,
    action: 'INVITED',
    actorId: invitedByAdminId,
    payload: { role },
  })

  return admin
}

export async function acceptInvite(token, password) {
  const authToken = await prisma.authToken.findFirst({
    where: { tokenHash: hashOpaqueToken(token), purpose: 'ADMIN_INVITE', consumedAt: null },
  })
  if (!authToken || authToken.expiresAt < new Date()) {
    throw new ApiError(400, 'Invalid or expired invite link')
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST)

  await prisma.adminUser.update({
    where: { id: authToken.adminUserId },
    data: { passwordHash, status: 'ACTIVE' },
  })
  await prisma.authToken.update({ where: { id: authToken.id }, data: { consumedAt: new Date() } })

  await writeAuditLog({
    entityType: 'AdminUser',
    entityId: authToken.adminUserId,
    action: 'ACTIVATED',
    actorId: authToken.adminUserId,
  })
}

// Doesn't reveal whether the email is a real admin account — the response is
// identical either way, unlike login's deliberately specific error messages.
export async function requestReset(email) {
  const admin = await prisma.adminUser.findUnique({ where: { email } })
  if (!admin || admin.status !== 'ACTIVE') return

  const rawToken = generateOpaqueToken()
  await prisma.authToken.create({
    data: {
      adminUserId: admin.id,
      purpose: 'ADMIN_PASSWORD_RESET',
      tokenHash: hashOpaqueToken(rawToken),
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    },
  })

  await sendPasswordResetEmail(email, adminAppUrl(`/reset-password?token=${rawToken}`))

  await writeAuditLog({
    entityType: 'AdminUser',
    entityId: admin.id,
    action: 'PASSWORD_RESET_REQUESTED',
    actorId: admin.id,
  })
}

export async function resetPassword(token, newPassword) {
  const authToken = await prisma.authToken.findFirst({
    where: { tokenHash: hashOpaqueToken(token), purpose: 'ADMIN_PASSWORD_RESET', consumedAt: null },
  })
  if (!authToken || authToken.expiresAt < new Date()) {
    throw new ApiError(400, 'Invalid or expired reset link')
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST)

  await prisma.adminUser.update({ where: { id: authToken.adminUserId }, data: { passwordHash } })
  await prisma.authToken.update({ where: { id: authToken.id }, data: { consumedAt: new Date() } })
  await revokeAllRefreshTokensForAdmin(authToken.adminUserId)

  await writeAuditLog({
    entityType: 'AdminUser',
    entityId: authToken.adminUserId,
    action: 'PASSWORD_RESET',
    actorId: authToken.adminUserId,
  })
}

export async function getMe(adminId) {
  const admin = await prisma.adminUser.findUnique({ where: { id: adminId } })
  if (!admin) throw new ApiError(404, 'Admin not found')
  return { id: admin.id, email: admin.email, role: admin.role }
}

export async function refreshSession(rawRefreshToken) {
  const { raw, adminUserId } = await rotateRefreshToken(rawRefreshToken, 'adminUserId')

  const admin = await prisma.adminUser.findUnique({ where: { id: adminUserId } })
  if (!admin || admin.status !== 'ACTIVE') throw new ApiError(401, 'Not authenticated')

  const accessToken = signAdminAccessToken({ id: admin.id, role: admin.role })
  return { accessToken, refreshToken: raw }
}

export function logout(rawRefreshToken) {
  return revokeRefreshToken(rawRefreshToken)
}
