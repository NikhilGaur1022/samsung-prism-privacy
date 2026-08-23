// The user portal had no automated UI coverage of any kind.
//
// The admin portal has an overflow sweep and now a health sweep. This side had
// neither — twelve of its pages had, on the record, never been opened by anyone.
// A data subject's portal is where the rights under DPDP §11–§13 are actually
// exercised, so "we never looked" is a worse answer here than it is anywhere
// else in the product.
//
// Same three signals as the admin checker: uncaught exceptions, console errors,
// and failed network requests, attributed per route.
//
// Logging in is deliberately done through the REAL flow rather than by minting a
// token. A subject signs in with a one-time code, and this reads that code from
// the same place the portal itself now shows it: the login response, under
// EXPOSE_DEV_OTP. It falls back to the server log for a server started without
// that flag. Minting a token directly would be more robust and would skip the
// one part of the journey every single subject has to get through.
//
// Requires headless Chrome on :9222, both portals running, and the API writing
// to .run/logs/api.out.log:
//   node scripts/check-ui-health.mjs
//   node scripts/check-ui-health.mjs --email someone@example.com

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9222'
const API = process.env.API_BASE_URL ?? 'http://localhost:4000'
const ORIGIN = process.env.USER_ORIGIN ?? 'http://localhost:5173'
const LOG = process.env.API_LOG ?? path.resolve(HERE, '../../.run/logs/api.out.log')
const SETTLE_MS = Number(process.env.UI_SETTLE_MS ?? 3000)
const WIDTH = Number(process.env.UI_WIDTH ?? 1280)

const args = process.argv.slice(2)
const argValue = (flag) => {
  const i = args.indexOf(flag)
  return i === -1 ? null : args[i + 1]
}

const EMAIL = argValue('--email') ?? process.env.E2E_SUBJECT_EMAIL ?? 'nikhilgaur1022@gmail.com'

// Every authenticated route in user-portal/src/App.jsx. `/enroll` is included
// because it was a dead end until recently — a permanent spinner with no way
// out — and that is exactly the shape this checker is built to catch.
const ROUTES = [
  '/dashboard',
  '/projects',
  '/consent',
  '/rights',
  '/profile',
  '/my-data',
  '/consents',
  '/requests/new',
  '/requests',
  '/inbox',
  '/enroll',
]

// Unauthenticated routes, checked before signing in.
const PUBLIC_ROUTES = ['/login', '/register']

const IGNORE = [
  /favicon\.ico/i,
  /Download the React DevTools/i,
  /\[vite\] connect(ing|ed)/i,
  // The portal probes the session on load; a 401 before sign-in is the app
  // working, not failing.
  /401 \/auth\/subject\/me/i,
]

const ignorable = (text) => IGNORE.some((re) => re.test(String(text ?? '')))

let msgId = 0

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const pending = new Map()
    const listeners = []

    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id)
        pending.delete(m.id)
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
        return
      }
      if (m.method) for (const fn of listeners) fn(m)
    }
    ws.onerror = (e) => reject(new Error(`ws error ${e.message ?? ''}`))
    ws.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const id = ++msgId
            pending.set(id, { res, rej })
            ws.send(JSON.stringify({ id, method, params }))
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id)
                rej(new Error(`CDP timeout: ${method}`))
              }
            }, 45_000)
          }),
        on: (fn) => listeners.push(fn),
        close: () => ws.close(),
      })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * The last one-time code the server logged for this address.
 *
 * Reads from the end of the log, because a subject who has signed in before has
 * older codes in there and the newest is the only valid one.
 */
function latestOtpFor(email, since) {
  let text
  try {
    text = readFileSync(LOG, 'utf8')
  } catch {
    throw new Error(`cannot read the API log at ${LOG} — is the API writing there?`)
  }

  // Strip the pretty-printer's ANSI colouring before matching.
  const plain = text.replace(/\[[0-9;]*m/g, '')
  const lines = plain.split('\n')

  let found = null
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes(email)) continue
    // The code sits on a nearby line as `code: "123456"` or `otp: "123456"`.
    for (let j = i - 3; j <= i + 3; j += 1) {
      const m = lines[j]?.match(/(?:code|otp):\s*"(\d{6})"/)
      if (m) found = m[1]
    }
  }

  if (!found) {
    throw new Error(
      `no one-time code for ${email} in the log. The dev-only log line is emitted at ` +
        'debug level and only outside production — check NODE_ENV and the log level.',
    )
  }
  return found
}

async function signIn(email) {
  const started = Date.now()

  const req = await fetch(`${API}/auth/subject/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  if (!req.ok) throw new Error(`login request for ${email} -> ${req.status}`)

  // Prefer the code the API hands back in the response, which is what the portal
  // itself now shows on screen — checking the same source the user reads means a
  // break in that path fails this check instead of passing on a log line no one
  // looks at. Falls back to the log for a server started without EXPOSE_DEV_OTP.
  let otp = (await req.clone().json().catch(() => ({})))?.devOtp
  if (!otp) {
    // The log write is not synchronous with the response.
    await sleep(1200)
    otp = latestOtpFor(email, started)
  }

  const res = await fetch(`${API}/auth/subject/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, otp }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`verify for ${email} -> ${res.status} ${body.slice(0, 120)}`)
  }

  const raw = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')]
  return raw.filter(Boolean).map((line) => {
    const [pair, ...attrs] = line.split(';').map((s) => s.trim())
    const eq = pair.indexOf('=')
    const p = (attrs.find((a) => a.toLowerCase().startsWith('path=')) ?? 'path=/').slice(5)
    return {
      name: pair.slice(0, eq),
      value: pair.slice(eq + 1),
      domain: 'localhost',
      path: p,
      httpOnly: true,
    }
  })
}

