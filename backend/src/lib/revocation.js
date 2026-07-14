import { redis } from '../config/redis.js'

const KEY_PREFIX = 'admin:tokenValidAfter:'
// Matches refresh-token TTL — a revocation marker doesn't need to outlive the
// longest-lived token it could ever need to invalidate.
const TTL_SECONDS = 7 * 24 * 60 * 60

function key(adminUserId) {
  return `${KEY_PREFIX}${adminUserId}`
}

// Reuses the same Redis hotlist pattern backend-plan.md uses for consent
// revocation ("write to Redis before DB commit, closes the race window").
// Call this on role change, disable, or password reset so already-issued
// 15-minute access tokens stop working immediately instead of waiting out their TTL.
export async function markAdminTokensInvalidBefore(adminUserId, when = new Date()) {
  await redis.set(key(adminUserId), when.getTime(), 'EX', TTL_SECONDS)
}

// Returns epoch ms, or null if this admin has never had a revocation event.
export async function getAdminTokenValidAfter(adminUserId) {
  const value = await redis.get(key(adminUserId))
  return value ? Number(value) : null
}
