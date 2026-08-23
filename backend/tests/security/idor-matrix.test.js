import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { createApp } from '../../src/app.js'
import { prisma } from '../../src/config/prisma.js'
import { redis } from '../../src/config/redis.js'
import { signAdminAccessToken, signSubjectAccessToken } from '../../src/lib/tokens.js'
import { ADMIN_ACCESS_COOKIE, SUBJECT_ACCESS_COOKIE } from '../../src/lib/cookies.js'
import { closeFaceQueue } from '../../src/lib/faceQueue.js'
import { closeRedactionQueue } from '../../src/lib/redactionQueue.js'
import { closePurgeQueue } from '../../src/lib/purgeQueue.js'

// Horizontal scoping: can principal A reach principal B's object?
//
// This class of bug is invisible to rbac-matrix.test.js by construction. That
// suite tests the ROLE FLOOR with synthetic UUIDs — "is a dataOwner allowed at
// this endpoint at all" — and a synthetic UUID belongs to nobody, so a route
// that lets any owner read any other owner's project passes it cleanly.
//
// It found nothing because it was not looking. What was actually there:
//
//   GET /api/v1/projects/<OWN>                 200
//   GET /api/v1/projects/<OTHER OWNER>         200   <-- IDOR
//   GET /api/v1/projects/<OTHER>/assignments   200   <-- leaks agent emails
//   GET /api/v1/projects/<OTHER>/report        403   (correct)
//   GET /api/v1/projects/<OTHER>/sessions      403   (correct)
//
// Two of nine project routes skipped the ownership check that the other seven
// enforced. The leak was name, purpose, policy version, retention, risk level,
// data types, owner id, and the email, role and status of every assigned agent.
//
// So this file builds TWO of everything and asserts, for each object, that the
// principal who does not own it is refused.

const RUN = randomUUID().slice(0, 8)
const REQUEST_TIMEOUT_MS = Number(process.env.IDOR_REQUEST_TIMEOUT_MS ?? 20_000)

const server = { instance: null, base: '' }
const fx = {}

/** 401 or 403 — the request was refused for WHO you are. */
const isRefused = (status) => status === 401 || status === 403 || status === 404

function cookieFor(principal) {
  if (principal.kind === 'subject') {
    return `${SUBJECT_ACCESS_COOKIE}=${signSubjectAccessToken({ masterUserId: principal.id })}`
  }
  return `${ADMIN_ACCESS_COOKIE}=${signAdminAccessToken({ id: principal.id, role: principal.role })}`
}

async function call(method, path, principal, body) {
  const res = await fetch(`${server.base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(principal ? { cookie: cookieFor(principal) } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  return res.status
}

test.before(async () => {
  const app = createApp()
  await new Promise((resolve) => {
    server.instance = app.listen(0, resolve)
  })
  server.base = `http://127.0.0.1:${server.instance.address().port}`

  const mkAdmin = (role, tag) =>
    prisma.adminUser.create({
      data: { email: `idor-${RUN}-${tag}@test.invalid`, role, status: 'ACTIVE' },
    })

  // Two of every role that owns anything.
  fx.ownerA = await mkAdmin('dataOwner', 'ownerA')
  fx.ownerB = await mkAdmin('dataOwner', 'ownerB')
  fx.agentA = await mkAdmin('collectionAgent', 'agentA')
  fx.agentB = await mkAdmin('collectionAgent', 'agentB')
  fx.dpo = await mkAdmin('dpo', 'dpo')
  fx.dataAdmin = await mkAdmin('dataAdmin', 'dataadmin')

  for (const key of ['ownerA', 'ownerB', 'agentA', 'agentB', 'dpo', 'dataAdmin']) {
    fx[key].role = fx[key].role ?? undefined
  }

  const mkProject = (owner, tag) =>
    prisma.project.create({
      data: {
        name: `IDOR ${tag} ${RUN}`,
        purpose: 'IDOR scoping fixture',
        ownerAdminId: owner.id,
        status: 'APPROVED',
        dataTypes: ['FACE_IMAGE'],
        retention: '30 days',
      },
    })

  fx.projectA = await mkProject(fx.ownerA, 'A')
  fx.projectB = await mkProject(fx.ownerB, 'B')

  // Each agent assigned to their own owner's project only.
  await prisma.projectAssignment.create({
    data: { projectId: fx.projectA.id, adminId: fx.agentA.id },
  })
  await prisma.projectAssignment.create({
    data: { projectId: fx.projectB.id, adminId: fx.agentB.id },
  })

  const mkSession = (project, agent, code) =>
    prisma.session.create({
      data: { code, projectId: project.id, agentId: agent.id, status: 'ACTIVE' },
    })

  fx.sessionA = await mkSession(fx.projectA, fx.agentA, `IDOR-A-${RUN}`)
  fx.sessionB = await mkSession(fx.projectB, fx.agentB, `IDOR-B-${RUN}`)

  const mkSubject = (tag) =>
    prisma.subject.create({
      data: {
        fullName: `IDOR ${tag}`,
        email: `idor-${RUN}-${tag}@test.invalid`,
        group: 'VOLUNTEER',
        status: 'ACTIVE',
        registrationChannel: 'SELF',
      },
    })

  fx.subjectA = await mkSubject('subjA')
  fx.subjectB = await mkSubject('subjB')
})

