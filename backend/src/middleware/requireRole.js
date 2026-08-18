import { ApiError } from './errorHandler.js'

// Composes after requireAdminAuth. Mirrors admin-portal's RequireRole({ allow })
// frontend pattern — the frontend hides nav for other roles, this is the
// enforcement that actually matters.
export function requireRole(...allowed) {
  return (req, _res, next) => {
    if (!req.admin) return next(new ApiError(401, 'Not authenticated'))
    if (!allowed.includes(req.admin.role)) {
      // Naming the floor is not a leak — the caller is an authenticated operator
      // and the matrix is documented. A bare "Not authorized" left a dpo pressing
      // a button the UI had offered them with no way to tell whether the refusal
      // was their role, the request's state, or a bug.
      return next(
        new ApiError(
          403,
          `Not authorized for this action — it requires the ${allowed.join(' or ')} role, and yours is ${req.admin.role}.`,
        ),
      )
    }
    next()
  }
}
