import * as authSubjectService from './auth-subject.service.js'
import { requestLoginSchema, verifyLoginSchema } from './auth-subject.validation.js'
import {
  setSubjectAuthCookies,
  clearSubjectAuthCookies,
  SUBJECT_REFRESH_COOKIE,
} from '../../lib/cookies.js'
import { ApiError } from '../../middleware/errorHandler.js'

export async function requestLogin(req, res, next) {
  try {
    const { email } = requestLoginSchema.parse(req.body)
    const { devOtp } = await authSubjectService.requestLogin(email)
    res.json({ message: 'Verification code sent', ...(devOtp && { devOtp }) })
  } catch (err) {
    next(err)
  }
}

export async function verify(req, res, next) {
  try {
    const { email, otp } = verifyLoginSchema.parse(req.body)
    const { subject, accessToken, refreshToken } = await authSubjectService.verifyLoginAndIssueSession(
      email,
      otp,
    )
    setSubjectAuthCookies(res, { accessToken, refreshToken })
    res.json({
      masterUserId: subject.masterUserId,
      email: subject.email,
      group: subject.group,
      status: subject.status,
    })
  } catch (err) {
    next(err)
  }
}

export async function me(req, res, next) {
  try {
    const result = await authSubjectService.getMe(req.subject.masterUserId)
    res.json(result)
  } catch (err) {
    next(err)
  }
}

export async function refresh(req, res, next) {
  try {
    const raw = req.cookies?.[SUBJECT_REFRESH_COOKIE]
    if (!raw) throw new ApiError(401, 'Not authenticated')

    const { accessToken, refreshToken } = await authSubjectService.refreshSession(raw)
    setSubjectAuthCookies(res, { accessToken, refreshToken })
    res.status(204).end()
  } catch (err) {
    next(err)
  }
}

export async function logout(req, res, next) {
  try {
    const raw = req.cookies?.[SUBJECT_REFRESH_COOKIE]
    if (raw) await authSubjectService.logout(raw)
    clearSubjectAuthCookies(res)
    res.status(204).end()
  } catch (err) {
    next(err)
  }
}
