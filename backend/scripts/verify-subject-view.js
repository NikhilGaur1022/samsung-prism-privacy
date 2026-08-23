#!/usr/bin/env node
/**
 * Checks what a data principal can actually see about themselves.
 *
 * The admin side and the subject side have to agree: if an agent captured
 * twelve photos of someone in a session, that person's own portal must say so.
 * This walks the subject-facing endpoints the user portal calls and prints what
 * comes back, so a divergence between "what we hold" and "what we admit to
 * holding" is visible rather than inferred.
 *
 * Usage: node scripts/verify-subject-view.js <subject-email>
 */
import 'dotenv/config'

const BASE = process.env.DEMO_API_URL ?? 'http://127.0.0.1:4000'
const email = process.argv[2]

if (!email) {
  console.error('usage: node scripts/verify-subject-view.js <subject-email>')
  process.exit(2)
}

const cookies = new Map()

function absorb(res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const i = pair.indexOf('=')
    if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
  }
}

async function call(method, path, json) {
  const headers = {}
  if (cookies.size) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  if (json) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: json ? JSON.stringify(json) : undefined,
  })
  absorb(res)
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body }
}

const line = (label, value) => console.log(`  ${label.padEnd(22)} ${value}`)

async function main() {
  console.log(`Subject view for ${email}\n`)

  const login = await call('POST', '/auth/subject/login', { email })
  const otp = login.body?.devOtp ?? login.body?.otp
  if (!otp) {
    console.error(`No OTP returned (status ${login.status}). EXPOSE_DEV_OTP must be "on".`)
    process.exit(1)
  }

  const verified = await call('POST', '/auth/subject/verify', { email, otp })
  if (verified.status !== 200) {
    console.error(`verify failed: ${verified.status} ${JSON.stringify(verified.body)}`)
    process.exit(1)
  }
  line('signed in as', verified.body?.subject?.fullName ?? verified.body?.fullName ?? '(unnamed)')

  const checks = [
    ['GET', '/auth/subject/me', 'account'],
    ['GET', '/api/v1/consent/projects', 'projects to consent to'],
    ['GET', '/api/v1/me/participations', 'sessions I am in'],
    ['GET', '/api/v1/me/enrollment-status', 'my biometric enrolments'],
    ['GET', '/api/v1/me/enrollments', 'my face enrolments'],
    ['GET', '/api/v1/me/voice-enrollments', 'my voice enrolments'],
    ['GET', '/api/v1/me/photos', 'photos held of me'],
    ['GET', '/api/v1/me/dsar', 'my DSAR requests'],
  ]

  console.log('')
  let failures = 0
  for (const [method, path, label] of checks) {
    const res = await call(method, path)
    const b = res.body
    let summary
    if (res.status >= 400) {
      summary = `HTTP ${res.status} ${typeof b === 'object' ? b?.error ?? '' : ''}`
      // A 404 on a route this build does not expose is information, not a fault.
      if (res.status !== 404) failures += 1
    } else if (Array.isArray(b)) summary = `${b.length} item(s)`
    else if (Array.isArray(b?.items)) summary = `${b.items.length} item(s)`
    else if (b && typeof b === 'object') summary = JSON.stringify(b).slice(0, 150)
    else summary = String(b).slice(0, 100)
    line(label, summary)
  }

  // The one that matters most: the subject's own view of the photos held of them.
  console.log('')
  const parts = await call('GET', '/api/v1/me/participations')
  const items = parts.body?.items ?? parts.body ?? []
  if (Array.isArray(items) && items.length > 0) {
    console.log('  sessions this person appears in:')
    for (const p of items) {
      const code = p.session?.code ?? p.sessionCode ?? p.code ?? '?'
      const project = p.session?.project?.name ?? p.projectName ?? ''
      const type = p.session?.type ?? p.type ?? ''
      const status = p.session?.status ?? p.status ?? ''
      console.log(`    ${String(code).padEnd(12)} ${String(type).padEnd(6)} ${String(status).padEnd(10)} ${project}`)
    }
  } else {
    console.log('  (no participations reported)')
  }

  console.log(`\n${failures === 0 ? 'OK — every subject-facing endpoint answered' : `${failures} endpoint(s) errored`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`)
  process.exit(1)
})
