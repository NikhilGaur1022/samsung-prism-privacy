// The CI assertion behind the declared viewport floor.
//
// Phones are out of scope for the admin console. That decision is only worth
// anything if there is a number attached to it and something defending the
// number — otherwise "desktop only" quietly becomes "whatever the last
// developer's monitor was". So:
//
//   1024 px   supported minimum, asserted here, zero horizontal overflow
//   1280 px   design target, also asserted
//   below     UnsupportedViewport says so; not a layout we defend
//
// The measurement is the one from the audit: drive headless Chrome over the
// DevTools Protocol, render each authenticated route at each width, and read
// document.documentElement.scrollWidth against the viewport. At 390 px that
// measurement found 25 of 39 route×role combinations overflowing, /dsar/:id
// worst at scrollWidth 1316 — 3.4x the screen, content clipped mid-word.
//
// Usage:
//   node scripts/check-viewport.mjs                     # 1024 and 1280
//   node scripts/check-viewport.mjs --width 820         # one width
//   node scripts/check-viewport.mjs --report out.json
//
// Requires a Chrome with --remote-debugging-port=9222 and the portals running.
// Exits non-zero on any overflow, so it is wired into CI as a gate.

import { writeFileSync } from 'node:fs'

const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9222'
const API = process.env.API_BASE_URL ?? 'http://localhost:4000'
const ORIGIN = process.env.ADMIN_ORIGIN ?? 'http://localhost:5180'
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'Prism@2026!'

const args = process.argv.slice(2)
const argValue = (flag) => {
  const i = args.indexOf(flag)
  return i === -1 ? null : args[i + 1]
}

/** The supported floor and the design target. Both must be clean. */
const DEFAULT_WIDTHS = [1024, 1280]
const WIDTHS = argValue('--width') ? [Number(argValue('--width'))] : DEFAULT_WIDTHS
const REPORT_PATH = argValue('--report')
const SETTLE_MS = Number(process.env.VIEWPORT_SETTLE_MS ?? 2600)

// One representative login per role, and the routes that role can actually
// reach. A route rendered by a role that 403s it measures the refusal screen,
// not the page.
const GROUPS = [
  {
    role: 'dpo',
    login: process.env.E2E_DPO_EMAIL ?? 'dpo@prism.local',
    routes: ['/dashboard', '/project-approvals', '/consent-templates', '/sla-monitoring', '/compliance-reports', '/audit-logs', '/queue-health'],
  },
  {
    role: 'dataOwner',
    login: process.env.E2E_OWNER_EMAIL ?? 'dataowner@prism.local',
    routes: ['/dashboard', '/my-projects', '/create-project', '/assignments', '/processed-data', '/project-reports', '/audit-logs'],
  },
  {
    role: 'collectionAgent',
    login: process.env.E2E_AGENT_EMAIL ?? 'agent@prism.local',
    routes: ['/dashboard', '/sessions', '/new-session', '/subject-verification', '/consent-check'],
  },
  {
    role: 'dataAdmin',
    login: process.env.E2E_DATAADMIN_EMAIL ?? 'dataadmin@prism.local',
    routes: ['/dashboard', '/dsar-queue', '/import', '/collection-sessions', '/discovery-workspace', '/data-lineage', '/evidence-vault', '/queue-health'],
  },
]