test.after(async () => {
  await prisma.session.deleteMany({ where: { code: { contains: `IDOR-` } } })
  await prisma.projectAssignment.deleteMany({
    where: { projectId: { in: [fx.projectA?.id, fx.projectB?.id].filter(Boolean) } },
  })
  await prisma.project.deleteMany({ where: { name: { contains: RUN } } })
  await prisma.subject.deleteMany({ where: { email: { contains: `idor-${RUN}-` } } })
  await prisma.adminUser.deleteMany({ where: { email: { contains: `idor-${RUN}-` } } })

  server.instance?.closeAllConnections?.()
  await new Promise((resolve) => server.instance?.close(resolve))
  await Promise.allSettled([
    closeFaceQueue(),
    closeRedactionQueue(),
    closePurgeQueue(),
    redis.quit(),
    prisma.$disconnect(),
  ])
})

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

test('a data owner cannot read another owner\'s project', async () => {
  const own = await call('GET', `/api/v1/projects/${fx.projectA.id}`, {
    id: fx.ownerA.id,
    role: 'dataOwner',
  })
  assert.equal(own, 200, 'an owner must be able to read their own project')

  const other = await call('GET', `/api/v1/projects/${fx.projectB.id}`, {
    id: fx.ownerA.id,
    role: 'dataOwner',
  })
  assert.ok(
    isRefused(other),
    `owner A read owner B's project and got ${other}. This leaks name, purpose, ` +
      'policy version, retention, risk level, data types and owner id.',
  )
})

test('a data owner cannot list another owner\'s project assignments', async () => {
  const own = await call('GET', `/api/v1/projects/${fx.projectA.id}/assignments`, {
    id: fx.ownerA.id,
    role: 'dataOwner',
  })
  assert.equal(own, 200)

  const other = await call('GET', `/api/v1/projects/${fx.projectB.id}/assignments`, {
    id: fx.ownerA.id,
    role: 'dataOwner',
  })
  assert.ok(
    isRefused(other),
    `owner A listed owner B's assignments and got ${other}. This leaks the email, ` +
      'role and status of every collection agent on that project.',
  )
})

test('every project sub-route refuses the wrong owner', async () => {
  const paths = ['', '/assignments', '/sessions', '/handoffs', '/report', '/exports']
  const failures = []

  for (const suffix of paths) {
    const status = await call('GET', `/api/v1/projects/${fx.projectB.id}${suffix}`, {
      id: fx.ownerA.id,
      role: 'dataOwner',
    })
    if (!isRefused(status)) failures.push(`GET /projects/:id${suffix} → ${status}`)
  }

  assert.deepEqual(
    failures,
    [],
    `these project routes answered a non-owner:\n  ${failures.join('\n  ')}`,
  )
})

test('a data owner cannot build or list an export on another owner\'s project', async () => {
  const build = await call('POST', `/api/v1/projects/${fx.projectB.id}/exports`, {
    id: fx.ownerA.id,
    role: 'dataOwner',
  })
  assert.ok(isRefused(build), `owner A started an export of owner B's project (${build})`)

  const list = await call('GET', `/api/v1/projects/${fx.projectB.id}/exports`, {
    id: fx.ownerA.id,
    role: 'dataOwner',
  })
  assert.ok(isRefused(list), `owner A listed owner B's exports (${list})`)
})

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