const INSPECT = `(() => {
  const text = document.body.innerText || ''
  const visible = text.replace(/\\s+/g, ' ').trim()
  return {
    chars: visible.length,
    saysError: /something went wrong|failed to load|unable to load|couldn't load/i.test(visible),
    stillLoading: /^(loading|loading…|loading\\.\\.\\.)$/i.test(visible),
    head: visible.slice(0, 140),
  }
})()`

async function main() {
  let targets
  try {
    targets = await (await fetch(`${CDP}/json/list`)).json()
  } catch (err) {
    console.error(`Could not reach Chrome at ${CDP}. Start it with --remote-debugging-port=9222.`)
    console.error(err.message)
    process.exit(1)
  }

  const page = targets.find((t) => t.type === 'page')
  if (!page) {
    console.error('No page target in Chrome.')
    process.exit(1)
  }

  const c = await connect(page.webSocketDebuggerUrl)
  await c.send('Page.enable')
  await c.send('Runtime.enable')
  await c.send('Network.enable')

  let current = null

  c.on((m) => {
    if (!current) return
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      const text = d.exception?.description ?? d.text ?? 'unknown exception'
      if (!ignorable(text)) current.exceptions.push(String(text).split('\n')[0])
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const text = (m.params.args ?? [])
        .map((a) => a.value ?? a.description ?? '')
        .join(' ')
        .trim()
      if (text && !ignorable(text)) current.consoleErrors.push(text.slice(0, 300))
    }
    if (m.method === 'Network.responseReceived') {
      const { status, url } = m.params.response
      const short = `${status} ${url.replace(API, '').replace(ORIGIN, '')}`
      if (status >= 400 && !ignorable(short) && !ignorable(url)) current.badRequests.push(short)
    }
  })

  await c.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })

  const rows = []

  const walk = async (routes, label) => {
    for (const route of routes) {
      current = { route, label, exceptions: [], consoleErrors: [], badRequests: [] }
      await c.send('Page.navigate', { url: ORIGIN + route })
      await sleep(SETTLE_MS)

      const r = await c.send('Runtime.evaluate', { returnByValue: true, expression: INSPECT })
      const view = r.result?.value ?? {}
      current.view = view

      const problems =
        current.exceptions.length + current.consoleErrors.length + current.badRequests.length
      const bad = problems > 0 || view.saysError || view.stillLoading || (view.chars ?? 0) < 40
      current.bad = bad
      rows.push(current)

      const status = !bad
        ? 'ok'
        : [
            current.exceptions.length ? `${current.exceptions.length} exception(s)` : null,
            current.consoleErrors.length ? `${current.consoleErrors.length} console error(s)` : null,
            current.badRequests.length ? `${current.badRequests.length} failed request(s)` : null,
            view.saysError ? 'error state' : null,
            view.stillLoading ? 'stuck loading' : null,
            (view.chars ?? 0) < 40 ? 'near-empty' : null,
          ]
            .filter(Boolean)
            .join(' · ')

      console.log(`${label.padEnd(14)} ${route.padEnd(16)} ${status}`)
      for (const e of [...current.exceptions, ...current.consoleErrors, ...current.badRequests]) {
        console.log(`               ! ${e}`)
      }
    }
  }

  await c.send('Network.clearBrowserCookies')
  await walk(PUBLIC_ROUTES, 'signed-out')

  let cookies
  try {
    cookies = await signIn(EMAIL)
  } catch (err) {
    current = null
    c.close()
    console.error('')
    console.error(`ui: RED — could not sign in as ${EMAIL}`)
    console.error(`  ${err.message}`)
    console.error(`  ${ROUTES.length} authenticated routes NOT checked`)
    process.exit(1)
  }

  for (const ck of cookies) await c.send('Network.setCookie', { ...ck, url: API })
  await walk(ROUTES, 'signed-in')

  current = null
  c.close()

  const reportPath = argValue('--report')
  if (reportPath) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(reportPath, JSON.stringify(rows, null, 2))
  }

  const broken = rows.filter((r) => r.bad)

  console.log('')
  console.log(`${rows.length} pages checked (${PUBLIC_ROUTES.length} signed out, ${ROUTES.length} signed in)`)
  console.log(`  with problems : ${broken.length}`)

  if (rows.length === 0) {
    console.error('\nNothing was checked — treating that as a failure rather than a pass.')
    process.exit(1)
  }

  console.log('')
  console.log(`ui: ${broken.length === 0 ? 'GREEN' : 'RED'}`)
  process.exit(broken.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FATAL', err)
  process.exit(1)
})
