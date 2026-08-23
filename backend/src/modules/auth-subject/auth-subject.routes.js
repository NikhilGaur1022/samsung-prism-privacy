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
// Registration issues an OTP by exactly the same path as login, so it is capped
// by the same two limiters — per-IP and per-email. Sharing the buckets is the
// point: otherwise "request a code" would have one budget and "register, which
// also sends a code" would have a second, and an attacker would simply alternate.
authSubjectRoutes.post(
  '/register',
  subjectLoginIpLimiter,
  subjectLoginEmailLimiter,
  authSubjectController.register,
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
