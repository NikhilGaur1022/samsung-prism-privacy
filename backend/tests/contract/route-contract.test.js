import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApp, listRoutes } from '../../src/app.js'

// The layer that was missing, and the reason F-01 shipped.
//
// POST /api/v1/subjects returned 500 for an authenticated agent because four
// handlers read `req.user.id` while the middleware sets `req.admin`. No test
// caught it: rbac-matrix.test.js asserts status CLASSES, and a 500 is neither
// 401 nor 403, so a completely dead route passed the only suite that touched it.
//
// Three checks here, each closing a different way a route can be broken while
// every existing test stays green:
//
//   1. No handler reads a request property no middleware sets.
//   2. Every function the portals call resolves to a mounted method+path.
//   3. Every mounted route is reachable — no duplicate registrations shadowing
//      each other, no route whose path is unmatchable.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../..')
const SRC = path.resolve(HERE, '../../src')

async function* walk(dir, ext = '.js') {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full, ext)
    else if (entry.name.endsWith(ext)) yield full
  }
}

// ---------------------------------------------------------------------------

test('no handler reads a request property that no middleware sets', async () => {
  // What the middleware actually attaches. Anything else read off `req` as an
  // identity is a typo that becomes a 500 on a live route.
  const ATTACHED = new Set([
    'admin', // requireAdminAuth
    'subject', // requireSubjectAuth
    'breakGlass', // requireBreakGlass
    'correlationId', // requestLogger
    'log', // pino-http
    // Express's own.
    'params', 'query', 'body', 'headers', 'cookies', 'ip', 'ips', 'method', 'path',
    'url', 'originalUrl', 'baseUrl', 'protocol', 'secure', 'hostname', 'socket',
    'file', 'files', 'get', 'header', 'accepts', 'is', 'route', 'app', 'res', 'next',
    'signedCookies', 'xhr', 'subdomains', 'stale', 'fresh', 'rawHeaders', 'aborted',
    'complete', 'httpVersion', 'connection', 'on', 'once', 'pipe', 'destroy', 'rateLimit',
  ])

  const offenders = []

  for await (const file of walk(SRC)) {
    const code = await readFile(file, 'utf8')
    const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

    for (const match of stripped.matchAll(/\breq\??\.([A-Za-z_$][\w$]*)/g)) {
      if (!ATTACHED.has(match[1])) {
        const line = stripped.slice(0, match.index).split('\n').length
        offenders.push(`${path.relative(SRC, file)}:${line} — req.${match[1]}`)
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'These handlers read a request property nothing sets. Every one of them is a\n' +
      'TypeError at request time, rendered to the operator as a 500:\n\n' +
      offenders.join('\n'),
  )
})

// ---------------------------------------------------------------------------

test('every portal API call resolves to a mounted route', async () => {
  const app = createApp()
  const mounted = listRoutes(app)

  // A mounted path with :params turned into a matcher, so a client call with a
  // concrete id still resolves.
  const matchers = mounted.map((r) => ({
    method: r.method,
    path: r.path,
    re: new RegExp(`^${r.path.replace(/:[A-Za-z_$][\w$]*/g, '[^/]+').replace(/\//g, '\\/')}$`),
  }))

  const missing = []

  for (const portal of ['admin-portal', 'user-portal']) {
    const apiFile = path.join(REPO, portal, 'src', 'lib', 'api.js')
    let code
    try {
      code = await readFile(apiFile, 'utf8')
    } catch {
      continue
    }

    // request('/api/v1/...', { method: 'POST' }) — including the nested-template
    // form the portals use for optional query strings:
    //
    //   request(`/api/v1/audit${query ? `?${query}` : ''}`)
    //
    // The inner backtick means a naive [^`]+ capture stops half-way through, so
    // the capture deliberately allows nesting one level and the path is
    // normalised below rather than trusted as written.
    const calls = [
      ...code.matchAll(
        /request\(\s*(?:`((?:[^`$]|\$(?!\{)|\$\{(?:[^{}`]|`[^`]*`)*\})*)`|'([^']*)'|"([^"]*)")\s*(?:,\s*\{([^}]*)\})?/g,
      ),
    ]

    for (const call of calls) {
      const rawPath = call[1] ?? call[2] ?? call[3]
      const opts = call[4] ?? ''
      const method = (/method:\s*'([A-Z]+)'/.exec(opts)?.[1] ?? 'GET').toUpperCase()
      if (!rawPath?.startsWith('/')) continue

      // A path id placeholder becomes a wildcard segment; everything from the
      // start of a query string — literal or interpolated — is dropped, since
      // the router does not match on it.
      const clean = normalisePath(rawPath)
      if (!clean) continue

      const hit = matchers.some((m) => m.method === method && m.re.test(clean))
      if (!hit) missing.push(`${portal}: ${method} ${clean}`)
    }
  }

  assert.deepEqual(
    missing,
    [],
    'These portal calls do not resolve to any mounted route. Each is a 404 the\n' +
      'user sees as a broken page:\n\n' + missing.join('\n'),
  )
})

/**
 * A client-side path as the ROUTER would see it.
 *
 * Interpolations are either a path id (becomes a wildcard) or the start of a
 * query string (everything after is dropped). The two are told apart by
 * position: anything at or after the first '?' — whether the '?' is literal or
 * inside an interpolation — is query.
 */
function normalisePath(raw) {
  const queryStart = raw.indexOf('?')
  const pathPart = queryStart === -1 ? raw : raw.slice(0, queryStart)

  // A conditional query suffix, `${query ? ...}`, has its '?' INSIDE the
  // interpolation, so cutting at '?' leaves a dangling '${query'. Cut at the
  // interpolation opener too and take whichever came first.
  const interpStart = pathPart.indexOf('${')
  const cut = interpStart === -1 ? pathPart : pathPart.slice(0, interpStart)

  // Only trailing interpolations are query strings. An interpolation in the
  // MIDDLE of a path is an id, and dropping the rest of the path would make this
  // check vacuous — so those are substituted rather than truncated.
  const substituted = pathPart.replace(/\$\{[^{}]*\}/g, 'X')
  const candidate = substituted.includes('${') ? cut : substituted

  const trimmed = candidate.replace(/\/+$/, '') || '/'
  return trimmed.startsWith('/') ? trimmed : null
}

// ---------------------------------------------------------------------------

test('no two routes register the same method and path', () => {
  const app = createApp()
  const seen = new Map()
  const duplicates = []

  for (const { method, path: p } of listRoutes(app)) {
    const key = `${method} ${p}`
    if (seen.has(key)) duplicates.push(key)
    seen.set(key, true)
  }

  // A duplicate is not always a bug — several routers are deliberately mounted
  // on /api/v1/sessions so a narrower guard runs before a wider one. What is a
  // bug is the same METHOD and the same PATH twice, because only the first can
  // ever run and the second is dead code that looks live.
  assert.deepEqual(duplicates, [], `duplicate route registrations:\n  ${duplicates.join('\n  ')}`)
})

test('every mounted route has a recognisable path', () => {
  const app = createApp()
  const malformed = listRoutes(app).filter(
    (r) => !r.path.startsWith('/') || r.path.includes('//') || /\s/.test(r.path),
  )
  assert.deepEqual(malformed, [], 'routes with malformed paths')
})


// createApp() pulls in middleware/rateLimiter.js, which imports config/redis.js
// at module scope and dials Redis immediately with maxRetriesPerRequest: null —
// so the connection reconnects forever and the runner sits on an open handle
// after the last assertion. Nothing in this file writes, so tearing both down
// is safe and is what lets the suite exit.
test('teardown', async () => {
  const { prisma } = await import('../../src/config/prisma.js')
  const { redis } = await import('../../src/config/redis.js')
  await prisma.$disconnect().catch(() => {})
  await redis.quit().catch(() => {})
})