let msgId = 0

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const pending = new Map()
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id)
        pending.delete(m.id)
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
      }
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
        close: () => ws.close(),
      })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function login(email) {
  const res = await fetch(`${API}/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  if (!res.ok) throw new Error(`login ${email} -> ${res.status}`)

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

// Reads the overflow, and — when there is one — the chain of elements that
// caused it. A bare "this route overflows" sends someone hunting; naming
// `div.shrink-0` inside `div.flex items-start justify-between` is what turned
// six broken routes into one component fix.
const MEASURE = `(() => {
  const d = document.documentElement
  const vw = window.innerWidth
  const culprits = []
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.right > vw + 2) {
      const cls = typeof el.className === 'string' && el.className
        ? '.' + el.className.split(/\\s+/).slice(0, 4).join('.')
        : ''
      culprits.push(el.tagName.toLowerCase() + cls + ' right=' + Math.round(r.right))
      if (culprits.length > 6) break
    }
  }
  return {
    scrollWidth: d.scrollWidth,
    clientWidth: d.clientWidth,
    overflow: Math.max(0, d.scrollWidth - d.clientWidth),
    culprits,
    // A route that rendered nothing cannot overflow, and would pass this check
    // vacuously. Reported so a blank page is a failure rather than a pass.
    empty: !document.querySelector('#root')?.firstElementChild,
    unsupportedNoticeVisible: Boolean(
      [...document.querySelectorAll('[role=alert]')].some((n) =>
        (n.innerText || '').includes('wider screen'),
      ),
    ),
  }
})()`

async function main() {
  let page
  try {
    const targets = await (await fetch(`${CDP}/json/list`)).json()
    page = targets.find((t) => t.type === 'page')
  } catch (err) {
    console.error(
      `Could not reach Chrome at ${CDP}. Start it with --remote-debugging-port=9222.\n${err.message}`,
    )
    process.exit(2)
  }
  if (!page) {
    console.error('No page target in Chrome.')
    process.exit(2)
  }

  const c = await connect(page.webSocketDebuggerUrl)
  await c.send('Page.enable')
  await c.send('Runtime.enable')
  await c.send('Network.enable')

  const rows = []
  const unmeasured = []

  for (const group of GROUPS) {
    let cookies
    try {
      cookies = await login(group.login)
    } catch (err) {
      // Not a skip. A role that cannot sign in is a role whose routes were never
      // measured, and a run that prints GREEN over seven unmeasured pages is
      // worse than no gate at all — that is exactly how `owner@prism.local`, an
      // address that does not exist, went unnoticed while /processed-data was
      // silently excluded from every check.
      console.error(`! ${group.role}: ${err.message} — ${group.routes.length} routes NOT measured`)
      unmeasured.push({ role: group.role, routes: group.routes, reason: err.message })
      continue
    }

    await c.send('Network.clearBrowserCookies')
    for (const ck of cookies) await c.send('Network.setCookie', { ...ck, url: API })

    for (const route of group.routes) {
      for (const width of WIDTHS) {
        await c.send('Emulation.setDeviceMetricsOverride', {
          width,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        })
        await c.send('Page.navigate', { url: ORIGIN + route })
        await sleep(SETTLE_MS)

        const r = await c.send('Runtime.evaluate', { returnByValue: true, expression: MEASURE })
        const m = r.result?.value ?? {}
        rows.push({ role: group.role, route, width, ...m })

        const status = m.empty ? 'EMPTY' : m.overflow > 0 ? `OVERFLOW +${m.overflow}` : 'ok'
        console.log(`${String(width).padStart(5)}px  ${group.role.padEnd(16)} ${route.padEnd(24)} ${status}`)
        if (m.overflow > 0 && m.culprits?.length) {
          for (const culprit of m.culprits) console.log(`             ${culprit}`)
        }
      }
    }
  }

  c.close()

  if (REPORT_PATH) writeFileSync(REPORT_PATH, JSON.stringify(rows, null, 2))

  const overflowing = rows.filter((r) => r.overflow > 0)
  const blank = rows.filter((r) => r.empty)

  console.log(`\n${rows.length} route x width measurements`)
  console.log(`  overflowing : ${overflowing.length}`)
  console.log(`  blank       : ${blank.length}`)
  console.log(`  unmeasured  : ${unmeasured.reduce((n, u) => n + u.routes.length * WIDTHS.length, 0)}`)

  if (rows.length === 0) {
    console.error('\nNo measurements were taken — treating that as a failure rather than a pass.')
    process.exit(1)
  }

  if (unmeasured.length) {
    console.error('')
    console.error('viewport: RED — routes were never measured, which is not the same as clean')
    for (const u of unmeasured) {
      console.error(`  ${u.role}: ${u.reason}`)
      for (const route of u.routes) console.error(`    ${route}`)
    }
    process.exit(1)
  }

  if (overflowing.length || blank.length) {
    console.error(`\nviewport: RED — the supported floor is ${Math.min(...WIDTHS)}px`)
    process.exit(1)
  }

  console.log('\nviewport: GREEN')
  process.exit(0)
}

main().catch((err) => {
  console.error('FATAL', err)
  process.exit(1)
})
