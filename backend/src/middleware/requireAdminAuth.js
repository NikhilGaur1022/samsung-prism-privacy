import { verifyAdminAccessToken } from '../lib/tokens.js'
import { getAdminTokenValidAfter } from '../lib/revocation.js'
import { ADMIN_ACCESS_COOKIE } from '../lib/cookies.js'
import { ApiError } from './errorHandler.js'

// Replaces the dev-stub requireAuth for all admin routes. On top of JWT
// signature/expiry, checks the Redis tokenValidAfter hotlist so a role change or
// account disable takes effect immediately instead of waiting out the 15-minute
// access token TTL (see auth-rbac-otp-plan.md 1e, gap #2).
export async function requireAdminAuth(req, _res, next) {
  const token = req.cookies?.[ADMIN_ACCESS_COOKIE]
  if (!token) return next(new ApiError(401, 'Not authenticated'))

  let payload
  try {
    payload = verifyAdminAccessToken(token)
  } catch {
    return next(new ApiError(401, 'Invalid or expired session'))
  }

  const validAfter = await getAdminTokenValidAfter(payload.sub)
  if (validAfter && payload.iat * 1000 < validAfter) {
    return next(new ApiError(401, 'Session invalidated — please sign in again'))
  }

  req.admin = { id: payload.sub, role: payload.role }
  next()
}
