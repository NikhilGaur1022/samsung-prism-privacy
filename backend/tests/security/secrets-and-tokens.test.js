import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'

import {
  signAdminAccessToken,
  verifyAdminAccessToken,
  signSubjectAccessToken,
  verifySubjectAccessToken,
} from '../../src/lib/tokens.js'

// The forged-token finding, and the gate that let it through.
//
// A super_admin JWT was minted with the shipped dev default
// JWT_ADMIN_SECRET="dev-admin-secret-change-in-prod", accepted by the live
// server, and used to create an admin through a super-admin-only route:
//
//   forged super_admin token -> GET  /auth/admin/me     200  {"role":"super_admin"}
//   forged super_admin token -> POST /auth/admin/invite 201  (admin created)
//
// scripts/preflight.js is documented as the go-live gate, and its JWT check was
// a fixed weak-word list with no length or entropy test:
//
//   isWeak('dev-admin-secret-change-in-prod') -> passes   (the running .env)
//   isWeak('change-me-admin-secret')          -> passes   (.env.example)
//   isWeak('hunter2')                         -> passes
//   isWeak('a')                               -> passes
//
// So a deploy that reused the dev .env, or copied .env.example and edited the
// other fields, went green while every admin and subject token was forgeable.

// The SHIPPED gate, imported rather than reimplemented. A test that re-derives
// the check proves nothing about the check that runs at deploy time — and the
// bug was in the check.
//
// preflight.js only executes its checks when invoked directly, so importing it
// here is inert apart from opening the Prisma client, which the teardown closes.
const { isWeak } = await import('../../scripts/preflight.js')

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('preflight rejects every secret that used to pass it', async () => {
  const mustBeRejected = [
    'dev-admin-secret-change-in-prod', // the running dev .env
    'change-me-admin-secret', // .env.example
    'change-me-subject-secret',
    'dev-only-secret-change-in-prod',
    'hunter2',
    'a',
    '',
    'password',
    'secret',
    // Long enough to clear a naive length check and worth nothing.
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'abababababababababababababababababababab',
    // Long, but with a placeholder marker in it.
    'this-is-a-very-long-value-please-change-me-before-production',
  ]

  const accepted = []
  for (const value of mustBeRejected) {
    if (!(isWeak(value))) accepted.push(value)
  }

  assert.deepEqual(
    accepted,
    [],
    'preflight accepted these secrets. Every token signed with one is forgeable:\n  ' +
      accepted.join('\n  '),
  )
})

test('preflight accepts a real generated secret', async () => {
  // The check must not be so strict that a correct value fails it, or the gate
  // gets bypassed rather than satisfied.
  const { randomBytes } = await import('node:crypto')
  for (let i = 0; i < 5; i += 1) {
    const good = randomBytes(48).toString('base64url')
    assert.equal(
      isWeak(good),
      false,
      `preflight rejected a 48-byte random secret: ${good}`,
    )
  }
})

test('the running environment has strong JWT secrets', () => {
  // Not a hypothetical. The forgery above was reproduced against this very
  // process's configuration.
  for (const name of ['JWT_ADMIN_SECRET', 'JWT_SUBJECT_SECRET']) {
    const value = process.env[name] ?? ''
    assert.ok(value.length >= 32, `${name} is ${value.length} chars; 32 is the floor`)
    assert.ok(
      !/change|dev-|placeholder|example/i.test(value),
      `${name} still contains a placeholder marker`,
    )
  }
  assert.notEqual(
    process.env.JWT_ADMIN_SECRET,
    process.env.JWT_SUBJECT_SECRET,
    'the admin and subject secrets are the same value',
  )
})

// ---------------------------------------------------------------------------
// The verifier
// ---------------------------------------------------------------------------

test('a token signed with the old shipped default is rejected', () => {
  const forged = jwt.sign(
    { principalType: 'ADMIN', sub: '00000000-0000-4000-8000-000000000000', role: 'super_admin' },
    'dev-admin-secret-change-in-prod',
    { expiresIn: '15m', issuer: 'prism', audience: 'prism:admin' },
  )

  assert.throws(
    () => verifyAdminAccessToken(forged),
    'a token signed with the shipped dev default was accepted',
  )
})

test('alg:none is rejected', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({ principalType: 'ADMIN', sub: 'x', role: 'super_admin' }),
  ).toString('base64url')

  assert.throws(() => verifyAdminAccessToken(`${header}.${payload}.`))
})

test('a subject token cannot satisfy an admin verify, and the reverse', () => {
  const subjectToken = signSubjectAccessToken({ masterUserId: '11111111-1111-4111-8111-111111111111' })
  const adminToken = signAdminAccessToken({ id: '22222222-2222-4222-8222-222222222222', role: 'dpo' })

  assert.throws(() => verifyAdminAccessToken(subjectToken), 'a subject token satisfied an admin verify')
  assert.throws(() => verifySubjectAccessToken(adminToken), 'an admin token satisfied a subject verify')
})

