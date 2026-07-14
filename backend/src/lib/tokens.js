import { randomBytes, randomUUID, createHash } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { prisma } from '../config/prisma.js'
import { ApiError } from '../middleware/errorHandler.js'

const ACCESS_TOKEN_TTL = '15m'
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

// Subject and admin tokens are signed with separate secrets and carry an explicit
// principalType claim — every middleware checks both, so a subject token can never
// satisfy an admin route even if secrets were ever misconfigured to match.
export function signSubjectAccessToken({ masterUserId }) {
  return jwt.sign({ principalType: 'SUBJECT', sub: masterUserId }, process.env.JWT_SUBJECT_SECRET, {
    expiresIn: ACCESS_TOKEN_TTL,
  })
}

export function verifySubjectAccessToken(token) {
  const payload = jwt.verify(token, process.env.JWT_SUBJECT_SECRET)
  if (payload.principalType !== 'SUBJECT') throw new ApiError(401, 'Invalid token')
  return payload
}

export function signAdminAccessToken({ id, role }) {
  return jwt.sign({ principalType: 'ADMIN', sub: id, role }, process.env.JWT_ADMIN_SECRET, {
    expiresIn: ACCESS_TOKEN_TTL,
  })
}

export function verifyAdminAccessToken(token) {
  const payload = jwt.verify(token, process.env.JWT_ADMIN_SECRET)
  if (payload.principalType !== 'ADMIN') throw new ApiError(401, 'Invalid token')
  return payload
}

async function createRefreshToken({ subjectId = null, adminUserId = null, familyId }) {
  const raw = randomBytes(32).toString('hex')

  await prisma.refreshToken.create({
    data: {
      subjectId,
      adminUserId,
      familyId,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    },
  })

  return raw
}

export function issueSubjectRefreshToken(subjectId) {
  return createRefreshToken({ subjectId, familyId: randomUUID() })
}

export function issueAdminRefreshToken(adminUserId) {
  return createRefreshToken({ adminUserId, familyId: randomUUID() })
}

// Rotates a refresh token on every use. If the presented token was already
// rotated (i.e. revokedAt is set), that's reuse of a stolen/replayed token —
// the entire token family is revoked immediately rather than just this token.
export async function rotateRefreshToken(rawToken, expectedOwnerField) {
  const tokenHash = hashToken(rawToken)
  const existing = await prisma.refreshToken.findUnique({ where: { tokenHash } })

  if (!existing || !existing[expectedOwnerField]) {
    throw new ApiError(401, 'Invalid refresh token')
  }

  if (existing.revokedAt || existing.expiresAt < new Date()) {
    await prisma.refreshToken.updateMany({
      where: { familyId: existing.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    throw new ApiError(401, 'Session invalidated — please sign in again')
  }

  await prisma.refreshToken.update({ where: { id: existing.id }, data: { revokedAt: new Date() } })

  const newRaw = await createRefreshToken({
    subjectId: existing.subjectId,
    adminUserId: existing.adminUserId,
    familyId: existing.familyId,
  })

  return { raw: newRaw, subjectId: existing.subjectId, adminUserId: existing.adminUserId }
}

export async function revokeRefreshToken(rawToken) {
  const tokenHash = hashToken(rawToken)
  await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

export async function revokeAllRefreshTokensForAdmin(adminUserId) {
  await prisma.refreshToken.updateMany({
    where: { adminUserId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

// Single-use opaque tokens for admin invite / password reset — hashed at rest
// identically to OTPs and refresh tokens.
export function generateOpaqueToken() {
  return randomBytes(32).toString('hex')
}

export function hashOpaqueToken(token) {
  return hashToken(token)
}
