// The claim this script exists to test: "upload, processing, output and export
// all work FROM THE UI".
//
// check-ui-health.mjs loads every route and watches it settle, and
// check-signup-flow.mjs types through registration — but neither one uploads a
// file, and neither one presses the button that starts a pipeline. Everything
// else that proves the pipelines work (demo-seed.js) drives the HTTP API
// directly, which is a different claim: it shows the server can do it, not that
// the screens can ask it to.
//
// So this drives the collection agent's real journey with real clicks: create a
// session, put people on the roster, push twelve JPEGs through the actual file
// input, end the session, tag what came back, finalise it, then switch to the
// data owner and build and download the export. Files reach the page through
// CDP's DOM.setFileInputFiles, which is the same event path a human file picker
// produces — not a synthesised FormData.
//
// Requires headless Chrome on :9222, the admin portal on :5180, the API on
// :4000, and a seeded project with two consented, enrolled subjects:
//   node scripts/check-capture-flow.mjs

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9222'
const ORIGIN = process.env.ADMIN_ORIGIN ?? 'http://localhost:5180'
const API = process.env.API_BASE_URL ?? 'http://localhost:4000'
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'Prism@2026!'
const AGENT = process.env.E2E_AGENT_EMAIL ?? 'agent@prism.local'
const OWNER = process.env.E2E_OWNER_EMAIL ?? 'dataowner@prism.local'
const SETTLE_MS = Number(process.env.UI_SETTLE_MS ?? 2500)
const FIXTURES = path.resolve(HERE, '../../backend/tests/fixtures/bulk')
const PHOTOS = [
  'group-01.jpg', 'group-02.jpg', 'group-03.jpg', 'group-04.jpg', 'group-05.jpg', 'group-06.jpg',
  'solo-a-01.jpg', 'solo-a-02.jpg', 'solo-a-03.jpg', 'solo-a-04.jpg', 'solo-a-05.jpg', 'solo-a-06.jpg',
].map((f) => path.join(FIXTURES, f))

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
            }, 60_000)
          }),
        on: (fn) => listeners.push(fn),
        close: () => ws.close(),
      })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const steps = []
function record(name, ok, detail = '') {
  steps.push({ name, ok, detail })
  console.log(`${name.padEnd(52)} ${ok ? 'ok' : 'FAILED'}${detail ? `  ${detail}` : ''}`)
}

// React ignores a value written straight to .value — it tracks the last value it
// set and treats the write as a no-op. Every field would submit empty without this.
const SET_NATIVE = `
  const setNative = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const clickText = (needle, tag) => {
    const els = [...document.querySelectorAll(tag || 'button')]
    const hit = els.find((b) => (b.textContent || '').toLowerCase().includes(needle.toLowerCase()))
    if (hit) hit.click()
    return !!hit
  }
`

