import { randomInt, createHash } from 'node:crypto'
import { prisma } from '../config/prisma.js'
import { ApiError } from '../middleware/errorHandler.js'

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

// Dev-only escape hatch: surfaces the plaintext code to the client so the flow
// stays testable without working email delivery. Hard-gated on NODE_ENV so a
// production build can never leak a live code over the wire.
export function devOtp(code) {
  return process.env.NODE_ENV === 'production' ? undefined : code
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
