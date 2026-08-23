import { rateLimit } from 'express-rate-limit'
import { RedisStore } from 'rate-limit-redis'
import { redis } from '../config/redis.js'

const WINDOW_MS = 15 * 60 * 1000

function emailKey(req) {
  return (req.body?.email ?? req.ip).toLowerCase()
}

// Redis-backed so limits hold across multiple app instances, not just per-process.
// Each limiter gets its own key prefix — sharing one would let one endpoint's
// counter bleed into another's.
function makeLimiter({ limit, prefix, keyGenerator }) {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    store: new RedisStore({ sendCommand: (...args) => redis.call(...args), prefix }),
    ...(keyGenerator && { keyGenerator }),
  })
}

// Per-IP and per-email on subject login/verify — closes both the "one attacker,
// many emails" and "one email, many IPs" angles.
export const subjectLoginIpLimiter = makeLimiter({ limit: 20, prefix: 'rl:subject-login-ip:' })
export const subjectLoginEmailLimiter = makeLimiter({
  limit: 5,
  prefix: 'rl:subject-login-email:',
  keyGenerator: emailKey,
})

export const subjectVerifyIpLimiter = makeLimiter({ limit: 30, prefix: 'rl:subject-verify-ip:' })
export const subjectVerifyEmailLimiter = makeLimiter({
  limit: 10,
  prefix: 'rl:subject-verify-email:',
  keyGenerator: emailKey,
})

// The join lookup is fully public — the only thing standing between a scanner and
// an enumeration attempt is the token's 256 bits and this. Accept is separate and
// tighter: it writes consent records.
export const joinLookupIpLimiter = makeLimiter({ limit: 60, prefix: 'rl:join-lookup-ip:' })
export const joinAcceptIpLimiter = makeLimiter({ limit: 20, prefix: 'rl:join-accept-ip:' })

// Admin login also gets the independent per-account lockout in auth-admin/service.js —
// this only covers the IP-flood case, not the slow-distributed-attack case.
export const adminLoginIpLimiter = makeLimiter({ limit: 30, prefix: 'rl:admin-login-ip:' })


// ---------------------------------------------------------------------------
// Data and media routes
// ---------------------------------------------------------------------------
// There was no rate limit on any data or upload route at all — only on the four
// auth endpoints. That left two open primitives:
//
//   1. Media reads. logAccess writes an AccessEvent BEFORE the handler runs, so
//      one HTTP GET per row is an unbounded INSERT primitive against the
//      append-only table DPDP accountability rests on. Validating the params
//      first (middleware/uuidParams.js) stops the junk rows; this stops the
//      volume.
//   2. Uploads. A 20-file x 25 MB endpoint with no limiter is a 500 MB-per-
//      request memory amplifier, which is how one POST was measured at exactly
//      that.
//
// Keyed on the authenticated principal rather than the IP where one is
// available: behind a proxy every request shares an address, and an IP-keyed
// limit on an authenticated route punishes a whole office for one client.
function principalKey(req) {
  return req.admin?.id ?? req.subject?.masterUserId ?? req.ip
}

export const mediaReadLimiter = makeLimiter({
  limit: Number(process.env.RATE_LIMIT_MEDIA ?? 600),
  prefix: 'rl:media:',
  keyGenerator: principalKey,
})

export const uploadLimiter = makeLimiter({
  limit: Number(process.env.RATE_LIMIT_UPLOAD ?? 120),
  prefix: 'rl:upload:',
  keyGenerator: principalKey,
})

// Export builds read and re-encode every image in a project. A handful per
// window is generous; a loop is not.
export const exportLimiter = makeLimiter({
  limit: Number(process.env.RATE_LIMIT_EXPORT ?? 10),
  prefix: 'rl:export:',
  keyGenerator: principalKey,
})
