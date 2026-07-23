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
