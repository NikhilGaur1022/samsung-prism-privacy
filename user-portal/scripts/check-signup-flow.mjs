// The one journey every subject has to get through, driven as a real person.
//
// check-ui-health.mjs loads pages and watches them settle; it never clicks,
// types or submits. That gap is how the "Create an account" page shipped
// pointing at an admin-only endpoint and answered 401 to every visitor without
// anyone noticing — the page rendered perfectly, so every sweep passed it.
//
// This one fills the form, submits it, reads the one-time code OFF THE SCREEN
// rather than out of the API response, clicks the button that fills it in, and
// checks that a session actually results. Reading the code from the rendered DOM
// is the point: it is the difference between "the server issued a code" and "the
// person can see the code", and only the second one lets someone test by hand.
//
// Each run leaves one real subject behind, at a fresh `@test.invalid` address —
// it has to, because the thing being checked is that a stranger can create an
// account. `backend/npm run clean:test-residue` removes them.
//
// Requires headless Chrome on :9222, the user portal on :5173, the API on :4000,
// and EXPOSE_DEV_OTP=on:
//   node scripts/check-signup-flow.mjs

const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9222'
const ORIGIN = process.env.USER_ORIGIN ?? 'http://localhost:5173'
const SETTLE_MS = Number(process.env.UI_SETTLE_MS ?? 2500)
const WIDTH = Number(process.env.UI_WIDTH ?? 1280)

// Unique per run. Registration is idempotent only in the sense that it 409s, so
// reusing an address would make the second run fail for the wrong reason.
const EMAIL = process.env.SIGNUP_EMAIL ?? `signup-check-${Date.now()}@test.invalid`
const FULL_NAME = 'Signup Flow Check'

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

const problems = []
const steps = []

