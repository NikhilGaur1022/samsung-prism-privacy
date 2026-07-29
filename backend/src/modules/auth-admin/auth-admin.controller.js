import * as authAdminService from './auth-admin.service.js'
import {
  loginSchema,
  inviteSchema,
  acceptInviteSchema,
  requestResetSchema,
  resetPasswordSchema,
  listAdminsQuerySchema,
} from './auth-admin.validation.js'
import { setAdminAuthCookies, clearAdminAuthCookies, ADMIN_REFRESH_COOKIE } from '../../lib/cookies.js'
import { ApiError } from '../../middleware/errorHandler.js'

export async function login(req, res, next) {
  try {
    const { email, password } = loginSchema.parse(req.body)
    const { admin, accessToken, refreshToken } = await authAdminService.login(email, password)
    setAdminAuthCookies(res, { accessToken, refreshToken })
    res.json({ id: admin.id, email: admin.email, role: admin.role })
  } catch (err) {
    next(err)
  }
}

export async function invite(req, res, next) {
  try {
    const { email, role } = inviteSchema.parse(req.body)
    const admin = await authAdminService.invite(email, role, req.admin.id)
    res.status(201).json({ id: admin.id, email: admin.email, role: admin.role, status: admin.status })
  } catch (err) {
    next(err)
  }
}

export async function acceptInvite(req, res, next) {
  try {
    const { token, password } = acceptInviteSchema.parse(req.body)
    await authAdminService.acceptInvite(token, password)
    res.json({ message: 'Account activated — you can now sign in' })
  } catch (err) {
    next(err)
  }
}

export async function requestReset(req, res, next) {
  try {
    const { email } = requestResetSchema.parse(req.body)
    await authAdminService.requestReset(email)
    res.json({ message: 'If that email is registered, a reset link has been sent' })
  } catch (err) {
    next(err)
  }
}

export async function resetPassword(req, res, next) {
  try {
    const { token, newPassword } = resetPasswordSchema.parse(req.body)
    await authAdminService.resetPassword(token, newPassword)
    res.json({ message: 'Password updated — you can now sign in' })
  } catch (err) {
    next(err)
  }
}

export async function me(req, res, next) {
  try {
    const result = await authAdminService.getMe(req.admin.id)
    res.json(result)
  } catch (err) {
    next(err)
  }
}

export async function listUsers(req, res, next) {
  try {
    const { role } = listAdminsQuerySchema.parse(req.query)
    res.json({ items: await authAdminService.listAdmins({ role }) })
  } catch (err) {
    next(err)
  }
}

export async function refresh(req, res, next) {
  try {
    const raw = req.cookies?.[ADMIN_REFRESH_COOKIE]
    if (!raw) throw new ApiError(401, 'Not authenticated')

    const { accessToken, refreshToken } = await authAdminService.refreshSession(raw)
    setAdminAuthCookies(res, { accessToken, refreshToken })
    res.status(204).end()
  } catch (err) {
    next(err)
  }
}

export async function logout(req, res, next) {
  try {
    const raw = req.cookies?.[ADMIN_REFRESH_COOKIE]
    if (raw) await authAdminService.logout(raw)
    clearAdminAuthCookies(res)
    res.status(204).end()
  } catch (err) {
    next(err)
  }
}
