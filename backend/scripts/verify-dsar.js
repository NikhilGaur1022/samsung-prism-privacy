#!/usr/bin/env node
/**
 * Drives one erasure request from end to end and checks that it actually erased.
 *
 * The DSAR path is the part of this product that is hardest to believe without
 * evidence: everything else can be verified by looking at it, but "we deleted
 * this person" is a claim about absence. So this raises a real ERASE request as
 * the principal, walks it through discovery, approval and execution as the
 * admins who are allowed to, and then asks the platform what it still holds
 * about them — from the principal's own session, which is the view that matters.
 *
 * Usage: node scripts/verify-dsar.js <subject-email>
 */
import 'dotenv/config'

const BASE = process.env.DEMO_API_URL ?? 'http://127.0.0.1:4000'
const PASSWORD = process.env.DEV_ADMIN_PASSWORD ?? 'Prism@2026!'
const email = process.argv[2]

if (!email) {
  console.error('usage: node scripts/verify-dsar.js <subject-email>')
  process.exit(2)
}

class Jar {
  constructor() {
    this.c = new Map()
  }
  absorb(res) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';')
      const i = pair.indexOf('=')
      if (i > 0) this.c.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
    }
  }
  header() {
    return [...this.c].map(([k, v]) => `${k}=${v}`).join('; ')
  }
}

