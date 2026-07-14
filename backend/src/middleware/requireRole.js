import { ApiError } from './errorHandler.js'

// Composes after requireAdminAuth. Mirrors admin-portal's RequireRole({ allow })
// frontend pattern — the frontend hides nav for other roles, this is the
// enforcement that actually matters.
export function requireRole(...allowed) {
  return (req, _res, next) => {
    if (!req.admin) return next(new ApiError(401, 'Not authenticated'))
    if (!allowed.includes(req.admin.role)) {
      return next(new ApiError(403, 'Not authorized for this action'))
    }
    next()
  }
}
