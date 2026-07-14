import { verifySubjectAccessToken } from '../lib/tokens.js'
import { SUBJECT_ACCESS_COOKIE } from '../lib/cookies.js'
import { ApiError } from './errorHandler.js'

// Entirely separate from requireAdminAuth — verifies the subject JWT (signed with
// JWT_SUBJECT_SECRET) and attaches req.subject. An admin token can never satisfy
// this because it's signed with a different secret and carries principalType: ADMIN.
export function requireSubjectAuth(req, _res, next) {
  const token = req.cookies?.[SUBJECT_ACCESS_COOKIE]
  if (!token) return next(new ApiError(401, 'Not authenticated'))

  try {
    const payload = verifySubjectAccessToken(token)
    req.subject = { masterUserId: payload.sub }
    next()
  } catch {
    next(new ApiError(401, 'Invalid or expired session'))
  }
}
