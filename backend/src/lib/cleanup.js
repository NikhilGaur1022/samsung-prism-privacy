import { prisma } from '../config/prisma.js'
import { logger } from './logger.js'
import { GALLERY_PREFIX, destroyGallery, listGalleryCollections } from './faceGallery.js'

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

// Session galleries are torn down at finalize and on terminal job failure, but a
// crashed process between those points would leave the collection behind holding
// re-derived biometric vectors. This sweep is the backstop.
export async function cleanupOrphanGalleries() {
  let names
  try {
    names = await listGalleryCollections()
  } catch (err) {
    logger.warn({ err }, 'cleanupOrphanGalleries: qdrant unreachable')
    return { checked: 0, dropped: 0 }
  }

  let dropped = 0
  for (const name of names) {
    const sessionId = name.slice(GALLERY_PREFIX.length)
    const session = await prisma.session
      .findUnique({ where: { id: sessionId }, select: { status: true } })
      .catch(() => null)

    if (!session || ['ARCHIVED', 'FAILED'].includes(session.status)) {
      await destroyGallery(sessionId)
      dropped += 1
    }
  }

  logger.info({ checked: names.length, dropped }, 'cleanupOrphanGalleries: done')
  return { checked: names.length, dropped }
}
