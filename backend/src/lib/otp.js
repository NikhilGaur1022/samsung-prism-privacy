import { randomInt, createHash } from 'node:crypto'
import { prisma } from '../config/prisma.js'
import { ApiError } from '../middleware/errorHandler.js'
import { IS_HARDENED } from '../config/env.js'
import { logger } from './logger.js'

const OTP_LENGTH = 6
const EXPIRY_MINUTES = 10
const MAX_ATTEMPTS = 5
const RESEND_COOLDOWN_SECONDS = 60

function hashCode(code) {
  return createHash('sha256').update(code).digest('hex')
}

function generateCode() {
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0')
}

// Enforces the 60s resend cooldown server-side — call before issuing a new code.
export async function assertResendCooldown(email, purpose) {
  const last = await prisma.otpCode.findFirst({
    where: { email, purpose },
    orderBy: { createdAt: 'desc' },
  })

  if (!last) return

  const secondsSinceLast = (Date.now() - last.createdAt.getTime()) / 1000
  if (secondsSinceLast < RESEND_COOLDOWN_SECONDS) {
    throw new ApiError(429, 'Please wait before requesting another code', {
      retryAfterSeconds: Math.ceil(RESEND_COOLDOWN_SECONDS - secondsSinceLast),
    })
  }
}

// Dev-only escape hatch, returning the code to the client for hands-on testing.
//
// A plaintext OTP in an HTTP response body is an account-takeover primitive:
// anyone who can reach the login endpoint can request a code for any address and
// read it straight back. This shipped once already, gated on a bare
// `NODE_ENV === 'production'` string comparison — one typo, one "Production",
// one unset variable, and every account in the system is open.
//
// So it is back, because testing without a mail server needs it, but behind TWO
// independent gates that must BOTH be open:
//
//   1. IS_HARDENED must be false. config/env.js validates NODE_ENV against an
//      allowlist and refuses to boot on anything unrecognised, so this can no
//      longer be defeated by a misspelling.
//   2. EXPOSE_DEV_OTP must be exactly "on". Not a default, not an absence — a
//      deliberate act, recorded in the environment, that someone has to have
//      taken on purpose.
//
// scripts/preflight.js fails if the flag is set while the environment is
// hardened, so the combination cannot reach production quietly. The response
// field is named `devOtp` rather than `otp` so it is obvious in a network log
// that this is not a production affordance.
export function devOtpExposed() {
  return !IS_HARDENED && process.env.EXPOSE_DEV_OTP === 'on'
}

export function devOtp(code, email) {
  if (IS_HARDENED) return undefined

  // The log line stays regardless of the flag: it is how the code was read
  // before this existed, and the automated UI check still reads it from there.
  logger.debug({ email, otp: code }, 'dev OTP issued')

  return devOtpExposed() ? code : undefined
}

export async function createOtp(email, purpose) {
  const code = generateCode()

  const otp = await prisma.otpCode.create({
    data: {
      email,
      purpose,
      codeHash: hashCode(code),
      maxAttempts: MAX_ATTEMPTS,
      expiresAt: new Date(Date.now() + EXPIRY_MINUTES * 60 * 1000),
    },
  })

  return { id: otp.id, code }
}

// Verifies against the most recent unconsumed code for this email/purpose.
// Wrong-attempt counting and expiry are enforced here, not left to the caller.
export async function verifyOtp(email, purpose, code) {
  const otp = await prisma.otpCode.findFirst({
    where: { email, purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  })

  if (!otp) throw new ApiError(400, 'No active code for this email — request a new one')

  if (otp.expiresAt < new Date()) {
    throw new ApiError(400, 'Code expired — request a new one')
  }

  if (otp.attempts >= otp.maxAttempts) {
    throw new ApiError(400, 'Too many incorrect attempts — request a new one')
  }

  if (hashCode(code) !== otp.codeHash) {
    await prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } })
    throw new ApiError(400, 'Incorrect code')
  }

  await prisma.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } })
}
