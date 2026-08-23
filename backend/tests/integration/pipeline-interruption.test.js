import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import sharp from 'sharp'

import { prisma } from '../../src/config/prisma.js'
import { redis } from '../../src/config/redis.js'
import { writeFile, resolvePath } from '../../src/lib/storage.js'
import { UNRESOLVED_PHOTO_WHERE, isUnresolved, isResolved } from '../../src/lib/photoState.js'
import { withAdvisoryLock, LOCK_NAMESPACE } from '../../src/lib/advisoryLock.js'
import {
  workerFetch,
  WorkerUnavailableError,
  resetCircuitBreakers,
  circuitBreakerState,
} from '../../src/lib/workerFetch.js'
import { promoteIfRedacted } from '../../src/modules/sessions/session.service.js'
import { closeFaceQueue } from '../../src/lib/faceQueue.js'
import { closeRedactionQueue } from '../../src/lib/redactionQueue.js'
import { closePurgeQueue } from '../../src/lib/purgeQueue.js'

// Interruption: what the system does when a dependency goes away mid-flight.
//
// No test drove a mid-flight failure, which is why three separate findings all
// looked fine from the outside:
//
//   PII worker down during finalize   session archived anyway, photos PENDING forever
//   worker dies mid-recognition       job stalls, no reaper, session stuck (2 days observed)
//   second worker replica added       stalled re-delivery + deleteMany race → partial detections
//
// The invariant under all three: no session may reach ARCHIVED while it holds a
// frame that redaction has not finished with.

const RUN = randomUUID().slice(0, 8)
const fx = { written: [] }

async function makeJpeg(seed = 1) {
  return sharp({
    create: { width: 24, height: 24, channels: 3, background: { r: seed % 255, g: 60, b: 90 } },
  })
    .jpeg()
    .toBuffer()
}

async function addPhoto(sessionId, { piiStatus = 'PENDING', redacted = false } = {}) {
  const buffer = await makeJpeg(Math.floor(Math.random() * 200))
  const storagePath = `sessions/${sessionId}/photos/int-${randomUUID()}.jpg`
  await writeFile(storagePath, buffer)
  fx.written.push(storagePath)

  let redactedPath = null
  if (redacted) {
    redactedPath = `sessions/${sessionId}/redacted/int-${randomUUID()}.jpg`
    await writeFile(redactedPath, buffer)
    fx.written.push(redactedPath)
  }

  return prisma.photo.create({
    data: {
      sessionId,
      storagePath,
      redactedPath,
      cameraSource: 'IPHONE_UPLOAD',
      sha256: createHash('sha256').update(buffer).digest('hex') + randomUUID().slice(0, 4),
      mimeType: 'image/jpeg',
      sizeBytes: buffer.length,
      piiStatus,
    },
  })
}

test.before(async () => {
  fx.owner = await prisma.adminUser.create({
    data: { email: `int-${RUN}-owner@test.invalid`, role: 'dataOwner', status: 'ACTIVE' },
  })
  fx.agent = await prisma.adminUser.create({
    data: { email: `int-${RUN}-agent@test.invalid`, role: 'collectionAgent', status: 'ACTIVE' },
  })
  fx.project = await prisma.project.create({
    data: {
      name: `Interrupt ${RUN}`,
      purpose: 'interruption fixture',
      ownerAdminId: fx.owner.id,
      status: 'APPROVED',
    },
  })
})

test.after(async () => {
  for (const p of fx.written) await fs.rm(resolvePath(p), { force: true }).catch(() => {})
  await prisma.photo.deleteMany({ where: { session: { projectId: fx.project?.id } } })
  await prisma.sessionHandoff.deleteMany({ where: { projectId: fx.project?.id } })
  await prisma.session.deleteMany({ where: { projectId: fx.project?.id } })
  await prisma.project.deleteMany({ where: { name: `Interrupt ${RUN}` } })
  await prisma.adminUser.deleteMany({ where: { email: { contains: `int-${RUN}-` } } })

  await Promise.allSettled([
    closeFaceQueue(),
    closeRedactionQueue(),
    closePurgeQueue(),
    redis.quit(),
    prisma.$disconnect(),
  ])
})

function mkSession(status = 'REDACTING') {
  return prisma.session.create({
    data: {
      code: `INT-${RUN}-${randomUUID().slice(0, 6)}`,
      projectId: fx.project.id,
      agentId: fx.agent.id,
      status,
    },
  })
}

// ---------------------------------------------------------------------------
// The invariant
// ---------------------------------------------------------------------------

