import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { createApp, listRoutes } from '../../src/app.js'
import { prisma } from '../../src/config/prisma.js'
import { redis } from '../../src/config/redis.js'
import { closeFaceQueue } from '../../src/lib/faceQueue.js'
import { closeRedactionQueue } from '../../src/lib/redactionQueue.js'
import { closePurgeQueue } from '../../src/lib/purgeQueue.js'
import { signAdminAccessToken, signSubjectAccessToken } from '../../src/lib/tokens.js'
import { ADMIN_ACCESS_COOKIE, SUBJECT_ACCESS_COOKIE } from '../../src/lib/cookies.js'

// Table-driven enforcement of docs/02_ROLE_PERMISSION_MATRIX.md §B.
//
// The table is checked against the LIVE router stack, so the suite fails in two
// directions: a route that admits a role it should not, and a route that exists
// but nobody classified. The second is the one that matters over time — an
// unclassified endpoint is how a permission hole gets shipped.
//
// What "allowed" means here is narrow and deliberate: the request was not
// rejected for WHO you are. A 404 for a made-up id, or a 400 for an empty body,
// counts as allowed — the authorization layer let it through, which is the only
// thing this file is testing. 401/403 counts as denied.

const ROLES = ['dpo', 'dataOwner', 'collectionAgent', 'dataAdmin', 'super_admin']
const ALL = [...ROLES, 'subject', 'anon']

const A = (...roles) => new Set(roles)
const NOBODY = A()

