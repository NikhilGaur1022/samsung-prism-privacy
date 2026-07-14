import { Router } from 'express'
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import { adminLoginIpLimiter } from '../../middleware/rateLimiter.js'
import * as authAdminController from './auth-admin.controller.js'

export const authAdminRoutes = Router()

authAdminRoutes.post('/login', adminLoginIpLimiter, authAdminController.login)
authAdminRoutes.post('/accept-invite', authAdminController.acceptInvite)
authAdminRoutes.post('/request-reset', authAdminController.requestReset)
authAdminRoutes.post('/reset-password', authAdminController.resetPassword)
authAdminRoutes.post('/refresh', authAdminController.refresh)
authAdminRoutes.post('/logout', authAdminController.logout)

authAdminRoutes.get('/me', requireAdminAuth, authAdminController.me)
authAdminRoutes.post(
  '/invite',
  requireAdminAuth,
  requireRole('super_admin'),
  authAdminController.invite,
)