test('a session holding an unredacted frame is not promoted to ARCHIVED', async () => {
  const session = await mkSession('REDACTING')
  await addPhoto(session.id, { piiStatus: 'CLEAN', redacted: true })
  await addPhoto(session.id, { piiStatus: 'PENDING', redacted: false }) // the PII worker never got to this one

  const result = await promoteIfRedacted(session.id)

  assert.equal(result.archived, false, 'a session with an unresolved frame was archived')
  assert.equal(result.unresolved, 1)

  const after = await prisma.session.findUnique({ where: { id: session.id } })
  assert.equal(after.status, 'REDACTING', `status is ${after.status}, expected REDACTING`)

  const handoff = await prisma.sessionHandoff.findUnique({ where: { sessionId: session.id } })
  assert.equal(handoff, null, 'a handoff was created for a session that is not fully redacted')
})

test('a session is promoted once every frame is terminal', async () => {
  const session = await mkSession('REDACTING')
  await addPhoto(session.id, { piiStatus: 'CLEAN', redacted: true })
  await addPhoto(session.id, { piiStatus: 'MASKED', redacted: true })

  const result = await promoteIfRedacted(session.id)

  assert.equal(result.archived, true, `promotion refused: ${result.reason}`)

  const after = await prisma.session.findUnique({ where: { id: session.id } })
  assert.equal(after.status, 'ARCHIVED')
  assert.ok(after.archivedAt, 'archivedAt was not set')

  const handoff = await prisma.sessionHandoff.findUnique({ where: { sessionId: session.id } })
  assert.ok(handoff, 'no handoff was created for a fully redacted session')
  assert.equal(handoff.photoCount, 2)
})

test('a terminal status with no derivative on disk still blocks promotion', async () => {
  // The finalize path could commit CLEAN before the redacted file was written,
  // so status alone is not the test — every site that only looked at piiStatus
  // would have let this through.
  const session = await mkSession('REDACTING')
  await addPhoto(session.id, { piiStatus: 'CLEAN', redacted: false })

  const result = await promoteIfRedacted(session.id)
  assert.equal(result.archived, false, 'a CLEAN photo with no derivative was treated as finished')
})

test('promotion is idempotent under repeated calls', async () => {
  // finalize, the redaction worker and the reaper all call this, so it runs
  // several times per session by design.
  const session = await mkSession('REDACTING')
  await addPhoto(session.id, { piiStatus: 'CLEAN', redacted: true })

  const results = await Promise.all([
    promoteIfRedacted(session.id),
    promoteIfRedacted(session.id),
    promoteIfRedacted(session.id),
  ])

  // At most one caller does the work; the rest see it already done or find the
  // lock held. None of them may fail, and none may create a second handoff.
  assert.ok(results.some((r) => r.archived || r.reason === 'LOCK_HELD'))

  const handoffs = await prisma.sessionHandoff.count({ where: { sessionId: session.id } })
  assert.equal(handoffs, 1, `${handoffs} handoffs were created for one session`)
})

test('promotion never moves a session backwards out of ARCHIVED', async () => {
  const session = await mkSession('ARCHIVED')
  await addPhoto(session.id, { piiStatus: 'PENDING', redacted: false })

  const result = await promoteIfRedacted(session.id)
  assert.equal(result.reason, 'ALREADY_ARCHIVED')

  const after = await prisma.session.findUnique({ where: { id: session.id } })
  assert.equal(
    after.status,
    'ARCHIVED',
    'promotion rewrote the status of an already-archived session — a reaper that can ' +
      'un-archive a session is a reaper that can retract a handoff',
  )
})

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

test('an advisory lock admits exactly one holder at a time', async () => {
  // BullMQ delivers at least once, and processSession() opens by deleting every
  // FaceDetection in the session — so two concurrent runs do not merely
  // duplicate work, the second wipes the first's in-flight rows and the session
  // ends with a partial detection set and no error raised.
  const id = randomUUID()
  let insideCount = 0
  let maxConcurrent = 0

  const body = async () => {
    insideCount += 1
    maxConcurrent = Math.max(maxConcurrent, insideCount)
    await new Promise((resolve) => setTimeout(resolve, 120))
    insideCount -= 1
    return 'done'
  }

  const results = await Promise.all([
    withAdvisoryLock(LOCK_NAMESPACE.RECOGNITION_SESSION, id, body),
    withAdvisoryLock(LOCK_NAMESPACE.RECOGNITION_SESSION, id, body),
    withAdvisoryLock(LOCK_NAMESPACE.RECOGNITION_SESSION, id, body),
  ])

  assert.equal(maxConcurrent, 1, `${maxConcurrent} callers ran the guarded body at once`)

  const acquired = results.filter((r) => r.acquired)
  assert.equal(acquired.length, 1, `${acquired.length} callers acquired the lock`)

  // A caller that did NOT get the lock is told so rather than silently doing
  // nothing — the queue treats it as a duplicate delivery.
  for (const r of results.filter((x) => !x.acquired)) {
    assert.equal(r.result, undefined)
  }
})

