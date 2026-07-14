import { Resend } from 'resend'
import { ApiError } from '../middleware/errorHandler.js'
import { logger } from './logger.js'

const resend = new Resend(process.env.RESEND_API_KEY)
const FROM = process.env.RESEND_FROM_EMAIL ?? 'Prism <onboarding@resend.dev>'

// A Resend trial key can only deliver to the account owner's own address, so any
// test subject with a made-up email would never receive a code. Outside production
// the code is also written to the server log — the email is still attempted, this
// is purely an escape hatch for local testing. Guarded so it can never leak a live
// code into production logs.
const LOG_OTP = process.env.NODE_ENV !== 'production'

// Single attempt, no automatic retry — a silent server-side retry risks a
// duplicate send if Resend's response is slow/ambiguous. On failure this throws
// a 502 that errorHandler.js logs at `error` level with the request's correlation
// id; the client's only retry path is the existing "Resend Code" UI action.
async function send({ to, subject, html }) {
  const { error } = await resend.emails.send({ from: FROM, to, subject, html })
  if (!error) return

  // In dev a rejected send (trial key, unverified test address) must not fail the
  // whole request — the code is in the log above and the flow stays testable.
  if (LOG_OTP) {
    logger.warn({ to, error }, 'email send failed — continuing (dev)')
    return
  }
  throw new ApiError(502, 'Failed to send email — please try again shortly')
}

export function sendOtpEmail(email, code) {
  if (LOG_OTP) logger.info({ email, code }, 'DEV ONLY — OTP code')

  return send({
    to: email,
    subject: 'Your Prism verification code',
    html: `<p>Your verification code is:</p><h2 style="letter-spacing:4px">${code}</h2><p>This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>`,
  })
}

export function sendAdminInviteEmail(email, acceptUrl) {
  return send({
    to: email,
    subject: "You've been invited to Prism",
    html: `<p>You've been invited to join Prism as an administrator.</p><p><a href="${acceptUrl}">Accept your invite</a></p><p>This link is single-use and will expire.</p>`,
  })
}

export function sendPasswordResetEmail(email, resetUrl) {
  return send({
    to: email,
    subject: 'Reset your Prism password',
    html: `<p>A password reset was requested for your Prism admin account.</p><p><a href="${resetUrl}">Reset your password</a></p><p>If you didn't request this, you can ignore this email — your password won't change.</p>`,
  })
}