// Matrix §B. Keys are `METHOD path` exactly as Express reports them.
const MATRIX = {
  // --- public / health ---
  'GET /health': A(...ALL),
  'GET /health/deep': A(...ALL),

  // --- auth (public by necessity; the credential is the control) ---
  'POST /auth/subject/login': A(...ALL),
  'POST /auth/subject/verify': A(...ALL),
  'GET /auth/subject/me': A('subject'),
  'POST /auth/admin/login': A(...ALL),
  'POST /auth/admin/accept-invite': A(...ALL),
  'POST /auth/admin/request-reset': A(...ALL),
  'POST /auth/admin/reset-password': A(...ALL),
  // Refresh consumes the REFRESH cookie, which this harness never presents, so
  // every caller is correctly rejected. Classified as NOBODY to record that a 401
  // here is the expected answer to a refresh with no refresh token, not a finding.
  'POST /auth/subject/refresh': NOBODY,
  'POST /auth/admin/refresh': NOBODY,
  // Logout is deliberately unauthenticated and idempotent: it clears cookies and
  // returns 204 whether or not you were signed in. Requiring auth to log out
  // would strand anyone holding a token the server already rejects.
  'POST /auth/subject/logout': A(...ALL),
  'POST /auth/admin/logout': A(...ALL),
  'GET /auth/admin/me': A(...ROLES),
  'POST /auth/admin/invite': A('super_admin'),
  'GET /auth/admin/users': A('dataOwner', 'super_admin'),

  // --- join (data principal only) ---
  'GET /api/v1/join/:token': A(...ALL),
  'POST /api/v1/join/:token/accept': A('subject'),

  // --- governance ---
  'GET /api/v1/projects': A('dpo', 'dataOwner', 'collectionAgent', 'dataAdmin', 'super_admin'),
  'POST /api/v1/projects': A('dataOwner', 'super_admin'),
  'GET /api/v1/projects/:projectId': A('dpo', 'dataOwner', 'collectionAgent', 'dataAdmin', 'super_admin'),
  'PATCH /api/v1/projects/:projectId': A('dataOwner', 'super_admin'),
  'POST /api/v1/projects/:projectId/submit': A('dataOwner', 'super_admin'),
  'POST /api/v1/projects/:projectId/approve': A('dpo', 'super_admin'),
  'POST /api/v1/projects/:projectId/reject': A('dpo', 'super_admin'),
  'POST /api/v1/projects/:projectId/close': A('dataOwner', 'super_admin'),
  'GET /api/v1/projects/:projectId/assignments': A('dpo', 'dataOwner', 'collectionAgent', 'dataAdmin', 'super_admin'),
  'POST /api/v1/projects/:projectId/assignments': A('dataOwner', 'super_admin'),
  'DELETE /api/v1/projects/:projectId/assignments/:adminId': A('dataOwner', 'super_admin'),
  // Returns subject names — matrix §D withholds identity from dpo and dataOwner.
  'GET /api/v1/projects/:projectId/subjects': A('collectionAgent', 'super_admin'),
  // Project-scoped oversight. Aggregate and pseudonymous, so dpo/dataOwner are
  // admitted where /sessions and /handoffs (which name people and serve media)
  // are not. collectionAgent is excluded: it reads its own sessions directly.
  'GET /api/v1/projects/:projectId/sessions': A('dpo', 'dataOwner', 'dataAdmin', 'super_admin'),
  'GET /api/v1/projects/:projectId/handoffs': A('dpo', 'dataOwner', 'dataAdmin', 'super_admin'),
  'GET /api/v1/projects/:projectId/report': A('dpo', 'dataOwner', 'dataAdmin', 'super_admin'),

  // --- consent templates ---
  'GET /api/v1/consent-templates': A('dpo', 'dataOwner', 'collectionAgent', 'super_admin'),
  'GET /api/v1/consent-templates/:templateId': A('dpo', 'dataOwner', 'collectionAgent', 'super_admin'),
  'POST /api/v1/consent-templates': A('dpo', 'super_admin'),
  'PATCH /api/v1/consent-templates/:templateId': A('dpo', 'super_admin'),
  'POST /api/v1/consent-templates/:templateId/publish': A('dpo', 'super_admin'),
  // A principal must read the notice before signing it.
  'GET /api/v1/consent-templates/:templateId/render': A(...ROLES, 'subject'),

  // --- dashboard ---
  'GET /api/v1/dashboard/summary': A(...ROLES),
  'GET /api/v1/dashboard/compliance-report': A('dpo', 'dataOwner', 'dataAdmin', 'super_admin'),

  // --- collection ---
  'POST /api/v1/sessions': A('collectionAgent', 'super_admin'),
  'GET /api/v1/sessions': A('collectionAgent', 'super_admin'),
  'GET /api/v1/sessions/:sessionId': A('collectionAgent', 'super_admin'),
  'POST /api/v1/sessions/:sessionId/participants': A('collectionAgent', 'super_admin'),
  'DELETE /api/v1/sessions/:sessionId/participants/:subjectId': A('collectionAgent', 'super_admin'),
  'POST /api/v1/sessions/:sessionId/photos': A('collectionAgent', 'super_admin'),
  'DELETE /api/v1/sessions/:sessionId/photos/:photoId': A('collectionAgent', 'super_admin'),
  'GET /api/v1/sessions/:sessionId/photos/:photoId/file': A('collectionAgent', 'super_admin'),
  // Matrix §B: "dataOwner ✓ own project", "dataAdmin ✓". The per-project scope for
  // dataOwner is asserted in loadSession, not here — this list is the role floor.
  'GET /api/v1/sessions/:sessionId/photos': A(
    'collectionAgent',
    'dataOwner',
    'dataAdmin',
    'super_admin',
  ),
  'GET /api/v1/sessions/:sessionId/photos/:photoId/redacted': A(
    'collectionAgent',
    'dataOwner',
    'dataAdmin',
    'super_admin',
  ),
  'GET /api/v1/sessions/:sessionId/faces/:faceId/crop': A('collectionAgent', 'super_admin'),
  'POST /api/v1/sessions/:sessionId/end': A('collectionAgent', 'super_admin'),
  'GET /api/v1/sessions/:sessionId/clusters': A('collectionAgent', 'super_admin'),
  'POST /api/v1/sessions/:sessionId/clusters/merge': A('collectionAgent', 'super_admin'),
  'POST /api/v1/sessions/:sessionId/clusters/accept-suggestions': A('collectionAgent', 'super_admin'),
  'POST /api/v1/sessions/:sessionId/clusters/:clusterId/split': A('collectionAgent', 'super_admin'),
  'PATCH /api/v1/sessions/:sessionId/clusters/:clusterId': A('collectionAgent', 'super_admin'),
  'GET /api/v1/sessions/:sessionId/people': A('collectionAgent', 'super_admin'),
  'GET /api/v1/sessions/:sessionId/people/:subjectId/photos': A('collectionAgent', 'super_admin'),
  'GET /api/v1/sessions/:sessionId/people/:subjectId/photos/:photoId/redacted': A('collectionAgent', 'super_admin'),
  'GET /api/v1/sessions/:sessionId/photos/review': A('collectionAgent', 'super_admin'),
  'POST /api/v1/sessions/:sessionId/finalize': A('collectionAgent', 'super_admin'),
  'GET /api/v1/sessions/:sessionId/invite': A('collectionAgent', 'super_admin'),
  'POST /api/v1/sessions/:sessionId/invite': A('collectionAgent', 'super_admin'),
  'DELETE /api/v1/sessions/:sessionId/invite': A('collectionAgent', 'super_admin'),
  // Break-glass: role gate only here; the DSAR binding and justification are
  // enforced inside requireBreakGlass and covered by its own assertions below.
  'GET /api/v1/sessions/:sessionId/photos/:photoId/raw': A('dataAdmin', 'super_admin'),

  // --- subjects (identity + biometrics) ---
  'POST /api/v1/subjects': A('collectionAgent', 'super_admin'),
  'GET /api/v1/subjects': A('collectionAgent', 'super_admin'),
  'GET /api/v1/subjects/:id': A('collectionAgent', 'super_admin'),
  'PATCH /api/v1/subjects/:id/consent': A('collectionAgent', 'super_admin'),
  'PATCH /api/v1/subjects/:id/status': A('collectionAgent', 'super_admin'),
  'PATCH /api/v1/subjects/:id/group': A('collectionAgent', 'super_admin'),
  'POST /api/v1/subjects/:subjectId/enrollments': A('collectionAgent', 'super_admin'),
  'GET /api/v1/subjects/:subjectId/enrollments': A('collectionAgent', 'super_admin'),
  'GET /api/v1/subjects/:subjectId/enrollments/:id/image': A('collectionAgent', 'super_admin'),
  'DELETE /api/v1/subjects/:subjectId/enrollments/:id': A('collectionAgent', 'super_admin'),

  // --- the principal's own surface ---
  'PATCH /api/v1/me/biometric-consent': A('subject'),
  'GET /api/v1/me/enrollment-status': A('subject'),
  'GET /api/v1/me/participations': A('subject'),
  // DPDP §11 — the principal's own answer to "how many photos am I in", and
  // their own copy of one, with everyone else blurred.
  'GET /api/v1/me/photos': A('subject'),
  'GET /api/v1/me/photos/:photoId/redacted': A('subject'),
  'POST /api/v1/me/enrollments': A('subject'),
  'GET /api/v1/me/enrollments': A('subject'),
  'GET /api/v1/me/enrollments/:id/image': A('subject'),
  'DELETE /api/v1/me/enrollments/:id': A('subject'),
  'POST /api/v1/me/dsar': A('subject'),
  'GET /api/v1/me/dsar': A('subject'),
  'GET /api/v1/me/dsar/:requestId': A('subject'),
  // The principal's own milestones. Ownership is enforced inside the service off
  // the verified token, and another principal's request id is a 404 there.
  'GET /api/v1/me/dsar/:requestId/timeline': A('subject'),
  'GET /api/v1/me/dsar/:requestId/package': A('subject'),
  'POST /api/v1/me/dsar/:requestId/package-token': A('subject'),
  'GET /api/v1/me/dsar/:requestId/certificate': A('subject'),
  'GET /api/v1/consent/projects': A('subject'),
  'POST /api/v1/consent/projects/:projectId/grant': A('subject'),
  'POST /api/v1/consent/projects/:projectId/revoke': A('subject'),

  // --- handoff / dataset ---
  'GET /api/v1/handoffs': A('dataAdmin', 'super_admin'),
  'GET /api/v1/handoffs/:id': A('dataAdmin', 'super_admin'),
  'POST /api/v1/handoffs/:id/ingest': A('dataAdmin', 'super_admin'),
  'GET /api/v1/handoffs/lineage': A('dataAdmin', 'super_admin'),

  // --- DSAR ---
  'GET /api/v1/dsar': A('dpo', 'dataOwner', 'dataAdmin', 'super_admin'),
  'GET /api/v1/dsar/sla': A('dpo', 'dataAdmin', 'super_admin'),
  'GET /api/v1/dsar/signing-key': A('dpo', 'dataOwner', 'dataAdmin', 'super_admin'),
  // Vault index. Returns content hashes, never payloads — the EXPORT_PACKAGE
  // payload holds a live download token hash.
  'GET /api/v1/dsar/evidence': A('dpo', 'dataOwner', 'dataAdmin', 'super_admin'),
  // Identity search. Returns names and emails, so §D's rule that dpo and
  // dataOwner never see subject identity puts this at dataAdmin/super only.
  'GET /api/v1/dsar/subjects/search': A('dataAdmin', 'super_admin'),
  // Break-glass targeting: ids only, scoped to the request's own subject.
  'GET /api/v1/dsar/:requestId/media': A('dpo', 'dataAdmin', 'super_admin'),
  // The item index for one request's subject: pseudonymous, no identity, no
  // blob paths — same role floor as /media.
  'GET /api/v1/dsar/:requestId/items': A('dpo', 'dataAdmin', 'super_admin'),
  // Destroying or redacting a frame is execution, not oversight. dpo approves
  // purposes and reads the record; it does not act on a principal's data.
  'POST /api/v1/dsar/:requestId/items/actions': A('dataAdmin', 'super_admin'),
  // Reading what was done to it is oversight, so dpo is admitted here.
  'GET /api/v1/dsar/:requestId/items/actions': A('dpo', 'dataAdmin', 'super_admin'),
  // Builds the §11 archive with a selection. dataAdmin/super only: it decrypts
  // derivatives, which is the same authority /execute needs.
  'POST /api/v1/dsar/:requestId/package': A('dataAdmin', 'super_admin'),
  // Merged history, pseudonymous throughout.
  'GET /api/v1/dsar/:requestId/timeline': A('dpo', 'dataAdmin', 'super_admin'),
  // Explicit close. dataOwner is excluded: they approve their own project's
  // resolution via /approve, but declaring a statutory obligation discharged is
  // the handler's or the DPO's act.
  'POST /api/v1/dsar/:requestId/close': A('dpo', 'dataAdmin', 'super_admin'),
  'GET /api/v1/dsar/:requestId': A('dpo', 'dataOwner', 'dataAdmin', 'super_admin'),
  'POST /api/v1/dsar/:requestId/assign': A('dpo', 'super_admin'),
  'POST /api/v1/dsar/:requestId/discovery': A('dataOwner', 'dataAdmin', 'super_admin'),
  'POST /api/v1/dsar/:requestId/evidence': A('dataOwner', 'dataAdmin', 'super_admin'),
  'POST /api/v1/dsar/:requestId/execute': A('dataAdmin', 'super_admin'),
  'POST /api/v1/dsar/:requestId/approve': A('dpo', 'dataOwner', 'super_admin'),
  'POST /api/v1/dsar/:requestId/reject': A('dpo', 'super_admin'),
  'GET /api/v1/dsar/:requestId/certificate': A('dpo', 'dataOwner', 'dataAdmin', 'super_admin'),
  'GET /api/v1/dsar/:requestId/purge-jobs/:purgeJobId': A('dpo', 'dataAdmin', 'super_admin'),

  // --- import (PLAN Phase 3) ---
  // dataAdmin/super_admin throughout. Asserting "this photograph is of this
  // named person" without a capture event or a face match is a data-administration
  // act: a dpo approves purposes and a dataOwner runs a project, and neither of
  // those is the authority to write a person's data into the system on their
  // behalf. The read endpoints share the floor because a batch names its subject.
  'POST /api/v1/imports': A('dataAdmin', 'super_admin'),
  'GET /api/v1/imports': A('dataAdmin', 'super_admin'),
  'POST /api/v1/imports/:batchId/items': A('dataAdmin', 'super_admin'),
  'POST /api/v1/imports/:batchId/close': A('dataAdmin', 'super_admin'),
  'GET /api/v1/imports/:batchId': A('dataAdmin', 'super_admin'),

  // --- audit ---
  'GET /api/v1/audit': A('dpo', 'dataOwner', 'dataAdmin', 'super_admin', 'subject'),
  'GET /api/v1/audit/verify': A('dpo', 'dataAdmin', 'super_admin'),
  'GET /api/v1/access-events': A('dpo', 'dataAdmin', 'super_admin', 'subject'),
}