test('different ids do not block each other', async () => {
  const a = withAdvisoryLock(LOCK_NAMESPACE.RECOGNITION_SESSION, randomUUID(), async () => 'a')
  const b = withAdvisoryLock(LOCK_NAMESPACE.RECOGNITION_SESSION, randomUUID(), async () => 'b')
  const [ra, rb] = await Promise.all([a, b])
  assert.ok(ra.acquired && rb.acquired, 'two different sessions blocked each other')
})

// ---------------------------------------------------------------------------
// Worker calls
// ---------------------------------------------------------------------------

test('a worker call has a deadline', async () => {
  // AbortSignal, AbortController and `timeout` appeared ZERO times in
  // backend/src: all ten fetch() calls to the Python workers relied on undici's
  // 300-second default. A 300-second hang under a 30-second queue lock means the
  // job is re-delivered while the original is still running.
  resetCircuitBreakers()

  const started = Date.now()
  await assert.rejects(
    () =>
      workerFetch('face', 'http://127.0.0.1:9/never-answers', {
        body: () => 'x',
        timeoutMs: 400,
      }),
    (err) => err instanceof WorkerUnavailableError,
  )

  const elapsed = Date.now() - started
  assert.ok(
    elapsed < 20_000,
    `the call took ${elapsed}ms — it must fail on its own deadline, not undici's 300s default`,
  )
})

test('a dependency failure is a 503, not a 500', async () => {
  resetCircuitBreakers()
  try {
    await workerFetch('pii', 'http://127.0.0.1:9/down', { body: () => 'x', timeoutMs: 300 })
    assert.fail('expected the call to reject')
  } catch (err) {
    // A dependency being unreachable is a different thing from this process
    // being broken, and the two want different alerts.
    assert.equal(err.statusCode, 503)
    assert.equal(err.message, 'A processing service is unavailable')
  }
})

test('the circuit opens after repeated failures and stops asking', async () => {
  resetCircuitBreakers()

  for (let i = 0; i < 6; i += 1) {
    await workerFetch('text', 'http://127.0.0.1:9/down', { body: () => 'x', timeoutMs: 150 }).catch(
      () => {},
    )
  }

  const state = circuitBreakerState()
  assert.ok(state.text, 'no breaker state was recorded for the text worker')
  assert.equal(
    state.text.open,
    true,
    'the breaker never opened — a dead worker would be asked once per job forever, ' +
      'and the queue would back up behind a dependency answering instantly with "no"',
  )

  // Once open, the call fails immediately rather than waiting out another
  // timeout.
  const started = Date.now()
  await workerFetch('text', 'http://127.0.0.1:9/down', { body: () => 'x' }).catch(() => {})
  assert.ok(Date.now() - started < 100, 'an open breaker still paid for a timeout')
})

test('the breaker is per service', async () => {
  resetCircuitBreakers()
  for (let i = 0; i < 6; i += 1) {
    await workerFetch('audio', 'http://127.0.0.1:9/down', { body: () => 'x', timeoutMs: 120 }).catch(
      () => {},
    )
  }
  const state = circuitBreakerState()
  assert.equal(state.audio?.open, true)
  assert.equal(state.face?.open, undefined, 'one worker being down opened another worker\'s breaker')
})

// ---------------------------------------------------------------------------
// The predicate, against the live database
// ---------------------------------------------------------------------------

test('the unresolved query and the in-memory predicate agree', async () => {
  const session = await mkSession('REDACTING')
  const states = [
    { piiStatus: 'PENDING', redacted: false },
    { piiStatus: 'CLEAN', redacted: true },
    { piiStatus: 'MASKED', redacted: true },
    { piiStatus: 'DEFERRED', redacted: false },
    { piiStatus: 'FAILED', redacted: false },
    { piiStatus: 'CLEAN', redacted: false },
  ]
  for (const s of states) await addPhoto(session.id, s)

  const viaQuery = await prisma.photo.findMany({
    where: { sessionId: session.id, ...UNRESOLVED_PHOTO_WHERE },
    select: { id: true, piiStatus: true, redactedPath: true },
  })
  const all = await prisma.photo.findMany({
    where: { sessionId: session.id },
    select: { id: true, piiStatus: true, redactedPath: true },
  })

  const viaPredicate = all.filter(isUnresolved).map((p) => p.id).sort()
  assert.deepEqual(
    viaQuery.map((p) => p.id).sort(),
    viaPredicate,
    'UNRESOLVED_PHOTO_WHERE and isUnresolved() disagree — the gate and the dashboard ' +
      'would then be reporting different things about the same photo',
  )

  // Four of the six are unresolved: PENDING, DEFERRED, FAILED, and the CLEAN one
  // with no derivative.
  assert.equal(viaQuery.length, 4)
  assert.equal(all.filter(isResolved).length, 2)
})