test('a token with the wrong audience is rejected even when the signature is ours', () => {
  // The audience pin is what makes the two token families structurally distinct
  // rather than distinct only by convention.
  const wrongAudience = jwt.sign(
    { principalType: 'ADMIN', sub: 'x', role: 'super_admin' },
    process.env.JWT_ADMIN_SECRET,
    { expiresIn: '15m', issuer: 'prism', audience: 'prism:subject' },
  )
  assert.throws(() => verifyAdminAccessToken(wrongAudience))
})

test('a token with the wrong issuer is rejected', () => {
  const wrongIssuer = jwt.sign(
    { principalType: 'ADMIN', sub: 'x', role: 'super_admin' },
    process.env.JWT_ADMIN_SECRET,
    { expiresIn: '15m', issuer: 'somebody-else', audience: 'prism:admin' },
  )
  assert.throws(() => verifyAdminAccessToken(wrongIssuer))
})

test('a legitimate token round-trips', () => {
  const token = signAdminAccessToken({ id: '33333333-3333-4333-8333-333333333333', role: 'dataAdmin' })
  const payload = verifyAdminAccessToken(token)
  assert.equal(payload.role, 'dataAdmin')
  assert.equal(payload.principalType, 'ADMIN')
  assert.equal(payload.iss, 'prism')
  assert.equal(payload.aud, 'prism:admin')
})

// ---------------------------------------------------------------------------
// NODE_ENV
// ---------------------------------------------------------------------------

test('an unrecognised NODE_ENV refuses to load rather than defaulting to development', async () => {
  // Secure cookies, the OTP gate, media sealing and the fatality of preflight
  // failures were all decided by `NODE_ENV === 'production'` compared exactly.
  // A value of `prod`, `staging`, `Production` or unset silently shipped
  // non-Secure cookies, leaked live OTP codes and wrote unsealed media.
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)

  for (const bad of ['prod', 'Production', 'PRODUCTION', 'live', 'stage']) {
    let threw = false
    try {
      await run(process.execPath, ['--input-type=module', '-e', "import('./src/config/env.js')"], {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: bad },
      })
    } catch {
      threw = true
    }
    assert.ok(threw, `NODE_ENV="${bad}" loaded without complaint`)
  }
})

test('the recognised environments load', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)

  for (const good of ['development', 'test', 'staging', 'production']) {
    await run(process.execPath, ['--input-type=module', '-e', "import('./src/config/env.js')"], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: good },
    })
  }
})

test('the OTP escape hatch cannot return a code in a hardened environment', async () => {
  // devOtp used to return the plaintext code under a bare NODE_ENV gate, and the
  // login response carried it: `{"message":"...","devOtp":"525168"}`. Combined
  // with subject enumeration that is full account takeover with no email access.
  //
  // It returns the code again, on purpose, so testing works without a mail
  // server — but only when the environment is non-hardened AND EXPOSE_DEV_OTP is
  // exactly "on". Both gates are read at import time, so each case runs in its
  // own process; flipping process.env inside this one would prove nothing.
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)

  const probe = async (env) => {
    const { stdout } = await run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "const { devOtp } = await import('./src/lib/otp.js'); " +
          "process.stdout.write('<<<' + String(devOtp('123456', 'someone@example.com')) + '>>>')",
      ],
      { cwd: process.cwd(), env: { ...process.env, ...env } },
    )
    // Delimited, because the child also emits the pretty-printed dev log line on
    // stdout and pino flushes it whenever it pleases. Reading the raw stream
    // would fail on log noise rather than on the thing under test.
    const match = stdout.match(/<<<([\s\S]*?)>>>/)
    assert.ok(match, `probe produced no result marker; stdout was:
${stdout}`)
    return match[1]
  }

  // The cases that matter: the flag is set, deliberately, and must still be
  // refused wherever the environment is hardened. `staging` is in here because
  // IS_HARDENED covers it and production is not the only place real people's
  // addresses live.
  for (const NODE_ENV of ['production', 'staging']) {
    assert.equal(
      await probe({ NODE_ENV, EXPOSE_DEV_OTP: 'on' }),
      'undefined',
      `NODE_ENV=${NODE_ENV} with EXPOSE_DEV_OTP=on returned the code`,
    )
  }

  // Absent or half-set flag is off everywhere, including in development. Only
  // the exact string opens it — no truthiness, no "true", no "1".
  for (const EXPOSE_DEV_OTP of ['', 'off', 'true', '1', 'ON']) {
    assert.equal(
      await probe({ NODE_ENV: 'development', EXPOSE_DEV_OTP }),
      'undefined',
      `EXPOSE_DEV_OTP=${JSON.stringify(EXPOSE_DEV_OTP)} opened the gate`,
    )
  }

  // And the case that proves the four assertions above are not passing because
  // devOtp simply returns undefined unconditionally. Without this, stubbing the
  // function out would leave the whole test green.
  assert.equal(
    await probe({ NODE_ENV: 'development', EXPOSE_DEV_OTP: 'on' }),
    '123456',
    'the escape hatch does not work at all, so the negative cases prove nothing',
  )
})


test('teardown', async () => {
  // preflight.js imports the Prisma client at module scope.
  const { prisma } = await import('../../src/config/prisma.js')
  await prisma.$disconnect().catch(() => {})
})
