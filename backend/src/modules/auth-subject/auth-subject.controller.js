import * as authSubjectService from './auth-subject.service.js'
import * as subjectService from '../subjects/subject.service.js'
import { requestLoginSchema, verifyLoginSchema } from './auth-subject.validation.js'
import { selfRegisterSubjectSchema } from '../subjects/subject.validation.js'
import {
  setSubjectAuthCookies,
  clearSubjectAuthCookies,
  SUBJECT_REFRESH_COOKIE,
} from '../../lib/cookies.js'
import { ApiError } from '../../middleware/errorHandler.js'

export async function requestLogin(req, res, next) {
  try {
    const { email } = requestLoginSchema.parse(req.body)
    const result = await authSubjectService.requestLogin(email)
    // `devOtp` is present ONLY when the environment is non-hardened and
    // EXPOSE_DEV_OTP=on — both gates, deliberately, because echoing a code back
    // to whoever asked for it makes every account takeable over with nothing but
    // an email address. This shipped once behind a single NODE_ENV string
    // comparison; two independent gates and a preflight check is the price of
    // having it back for hands-on testing.
    res.json({
      message: 'Verification code sent',
      ...(result?.devOtp ? { devOtp: result.devOtp } : {}),
    })
  } catch (err) {
    next(err)
  }
}

// Self-registration. This lives on the public auth router rather than under
// /api/v1/subjects because that router is gated to collectionAgent and
// super_admin — correctly, since it returns and mutates other people's identity.
// The user portal's "Create an account" page was pointed at it anyway, so every
// self-registration answered 401 and the page was dead. Splitting the one
// anonymous-safe operation out is the fix; widening the admin router would have
// exposed the subject list to the internet.
//
// What comes back is deliberately minimal. The caller is anonymous until they
// verify, so they get an id to carry forward and nothing else — not the stored
// record, which would echo back a `status` and consent flags they have no
// standing to read yet.
export async function register(req, res, next) {
  try {
    const input = selfRegisterSubjectSchema.parse(req.body)
    const subject = await subjectService.registerSubject(
      // Channel is asserted here, not parsed from the body: SELF is the only
      // truthful value for a request nobody authenticated.
      { ...input, registrationChannel: 'SELF' },
      // No actor. A null actorId in the audit log reads as "the subject did this
      // themselves", which is what happened — stamping some system user here
      // would put a false name on the chain.
      null,
    )
    res.status(201).json({
      masterUserId: subject.masterUserId,
      email: subject.email,
      ...(subject.devOtp ? { devOtp: subject.devOtp } : {}),
    })
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
