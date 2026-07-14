import { prisma } from '../config/prisma.js'
import { logger } from './logger.js'

// Deletes expired/consumed auth records. Not scheduled by the app itself yet —
// run manually or via an external scheduler (e.g. this environment's CronCreate
// tool) — matching the project's "don't build scheduling infra before it's needed" pattern.
export async function cleanupExpiredAuthRecords() {
  const now = new Date()

  const [otpCodes, authTokens, refreshTokens] = await Promise.all([
    prisma.otpCode.deleteMany({
      where: { OR: [{ expiresAt: { lt: now } }, { consumedAt: { not: null } }] },
    }),
    prisma.authToken.deleteMany({
      where: { OR: [{ expiresAt: { lt: now } }, { consumedAt: { not: null } }] },
    }),
    prisma.refreshToken.deleteMany({
      where: { OR: [{ expiresAt: { lt: now } }, { revokedAt: { not: null } }] },
    }),
  ])

  logger.info(
    { otpCodes: otpCodes.count, authTokens: authTokens.count, refreshTokens: refreshTokens.count },
    'cleanupExpiredAuthRecords: done',
  )

  return {
    otpCodes: otpCodes.count,
    authTokens: authTokens.count,
    refreshTokens: refreshTokens.count,
  }
}
