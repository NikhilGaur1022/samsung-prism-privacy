// Does the UI actually work, or does it merely render?
//
// check-viewport.mjs answers a narrow question — is anything wider than the
// viewport — and it answers it well. It cannot tell you that a page threw a
// TypeError on mount, that a fetch came back 500, or that a screen rendered its
// empty state because the request behind it failed. Those all measure as a
// perfectly clean 1280px page.
//
// That gap is not hypothetical. Before this existed, the honest answer to "are
// there errors in the UI" was "the build compiles, the unit tests pass with
// mocked APIs, and nothing overflows" — none of which is the same as "it works".
//
// So this drives the same headless Chrome over the same routes as the same
// roles, and collects the three things that actually indicate breakage:
//
//   1. uncaught exceptions        Runtime.exceptionThrown
//   2. console errors             Runtime.consoleAPICalled, level=error
//   3. failed network requests    Network.responseReceived, status >= 400
//
// Every finding names the role, the route, and the failing request or message,
// so a red line is directly actionable rather than an invitation to go looking.
//
// Requires headless Chrome on :9222 and the portals running:
//   chrome --headless=new --remote-debugging-port=9222
//   node scripts/check-ui-health.mjs
//   node scripts/check-ui-health.mjs --report ui-health.json

const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9222'
const API = process.env.API_BASE_URL ?? 'http://localhost:4000'
const ORIGIN = process.env.ADMIN_ORIGIN ?? 'http://localhost:5180'
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'Prism@2026!'
const SETTLE_MS = Number(process.env.UI_SETTLE_MS ?? 3000)
const WIDTH = Number(process.env.UI_WIDTH ?? 1280)

const args = process.argv.slice(2)
const argValue = (flag) => {
  const i = args.indexOf(flag)
  return i === -1 ? null : args[i + 1]
}

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

// Noise that is not the application failing. Kept deliberately short: a long
// ignore list is how a real error gets filtered out by someone tidying up.
const IGNORE = [
  /favicon\.ico/i,
  /Download the React DevTools/i,
  /\[vite\] connect(ing|ed)/i,
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

// What the page ended up showing. A route that renders its error state is not
// "working" just because it threw no exception doing it.
const INSPECT = `(() => {
  const text = document.body.innerText || ''
  const visible = text.replace(/\\s+/g, ' ').trim()
  return {
    chars: visible.length,
    // The portal's own error and empty surfaces, by the words they actually use.
    saysError: /something went wrong|failed to load|unable to load|try again/i.test(visible),
    stillLoading: /^(loading|loading…|loading\\.\\.\\.)$/i.test(visible),
    head: visible.slice(0, 120),
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
  await c.send('Log.enable')

  // Collected per route; `current` is reassigned as the walk moves on so every
  // event is attributed to the page that produced it.
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
      if (status >= 400 && !ignorable(url)) {
        current.badRequests.push(`${status} ${url.replace(API, '').replace(ORIGIN, '')}`)
      }
    }
  })

  const rows = []
  const unmeasured = []

  await c.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })

  for (const group of GROUPS) {
    let cookies
    try {
      cookies = await login(group.login)
    } catch (err) {
      // Same rule as the viewport gate: a role that cannot sign in is a role
      // whose pages were never checked, and a green run over unchecked pages is
      // worse than no run.
      console.error(`! ${group.role}: ${err.message} — ${group.routes.length} routes NOT checked`)
      unmeasured.push({ role: group.role, routes: group.routes, reason: err.message })
      continue
    }

    await c.send('Network.clearBrowserCookies')
    for (const ck of cookies) await c.send('Network.setCookie', { ...ck, url: API })

    for (const route of group.routes) {
      current = { role: group.role, route, exceptions: [], consoleErrors: [], badRequests: [] }

      await c.send('Page.navigate', { url: ORIGIN + route })
      await sleep(SETTLE_MS)

      const r = await c.send('Runtime.evaluate', { returnByValue: true, expression: INSPECT })
      const view = r.result?.value ?? {}
      current.view = view

      rows.push(current)

      const problems =
        current.exceptions.length + current.consoleErrors.length + current.badRequests.length
      const bad = problems > 0 || view.saysError || view.stillLoading || (view.chars ?? 0) < 40

      const label = !bad
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

      console.log(`${group.role.padEnd(16)} ${route.padEnd(24)} ${label}`)
      for (const e of current.exceptions) console.log(`                 ! ${e}`)
      for (const e of current.consoleErrors) console.log(`                 ! ${e}`)
      for (const e of current.badRequests) console.log(`                 ! ${e}`)

      current.bad = bad
    }
  }

  current = null
  c.close()

  const reportPath = argValue('--report')
  if (reportPath) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(reportPath, JSON.stringify(rows, null, 2))
  }

  const broken = rows.filter((r) => r.bad)

  console.log('')
  console.log(`${rows.length} pages checked as ${GROUPS.length - unmeasured.length} roles`)
  console.log(`  with problems : ${broken.length}`)
  console.log(`  unchecked     : ${unmeasured.reduce((n, u) => n + u.routes.length, 0)}`)

  if (rows.length === 0) {
    console.error('\nNothing was checked — treating that as a failure rather than a pass.')
    process.exit(1)
  }

  if (unmeasured.length) {
    console.error('')
    console.error('ui: RED — routes were never checked, which is not the same as clean')
    for (const u of unmeasured) console.error(`  ${u.role}: ${u.reason}`)
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
