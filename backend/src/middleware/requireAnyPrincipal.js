import { requireAdminAuth } from './requireAdminAuth.js'
import { requireSubjectAuth } from './requireSubjectAuth.js'
import { ADMIN_ACCESS_COOKIE } from '../lib/cookies.js'

// For the handful of endpoints both an admin and a data principal legitimately
// reach — today only the rendered §5 notice, which a principal must read before
// signing and an admin must be able to preview.
//
// It dispatches on which cookie is present rather than trying both: the two token
// families are signed with different secrets, so "try admin, fall back to subject"
// would turn every subject request into a failed admin verification, and a future
// lockout counter on admin auth would then be driven by ordinary subject traffic.
// Downstream handlers still branch on req.admin vs req.subject — this middleware
// authenticates, it does not authorize.
export function requireAnyPrincipal(req, res, next) {
  if (req.cookies?.[ADMIN_ACCESS_COOKIE]) return requireAdminAuth(req, res, next)
  return requireSubjectAuth(req, res, next)
}
