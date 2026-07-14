import { Router } from 'express'
import { requireSubjectAuth } from '../../middleware/requireSubjectAuth.js'
import {
  subjectLoginIpLimiter,
  subjectLoginEmailLimiter,
  subjectVerifyIpLimiter,
  subjectVerifyEmailLimiter,
} from '../../middleware/rateLimiter.js'
import * as authSubjectController from './auth-subject.controller.js'

export const authSubjectRoutes = Router()

authSubjectRoutes.post(
  '/login',
  subjectLoginIpLimiter,
  subjectLoginEmailLimiter,
  authSubjectController.requestLogin,
)
authSubjectRoutes.post(
  '/verify',
  subjectVerifyIpLimiter,
  subjectVerifyEmailLimiter,
  authSubjectController.verify,
)
authSubjectRoutes.get('/me', requireSubjectAuth, authSubjectController.me)
authSubjectRoutes.post('/refresh', authSubjectController.refresh)
authSubjectRoutes.post('/logout', authSubjectController.logout)