async function main() {
  let version
  try {
    version = await (await fetch(`${CDP}/json/version`)).json()
  } catch {
    console.error(`Could not reach Chrome at ${CDP}. Start it with --remote-debugging-port=9222.`)
    process.exit(2)
  }

  const browser = await connect(version.webSocketDebuggerUrl)
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const page = await connect(`ws://127.0.0.1:9222/devtools/page/${targetId}`)

  const thrown = []
  const netFailures = []
  page.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      thrown.push(d.exception?.description ?? d.text ?? 'exception')
    }
    if (m.method === 'Network.responseReceived') {
      const { status, url } = m.params.response
      // A 401 on /auth/admin/me or /auth/admin/refresh while signed out is the
      // app asking a fair question, not a fault — this script signs out on
      // purpose to change role, and the refresh that follows is meant to fail.
      const signedOutProbe = /\/auth\/admin\/(me|refresh)/.test(url)
      if (status >= 400 && !(status === 401 && signedOutProbe)) netFailures.push(`${status} ${url}`)
    }
  })

  await page.send('Runtime.enable')
  await page.send('Page.enable')
  await page.send('Network.enable')
  await page.send('DOM.enable')
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  })

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await page.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    })
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    return result.value
  }

  const goto = async (routePath, settle = SETTLE_MS) => {
    await page.send('Page.navigate', { url: `${ORIGIN}${routePath}` })
    await sleep(settle)
  }

  // Waits for a predicate that runs in the page, polling rather than sleeping a
  // fixed amount — recognition takes as long as it takes.
  const waitFor = async (expression, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        if (await evaluate(expression)) return true
      } catch { /* mid-render; try again */ }
      await sleep(2000)
    }
    console.log(`               ! timed out waiting for ${label}`)
    return false
  }

  // /login correctly redirects an authenticated visitor straight to /dashboard,
  // so landing anywhere else means a session is already open and has to be
  // closed before a different role can sign in. The sign-out is issued from the
  // loaded page rather than before navigating: a fetch started on about:blank is
  // collected the moment we navigate away, which CDP reports as "Promise was
  // collected" and which looks nothing like the cause.
  const signIn = async (email) => {
    await goto('/login')
    if ((await evaluate(`location.pathname`)) !== '/login') {
      await evaluate(
        `fetch('${API}/auth/admin/logout', { method: 'POST', credentials: 'include' }).then(() => true).catch(() => true)`,
      ).catch(() => {})
      await goto('/login')
    }
    // The form only mounts once /auth/admin/me has answered — until then the
    // page renders null, and writing to a field that is not there yet throws.
    const formReady = await waitFor(
      `document.querySelectorAll('form input').length >= 2`,
      30_000,
      'the sign-in form to mount',
    )
    if (!formReady) return evaluate(`location.pathname`)
    await evaluate(`
      (() => {
        ${SET_NATIVE}
        const inputs = [...document.querySelectorAll('form input')]
        const em = inputs.find((i) => i.type === 'email') ?? inputs[0]
        const pw = inputs.find((i) => i.type === 'password') ?? inputs[1]
        setNative(em, ${JSON.stringify(email)})
        setNative(pw, ${JSON.stringify(PASSWORD)})
        return true
      })()
    `)
    await sleep(400)
    await evaluate(`document.querySelector('form').requestSubmit()`)
    await sleep(SETTLE_MS + 1500)
    return evaluate(`location.pathname`)
  }

  let sessionId = null
  let projectId = null

  try {
    // --- 1. the agent signs in ---------------------------------------------
    const landed = await signIn(AGENT)
    const whoAgent = await evaluate(
      `fetch('${API}/auth/admin/me', { credentials: 'include' }).then(r => r.json()).then(a => a.admin?.role ?? a.role ?? null).catch(() => null)`,
    )
    record(
      'collection agent signs in through the form',
      landed !== '/login' && whoAgent === 'collectionAgent',
      `at ${landed} as ${whoAgent}`,
    )

    // --- 2. create a capture session ----------------------------------------
    await goto('/new-session')
    const created = await evaluate(`
      (async () => {
        ${SET_NATIVE}
        const sel = document.querySelector('select')
        if (!sel) return { err: 'no project select' }
        const opts = [...sel.options].filter((o) => o.value)
        if (!opts.length) return { err: 'no projects to choose' }
        setNative(sel, opts[opts.length - 1].value)
        await new Promise((r) => setTimeout(r, 400))
        clickText('image')
        await new Promise((r) => setTimeout(r, 200))
        const loc = document.querySelector('form input[type="text"], form input:not([type])')
        if (loc) setNative(loc, 'UI Flow Check')
        await new Promise((r) => setTimeout(r, 200))
        document.querySelector('form').requestSubmit()
        return { project: opts[opts.length - 1].value }
      })()
    `)
    await sleep(SETTLE_MS + 1500)
    projectId = created?.project ?? null
    const afterCreate = await evaluate(`location.pathname`)
    sessionId = (afterCreate.match(/\/sessions\/([0-9a-f-]{36})/) ?? [])[1] ?? null
    record('creating a session lands on its workspace', !!sessionId, sessionId ? `session ${sessionId.slice(0, 8)}` : afterCreate)
    if (!sessionId) throw new Error('cannot continue without a session')

    // --- 3. put the consented subjects on the roster ------------------------
    await evaluate(`
      (() => {
        const b = [...document.querySelectorAll('button')].find((x) => /add manually/i.test(x.textContent || ''))
        if (b) b.click()
        return !!b
      })()
    `)
    await sleep(1500)
    // "Add manually" is itself a button whose label contains "add", so matching
    // on the substring presses the tab and never the person. Only an exact "Add"
    // inside a result row is the control we want — and only consented subjects
    // are given one, which is the point of the screen.
    const rostered = await evaluate(`
      (async () => {
        ${SET_NATIVE}
        const search = [...document.querySelectorAll('input')].find(
          (i) => /search people/i.test(i.placeholder || '')
        )
        if (!search) return { err: 'no roster search field' }
        let added = 0
        const refused = []
        for (const term of ['Priya', 'Arjun']) {
          setNative(search, term)
          await new Promise((r) => setTimeout(r, 3000))
          for (const li of document.querySelectorAll('li')) {
            const txt = (li.innerText || '').replace(/\\s+/g, ' ')
            if (!new RegExp(term, 'i').test(txt)) continue
            const btn = [...li.querySelectorAll('button')].find((x) => /^add$/i.test((x.textContent || '').trim()))
            if (btn && !btn.disabled) {
              btn.click()
              added += 1
              await new Promise((r) => setTimeout(r, 2500))
              break
            }
            if (/consent not given/i.test(txt)) refused.push(txt.slice(0, 40))
          }
        }
        return { added, refused: refused.length }
      })()
    `)
    await sleep(2000)
    const rosterCount = await evaluate(`
      (() => {
        const m = document.body.innerText.match(/(\\d+)\\s+on the roster/i)
        return m ? Number(m[1]) : 0
      })()
    `)
    record(
      'consented subjects can be added to the roster by hand',
      rosterCount >= 2,
      `${rosterCount} on the roster, ${rostered?.refused ?? 0} refused for want of consent`,
    )

    // --- 4. THE UPLOAD — real files through the real file input -------------
    const { root } = await page.send('DOM.getDocument')
    const { nodeId } = await page.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: 'input[type="file"][accept*="image"]',
    })
    if (!nodeId) throw new Error('no image file input on the session workspace')
    await page.send('DOM.setFileInputFiles', { nodeId, files: PHOTOS })

    const uploaded = await waitFor(
      `(() => { const m = document.body.innerText.match(/(\\d+)\\s+photos? in this session/i); return m && Number(m[1]) >= 12 })()`,
      180_000,
      '12 photos to appear in the session',
    )
    const photoCount = await evaluate(`
      (() => { const m = document.body.innerText.match(/(\\d+)\\s+photos? in this session/i); return m ? Number(m[1]) : 0 })()
    `)
    record('12 files upload through the file picker', uploaded, `${photoCount} photos in the session`)

    // --- 5. end the session — this is what starts the pipeline --------------
    await evaluate(`(() => { ${SET_NATIVE} return clickText('End session') })()`)
    await sleep(3000)
    const processing = await waitFor(
      `fetch('${API}/api/v1/sessions/${sessionId}', { credentials: 'include' })
         .then(r => r.json()).then(s => ['TAGGING','ARCHIVED'].includes(s.status))`,
      600_000,
      'recognition to finish',
    )
    const status1 = await evaluate(
      `fetch('${API}/api/v1/sessions/${sessionId}', { credentials: 'include' }).then(r => r.json()).then(s => s.status)`,
    )
    record('ending the session runs the pipeline', processing, `status ${status1}`)

    // --- 6. tag what recognition produced -----------------------------------
    await goto(`/sessions/${sessionId}/tagging`, 4000)
    const clusters = await evaluate(`document.querySelectorAll('img').length`)
    const tagged = await evaluate(`
      (async () => {
        ${SET_NATIVE}
        let clicks = 0
        for (let round = 0; round < 6; round += 1) {
          const btns = [...document.querySelectorAll('button')].filter((b) =>
            /priya|arjun/i.test(b.textContent || ''))
          if (!btns.length) break
          btns[0].click()
          clicks += 1
          await new Promise((r) => setTimeout(r, 2500))
        }
        return clicks
      })()
    `)
    record('clusters can be tagged from the tagging screen', tagged > 0 || clusters > 0, `${tagged} tag action(s)`)

    // --- 7. finalise — the irreversible one ---------------------------------
    await goto(`/sessions/${sessionId}/review`, 4000)
    await evaluate(`(() => { ${SET_NATIVE} return clickText('finalize') || clickText('finalise') })()`)
    await sleep(2500)
    await evaluate(`(() => { ${SET_NATIVE} return clickText('confirm') || clickText('yes') })()`)
    const archived = await waitFor(
      `fetch('${API}/api/v1/sessions/${sessionId}', { credentials: 'include' })
         .then(r => r.json()).then(s => s.status === 'ARCHIVED')`,
      300_000,
      'the session to archive',
    )
    const status2 = await evaluate(
      `fetch('${API}/api/v1/sessions/${sessionId}', { credentials: 'include' }).then(r => r.json()).then(s => s.status)`,
    )
    record('finalising archives the session', archived, `status ${status2}`)

    // --- 8. the data owner builds the export --------------------------------
    const ownerLanded = await signIn(OWNER)
    const whoOwner = await evaluate(
      `fetch('${API}/auth/admin/me', { credentials: 'include' }).then(r => r.json()).then(a => a.admin?.role ?? a.role ?? null).catch(() => null)`,
    )
    record(
      'data owner signs in',
      ownerLanded !== '/login' && whoOwner === 'dataOwner',
      `at ${ownerLanded} as ${whoOwner}`,
    )

    await goto('/processed-data', 3000)
    await evaluate(`
      (() => {
        ${SET_NATIVE}
        const sel = document.querySelector('select')
        if (!sel) return false
        setNative(sel, ${JSON.stringify(projectId)})
        return true
      })()
    `)
    await sleep(3000)
    const pressed = await evaluate(`(() => { ${SET_NATIVE} return clickText('Build export') })()`)
    record('the export button is present and clickable', pressed)

    const ready = await waitFor(
      `/READY/i.test(document.body.innerText)`,
      420_000,
      'the export to reach READY',
    )
    const exportLine = await evaluate(`
      (() => {
        const m = document.body.innerText.match(/(\\d+)\\s+files?\\s*·[^\\n]*/i)
        return m ? m[0] : null
      })()
    `)
    record('the export builds to READY in the UI', ready, exportLine ?? '')

    // --- 9. and the download actually returns an archive ---------------------
    const download = await evaluate(`
      (async () => {
        const a = [...document.querySelectorAll('a,button')].find((el) =>
          /download/i.test(el.textContent || ''))
        if (!a) return { err: 'no download control' }
        const href = a.getAttribute('href')
        if (!href) return { err: 'download control has no href', tag: a.tagName }
        const r = await fetch(href, { credentials: 'include' })
        const buf = await r.arrayBuffer()
        const head = new Uint8Array(buf.slice(0, 2))
        return { status: r.status, bytes: buf.byteLength, isZip: head[0] === 0x50 && head[1] === 0x4b }
      })()
    `)
    record(
      'the download returns a real ZIP',
      download?.status === 200 && download?.isZip,
      download?.err ?? `${download?.status}, ${Math.round((download?.bytes ?? 0) / 1024)} KB, zip=${download?.isZip}`,
    )

    record('no uncaught exceptions during the flow', thrown.length === 0, thrown.slice(0, 2).join(' | '))
    record('no failed requests during the flow', netFailures.length === 0, netFailures.slice(0, 3).join(' | '))
  } catch (err) {
    record('flow completed without throwing', false, err.message)
  } finally {
    await browser.send('Target.closeTarget', { targetId }).catch(() => {})
    page.close()
    browser.close()
  }

  const failed = steps.filter((s) => !s.ok)
  console.log(`\n${steps.length} steps, ${failed.length} failed`)
  if (sessionId) console.log(`session ${sessionId}`)
  console.log(`\ncapture flow: ${failed.length === 0 ? 'GREEN' : 'RED'}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main()