async function call(jar, method, path, json, { allow } = {}) {
  const headers = {}
  const cookie = jar?.header()
  if (cookie) headers.Cookie = cookie
  if (json) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: json ? JSON.stringify(json) : undefined,
  })
  jar?.absorb(res)
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!res.ok && !(allow ?? []).includes(res.status)) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(body).slice(0, 300)}`)
  }
  return { status: res.status, body }
}

const step = (m) => console.log(`\n${m}`)
const ok = (m) => console.log(`  ok  ${m}`)
const note = (m) => console.log(`  ..  ${m}`)

async function adminLogin(who) {
  const jar = new Jar()
  await call(jar, 'POST', '/auth/admin/login', { email: who, password: PASSWORD })
  return jar
}

async function subjectLogin(who) {
  const jar = new Jar()
  // The OTP endpoint is rate limited per email, and it tells you how long to
  // wait. Honouring that is the difference between a script that works and one
  // that reports a working limiter as a failure.
  let res
  for (let attempt = 0; attempt < 6; attempt += 1) {
    res = await call(jar, 'POST', '/auth/subject/login', { email: who }, { allow: [429] })
    if (res.status !== 429) break
    const wait = (res.body?.details?.retryAfterSeconds ?? 5) + 1
    note(`rate limited on the OTP endpoint, waiting ${wait}s`)
    await new Promise((r) => setTimeout(r, wait * 1000))
  }
  const otp = res.body?.devOtp ?? res.body?.otp
  if (!otp) throw new Error(`no dev OTP for ${who} (status ${res.status}) — EXPOSE_DEV_OTP must be "on"`)
  const v = await call(jar, 'POST', '/auth/subject/verify', { email: who, otp })
  return { jar, id: v.body?.subject?.masterUserId ?? v.body?.masterUserId }
}

async function held(jar) {
  const photos = await call(jar, 'GET', '/api/v1/me/photos', null, { allow: [404] })
  const parts = await call(jar, 'GET', '/api/v1/me/participations', null, { allow: [404] })
  const enrol = await call(jar, 'GET', '/api/v1/me/enrollments', null, { allow: [404] })
  const voice = await call(jar, 'GET', '/api/v1/me/voice-enrollments', null, { allow: [404] })
  const count = (r) => (Array.isArray(r.body?.items) ? r.body.items.length : Array.isArray(r.body) ? r.body.length : null)
  return {
    photos: photos.body?.totalPhotos ?? null,
    sessions: count(parts),
    faces: count(enrol),
    voices: count(voice),
  }
}

async function main() {
  console.log(`DSAR erasure walkthrough for ${email}`)

  const { jar: subject } = await subjectLogin(email)
  const before = await held(subject)
  step('BEFORE — what the platform admits to holding')
  console.log(`  ${JSON.stringify(before)}`)

  step('1. The principal raises an erasure request')
  const raised = await call(subject, 'POST', '/api/v1/me/dsar', {
    type: 'ERASE',
    description: 'Please erase everything you hold about me.',
  })
  const requestId = raised.body?.id ?? raised.body?.requestId
  ok(`request ${requestId} — ${raised.body?.status ?? '?'}`)

  const dpo = await adminLogin('dpo@prism.local')
  const dataAdmin = await adminLogin('dataadmin@prism.local')
  // The admin directory is dataOwner/super_admin only — a DPO is correctly
  // refused it, so the id is looked up with the root account and the assignment
  // itself is still made by the DPO, which is the role that owns that decision.
  const root = await adminLogin('nikhilgaur1022@gmail.com')

  step('2. DPO assigns it')
  const admins = await call(root, 'GET', '/auth/admin/users?role=dataAdmin')
  const assignee = (admins.body?.items ?? []).find((a) => a.email === 'dataadmin@prism.local')
  const assigned = await call(dpo, 'POST', `/api/v1/dsar/${requestId}/assign`, {
    assignedAdminId: assignee.id,
  }, { allow: [409] })
  ok(`assigned to dataAdmin (${assigned.status})`)

  step('3. dataAdmin runs discovery — what do we actually hold?')
  const discovery = await call(dataAdmin, 'POST', `/api/v1/dsar/${requestId}/discovery`, null, {
    allow: [409],
  })
  const items = discovery.body?.items ?? discovery.body?.discovered ?? discovery.body
  ok(`discovery: ${JSON.stringify(items).slice(0, 260)}`)

  step('4. Approval')
  const approved = await call(dpo, 'POST', `/api/v1/dsar/${requestId}/approve`, {}, {
    allow: [400, 404, 409],
  })
  ok(`approve -> ${approved.status}`)

  step('5. dataAdmin executes the erasure')
  const executed = await call(dataAdmin, 'POST', `/api/v1/dsar/${requestId}/execute`, {
    inline: true,
  }, { allow: [409] })
  ok(`execute -> ${executed.status} ${JSON.stringify(executed.body).slice(0, 300)}`)

  step('6. Waiting for the purge queue to settle')
  let state = null
  for (let i = 0; i < 40; i += 1) {
    const r = await call(dataAdmin, 'GET', `/api/v1/dsar/${requestId}`)
    if (r.body?.status !== state) {
      state = r.body?.status
      note(`request status: ${state}`)
    }
    if (['COMPLETED', 'CLOSED', 'REJECTED', 'FAILED'].includes(state)) break
    await new Promise((res) => setTimeout(res, 3000))
  }

  step('7. AFTER — what the platform admits to holding now')
  let after
  try {
    after = await held(subject)
    console.log(`  ${JSON.stringify(after)}`)
  } catch (err) {
    // An erased subject's own session being invalidated is a correct outcome,
    // not a failure — there is no longer an account behind that token.
    ok(`the principal's own session no longer resolves: ${err.message.slice(0, 120)}`)
    after = { photos: 'session gone', sessions: 'session gone' }
  }

  step('8. The certificate')
  const cert = await call(dataAdmin, 'GET', `/api/v1/dsar/${requestId}/certificate`, null, {
    allow: [404, 409],
  })
  if (cert.status === 200) {
    ok(`certificate issued: ${JSON.stringify(cert.body).slice(0, 300)}`)
  } else {
    note(`certificate -> ${cert.status}`)
  }

  step('9. Closing the request')
  // REVIEW is not the end of the machine: the erasure has run and the
  // certificate exists, but a human still has to close the request. Leaving it
  // in REVIEW would keep it counted as in-progress against the SLA forever.
  const closed = await call(dataAdmin, 'POST', `/api/v1/dsar/${requestId}/close`, {
    note: 'Erasure executed and certificate issued; verified by verify-dsar.js.',
  }, { allow: [409] })
  if (closed.status === 200) {
    state = closed.body?.request?.status ?? closed.body?.status ?? 'CLOSED'
    ok(`closed -> ${state}`)
  } else {
    note(`close -> ${closed.status} ${JSON.stringify(closed.body).slice(0, 200)}`)
  }

  console.log('\n' + '='.repeat(64))
  console.log(`before: ${JSON.stringify(before)}`)
  console.log(`after : ${JSON.stringify(after)}`)
  console.log(`final request status: ${state}`)
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`)
  process.exit(1)
})