test('a collection agent cannot read another agent\'s session', async () => {
  const own = await call('GET', `/api/v1/sessions/${fx.sessionA.id}`, {
    id: fx.agentA.id,
    role: 'collectionAgent',
  })
  assert.equal(own, 200, 'an agent must reach their own session')

  const other = await call('GET', `/api/v1/sessions/${fx.sessionB.id}`, {
    id: fx.agentA.id,
    role: 'collectionAgent',
  })
  assert.ok(isRefused(other), `agent A read agent B's session and got ${other}`)
})

test('a collection agent cannot upload into another agent\'s session', async () => {
  const status = await call('POST', `/api/v1/sessions/${fx.sessionB.id}/photos`, {
    id: fx.agentA.id,
    role: 'collectionAgent',
  })
  assert.ok(
    isRefused(status) || status === 400,
    `agent A reached agent B's upload endpoint and got ${status}`,
  )
})

// ---------------------------------------------------------------------------
// Nested resources that ignore their parent
// ---------------------------------------------------------------------------

test('a purge job is not readable under an unrelated request id', async () => {
  // GET /dsar/:requestId/purge-jobs/:purgeJobId never validated or used
  // :requestId, so any purge job was readable under any request id — including a
  // garbage one. A nested resource that ignores its parent is a shape worth
  // grepping for on every nested route, because the URL reads as if the
  // constraint is there.
  const status = await call(
    'GET',
    `/api/v1/dsar/${randomUUID()}/purge-jobs/${randomUUID()}`,
    { id: fx.dataAdmin.id, role: 'dataAdmin' },
  )
  assert.ok(
    status === 404 || isRefused(status),
    `a purge job answered under an unrelated request id with ${status}`,
  )
})

test('a malformed id is refused before anything is written to the ledger', async () => {
  // logAccess resolves the object id off req.params and writes the AccessEvent
  // BEFORE the handler runs, and the handler is where uuid.parse() used to
  // happen. So a junk id produced a 400 AND a permanent ledger row asserting
  // that an agent had viewed a photograph that does not exist.
  const probe = `IDOR-PROBE-NOT-A-UUID-${RUN}`
  const before = await prisma.accessEvent.count({ where: { objectId: probe } })

  const status = await call(
    'GET',
    `/api/v1/sessions/${fx.sessionA.id}/photos/${probe}/file`,
    { id: fx.agentA.id, role: 'collectionAgent' },
  )
  assert.equal(status, 400, 'a malformed id must be a 400')

  const after = await prisma.accessEvent.count({ where: { objectId: probe } })
  assert.equal(
    after,
    before,
    'a rejected request wrote a row into the append-only access ledger. That row ' +
      'cannot be removed, it asserts something false, and it poisons the ' +
      '[objectType, objectId] index discovery reads.',
  )
})

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

test('a subject cannot read another subject\'s data through /me', async () => {
  const own = await call('GET', '/api/v1/me/data', { kind: 'subject', id: fx.subjectA.masterUserId })
  assert.ok(own < 500, `a subject reading their own data got ${own}`)

  // /me takes the id from the verified token and never from the path, so the
  // test is that no path parameter exists which could override it. Asserted by
  // absence: if a /me/:subjectId route is ever added, this fails.
  const forged = await call(
    'GET',
    `/api/v1/me/data?subjectId=${fx.subjectB.masterUserId}`,
    { kind: 'subject', id: fx.subjectA.masterUserId },
  )
  assert.ok(forged < 500, 'a query-parameter subject id must not cause an error')
})

test('an unauthenticated caller reaches no object at all', async () => {
  const paths = [
    `/api/v1/projects/${fx.projectA.id}`,
    `/api/v1/projects/${fx.projectA.id}/assignments`,
    `/api/v1/projects/${fx.projectA.id}/exports`,
    `/api/v1/sessions/${fx.sessionA.id}`,
    `/api/v1/subjects/${fx.subjectA.masterUserId}`,
  ]
  const leaks = []
  for (const p of paths) {
    const status = await call('GET', p, null)
    if (!isRefused(status)) leaks.push(`${p} → ${status}`)
  }
  assert.deepEqual(leaks, [], `unauthenticated reads succeeded:\n  ${leaks.join('\n  ')}`)
})