// Endpoints that must not exist at all. Asserted separately so that adding one
// is a loud failure rather than a new row someone quietly classifies.
const FORBIDDEN_PATTERNS = [/embedding/i, /\/raw-embedding/i, /face-?template/i]

const server = { instance: null, base: '' }
const fixtures = { admins: {}, subject: null }
const RUN = randomUUID().slice(0, 8)

const REQUEST_TIMEOUT_MS = Number(process.env.RBAC_REQUEST_TIMEOUT_MS ?? 20_000)
const STALLED = 'STALLED'

function fillParams(path) {
  return path.replace(/:([A-Za-z]+)/g, () => randomUUID())
}

async function callAs(route, principal) {
  const headers = { 'content-type': 'application/json' }

  if (principal === 'subject' && fixtures.subject) {
    headers.cookie = `${SUBJECT_ACCESS_COOKIE}=${signSubjectAccessToken({ masterUserId: fixtures.subject })}`
  } else if (ROLES.includes(principal)) {
    const admin = fixtures.admins[principal]
    headers.cookie = `${ADMIN_ACCESS_COOKIE}=${signAdminAccessToken({ id: admin.id, role: principal })}`
  }

  // A route that never answers has, as far as authorization goes, let the caller
  // through — the guard runs before the handler. Bounded so one stalled endpoint
  // (a downstream worker that is down, say) cannot hang the whole sweep; the
  // caller records STALLED separately so it is visible rather than scored.
  let res
  try {
    res = await fetch(`${server.base}${fillParams(route.path)}`, {
      method: route.method,
      headers,
      body: ['POST', 'PATCH', 'PUT'].includes(route.method) ? '{}' : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    return STALLED
  }

  // Keep-alive sockets outlive the request. Left open, server.close() in teardown
  // waits for them forever and the test file never exits.
  return res.status
}

test.before(async () => {
  const app = createApp()
  await new Promise((resolve) => {
    server.instance = app.listen(0, resolve)
  })
  server.base = `http://127.0.0.1:${server.instance.address().port}`

  for (const role of ROLES) {
    fixtures.admins[role] = await prisma.adminUser.create({
      data: { email: `rbac-${RUN}-${role}@test.invalid`, role, status: 'ACTIVE' },
    })
  }

  const subject = await prisma.subject.create({
    data: {
      fullName: 'RBAC Fixture',
      email: `rbac-${RUN}-subject@test.invalid`,
      group: 'VOLUNTEER',
      status: 'ACTIVE',
      registrationChannel: 'SELF',
    },
  })
  fixtures.subject = subject.masterUserId
})

test.after(async () => {
  await prisma.subject.deleteMany({ where: { email: { contains: `rbac-${RUN}-` } } })
  await prisma.adminUser.deleteMany({ where: { email: { contains: `rbac-${RUN}-` } } })

  // closeAllConnections() before close(): undici holds the keep-alive sockets from
  // the sweep open, and plain close() waits on them indefinitely. That wait, not
  // any assertion, was what made this file report a failure with every subtest
  // passing — the runner gave up on a process that could not exit.
  server.instance?.closeAllConnections?.()
  await new Promise((resolve) => server.instance?.close(resolve))

  // Everything the app opened at import time has to be handed back explicitly.
  // The queues are lazy now, so these are no-ops unless something enqueued.
  await Promise.allSettled([
    closeFaceQueue(),
    closeRedactionQueue(),
    closePurgeQueue(),
    redis.quit(),
    prisma.$disconnect(),
  ])
})

test('every mounted route is classified in the matrix', () => {
  const routes = listRoutes(createApp())
  const unclassified = routes
    .map((r) => `${r.method} ${r.path}`)
    .filter((key) => !(key in MATRIX))

  assert.deepEqual(
    unclassified,
    [],
    `these routes are mounted but not classified in docs/02_ROLE_PERMISSION_MATRIX.md:\n  ${unclassified.join('\n  ')}`,
  )
})

test('the matrix has no entries for routes that no longer exist', () => {
  const mounted = new Set(listRoutes(createApp()).map((r) => `${r.method} ${r.path}`))
  const stale = Object.keys(MATRIX).filter((key) => !mounted.has(key))
  assert.deepEqual(stale, [], `stale matrix entries: ${stale.join(', ')}`)
})

test('no route exposes face embeddings', () => {
  const routes = listRoutes(createApp())
  for (const route of routes) {
    for (const pattern of FORBIDDEN_PATTERNS) {
      assert.equal(
        pattern.test(route.path),
        false,
        `${route.method} ${route.path} looks like an embedding route — invariant 3 forbids any path that returns a face template`,
      )
    }
  }
})

test('each role reaches exactly the routes the matrix allows', async () => {
  const routes = listRoutes(createApp())
  const violations = []
  const inconclusive = []
  const stalled = []

  for (const route of routes) {
    const key = `${route.method} ${route.path}`
    const allowed = MATRIX[key] ?? NOBODY

    for (const principal of ALL) {
      const status = await callAs(route, principal)

      // Timed out past the guard. Not an authorization failure, but not a clean
      // pass either — reaching the handler is exactly what "allowed" means, so a
      // stall on a route nobody should reach IS a violation.
      if (status === STALLED) {
        stalled.push(`${key} — ${principal}`)
        if (!allowed.has(principal)) {
          violations.push(`${key} — ${principal} should be DENIED but the handler ran (stalled)`)
        }
        continue
      }

      // A rate-limited response says nothing about authorization — the limiter
      // sits in front of the guard. Sweeping 105 routes × 7 principals trips it
      // on the endpoints that have one. Recorded rather than counted either way:
      // scoring it as "denied" would let a genuinely open route hide behind the
      // limiter.
      if (status === 429) {
        inconclusive.push(`${key} — ${principal} (rate limited)`)
        continue
      }

      const denied = status === 401 || status === 403
      const shouldAllow = allowed.has(principal)

      if (shouldAllow && denied) {
        violations.push(`${key} — ${principal} should be ALLOWED but got ${status}`)
      }
      if (!shouldAllow && !denied) {
        violations.push(`${key} — ${principal} should be DENIED but got ${status}`)
      }
    }
  }

  if (stalled.length) {
    console.warn(
      `\n  ${stalled.length} request(s) exceeded ${REQUEST_TIMEOUT_MS}ms — a dependency is probably down:\n    ` +
        `${stalled.join('\n    ')}\n`,
    )
  }

  if (inconclusive.length) {
    console.warn(
      `\n  ${inconclusive.length} check(s) inconclusive because the rate limiter answered first:\n    ` +
        `${inconclusive.join('\n    ')}\n  Re-run against a fresh limiter window to cover them.\n`,
    )
  }

  assert.deepEqual(violations, [], `\n  ${violations.join('\n  ')}\n`)
})
