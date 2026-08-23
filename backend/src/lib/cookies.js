import { IS_HARDENED } from '../config/env.js'

// Secure cookies wherever the app is reachable over a network — see config/env.js
// for why this is not an inline NODE_ENV comparison any more.
const isProd = IS_HARDENED

// Distinct cookie names/paths for subject vs admin sessions. Refresh cookies are
// scoped to their own refresh endpoint only — narrows the blast radius of any
// cookie-reading XSS to routes that don't matter as much as the refresh endpoint.
export const SUBJECT_ACCESS_COOKIE = 'prism_subject_at'
export const SUBJECT_REFRESH_COOKIE = 'prism_subject_rt'
export const ADMIN_ACCESS_COOKIE = 'prism_admin_at'
export const ADMIN_REFRESH_COOKIE = 'prism_admin_rt'

const baseOptions = { httpOnly: true, secure: isProd, sameSite: 'strict' }

export function setSubjectAuthCookies(res, { accessToken, refreshToken }) {
  res.cookie(SUBJECT_ACCESS_COOKIE, accessToken, { ...baseOptions, path: '/' })
  res.cookie(SUBJECT_REFRESH_COOKIE, refreshToken, {
    ...baseOptions,
    path: '/auth/subject/refresh',
  })
}

export function clearSubjectAuthCookies(res) {
  res.clearCookie(SUBJECT_ACCESS_COOKIE, { ...baseOptions, path: '/' })
  res.clearCookie(SUBJECT_REFRESH_COOKIE, { ...baseOptions, path: '/auth/subject/refresh' })
}

export function setAdminAuthCookies(res, { accessToken, refreshToken }) {
  res.cookie(ADMIN_ACCESS_COOKIE, accessToken, { ...baseOptions, path: '/' })
  res.cookie(ADMIN_REFRESH_COOKIE, refreshToken, { ...baseOptions, path: '/auth/admin/refresh' })
}

export function clearAdminAuthCookies(res) {
  res.clearCookie(ADMIN_ACCESS_COOKIE, { ...baseOptions, path: '/' })
  res.clearCookie(ADMIN_REFRESH_COOKIE, { ...baseOptions, path: '/auth/admin/refresh' })
}