function record(name, ok, detail = '') {
  steps.push({ name, ok, detail })
  if (!ok) problems.push(`${name}${detail ? ` — ${detail}` : ''}`)
  const mark = ok ? 'ok' : 'FAILED'
  console.log(`${name.padEnd(46)} ${mark}${detail ? `  ${detail}` : ''}`)
}

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

  // Anything the page throws while we are driving it is a failure of this flow,
  // not background noise — we are the only thing touching it.
  const thrown = []
  page.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      thrown.push(d.exception?.description ?? d.text ?? 'exception')
    }
  })

  // Failed requests, attributed. Without this a 401/429 shows only as "the page
  // did not move", which is exactly how the original bug hid.
  const netFailures = []
  page.on((m) => {
    if (m.method === 'Network.responseReceived') {
      const { status, url } = m.params.response
      if (status >= 400) netFailures.push(`${status} ${url}`)
    }
  })

  // Every full-document navigation. A React form that submits natively instead of
  // through its onSubmit handler looks identical to "nothing happened" — the
  // request still fires, the page still says /register — except that it reloads.
  const navigations = []
  const consoleLines = []
  page.on((m) => {
    if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) {
      navigations.push(m.params.frame.url)
    }
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      consoleLines.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    }
  })

  await page.send('Runtime.enable')
  await page.send('Page.enable')
  await page.send('Network.enable')
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await page.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    }
    return result.value
  }

  const goto = async (routePath) => {
    await page.send('Page.navigate', { url: `${ORIGIN}${routePath}` })
    await sleep(SETTLE_MS)
  }

  // React does not see a value written straight to .value — it tracks the last
  // value it set and skips the change event as a no-op. This is the standard way
  // round it, and without it every field submits empty.
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
  `

  try {
    // --- 1. the page loads at all -----------------------------------------
    await goto('/register')
    const onRegister = await evaluate(`
      (() => ({
        url: location.pathname,
        inputs: document.querySelectorAll('input').length,
        hasSubmit: !!document.querySelector('form button[type="submit"], form button:not([type])'),
      }))()
    `)
    record(
      '/register renders a usable form',
      onRegister.url === '/register' && onRegister.inputs >= 2 && onRegister.hasSubmit,
      `${onRegister.inputs} inputs, submit=${onRegister.hasSubmit}`,
    )

    // --- 2. fill it in the way a person would ------------------------------
    await evaluate(`
      (() => {
        ${SET_NATIVE}
        const inputs = [...document.querySelectorAll('input')]
        const byPlaceholder = (frag) =>
          inputs.find((i) => (i.placeholder || '').toLowerCase().includes(frag))
        const name = byPlaceholder('doe') ?? inputs[0]
        const email = inputs.find((i) => i.type === 'email') ?? inputs[1]
        setNative(name, ${JSON.stringify(FULL_NAME)})
        setNative(email, ${JSON.stringify(EMAIL)})
        return true
      })()
    `)

    const canSubmit = await evaluate(`
      (() => {
        const btn = document.querySelector('form button[type="submit"], form button:not([type])')
        return !!btn && !btn.disabled
      })()
    `)
    record('the submit button enables once filled', canSubmit === true)

    // --- 3. submit, and see where it lands ---------------------------------
    // A 401 here is the original bug: the page stays put and shows an error.
    await evaluate(`
      (() => {
        const btn = document.querySelector('form button[type="submit"], form button:not([type])')
        btn.click()
        return true
      })()
    `)
    // Poll rather than sleep a fixed time: the round trip includes issuing a code,
    // and a fixed wait that is a little too short reads as "the page never moved".
    for (let i = 0; i < 20; i += 1) {
      const here = await evaluate('location.pathname')
      if (here !== '/register') break
      await sleep(500)
    }

    const afterSubmit = await evaluate(`
      (() => ({
        url: location.pathname,
        text: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 400),
      }))()
    `)
    record(
      'submitting registration reaches /verify',
      afterSubmit.url === '/verify',
      afterSubmit.url === '/verify' ? '' : `stuck on ${afterSubmit.url}: ${afterSubmit.text.slice(0, 160)}`,
    )

    // --- 4. THE POINT: is the code actually on screen? ----------------------
    // Scraped out of the rendered text, not the API response. A six-digit run
    // that is not part of a longer number is the code; the page shows nothing
    // else of that shape.
    const shown = await evaluate(`
      (() => {
        const text = (document.body.innerText || '')
        const m = text.match(/(?<!\\d)(\\d{6})(?!\\d)/)
        return { code: m ? m[1] : null, text: text.replace(/\\s+/g, ' ').trim().slice(0, 300) }
      })()
    `)
    record(
      'the one-time code is visible on the page',
      /^\d{6}$/.test(shown.code ?? ''),
      shown.code ? `code ${shown.code}` : `no six-digit code in: ${shown.text.slice(0, 160)}`,
    )

    // --- 5. the autofill control works -------------------------------------
    if (shown.code) {
      const filled = await evaluate(`
        (async () => {
          ${SET_NATIVE}
          // Either the control carries the code as its own label, or it is a
          // separate "Autofill" button sitting beside it. Either presentation is
          // fine; what matters is that one click puts the code in the boxes.
          const wanted = ${JSON.stringify(shown.code)}
          const buttons = [...document.querySelectorAll('button')]
          const btn =
            buttons.find((b) => (b.innerText || '').replace(/\\s+/g, '').includes(wanted)) ??
            buttons.find((b) => /autofill|use code|fill/i.test(b.innerText || ''))
          if (btn) {
            btn.click()
            await new Promise((r) => setTimeout(r, 400))
          }
          const boxes = [...document.querySelectorAll('input')].filter((i) => i.type !== 'hidden')
          const joined = boxes.map((i) => i.value).join('')
          return { clicked: !!btn, joined }
        })()
      `)
      record(
        'clicking the code fills the verify boxes',
        filled.clicked && filled.joined.replace(/\D/g, '') === shown.code,
        filled.clicked ? `boxes hold "${filled.joined}"` : 'no clickable element carried the code',
      )

      // --- 6. and it actually signs them in --------------------------------
      await evaluate(`
        (() => {
          const btn = [...document.querySelectorAll('button')].find((b) =>
            /verify|continue|sign in|submit/i.test(b.innerText || ''),
          )
          if (btn && !btn.disabled) btn.click()
          return !!btn
        })()
      `)
      await sleep(SETTLE_MS + 1500)

      const landed = await evaluate(`
        (() => ({
          url: location.pathname,
          text: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
        }))()
      `)
      record(
        'verifying the code produces a signed-in session',
        landed.url !== '/verify' && landed.url !== '/login',
        landed.url === '/verify' ? `still on /verify: ${landed.text.slice(0, 140)}` : `landed on ${landed.url}`,
      )
    }

    record('no uncaught exceptions during the flow', thrown.length === 0, thrown.slice(0, 2).join(' | '))
    record('no failed requests during the flow', netFailures.length === 0, netFailures.slice(0, 3).join(' | '))
    // One navigation is the initial load. More means the form submitted natively
    // and threw the app away mid-flight.
    record(
      'the form does not reload the page',
      navigations.length <= 1,
      navigations.length > 1 ? navigations.join(' -> ') : '',
    )
    if (consoleLines.length) console.log(`  console: ${consoleLines.slice(0, 3).join(' | ')}`)
  } finally {
    page.close()
    await browser.send('Target.closeTarget', { targetId }).catch(() => {})
    browser.close()
  }

  console.log('')
  console.log(`registered as ${EMAIL}`)
  console.log(`${steps.length} steps, ${problems.length} failed`)
  console.log('')
  console.log(problems.length ? `signup: RED\n  ${problems.join('\n  ')}` : 'signup: GREEN')
  process.exit(problems.length ? 1 : 0)
}

main().catch((err) => {
  console.error(`signup: RED — ${err.message}`)
  process.exit(1)
})
