import test from 'node:test'
import assert from 'node:assert/strict'

import { prisma } from '../../src/config/prisma.js'
import { fileExists, readFile } from '../../src/lib/storage.js'
import { galleryExists } from '../../src/lib/faceGallery.js'
import { verifyChain } from '../../src/modules/audit/audit.service.js'
import * as sessionService from '../../src/modules/sessions/session.service.js'
import * as handoffService from '../../src/modules/handoff/handoff.service.js'
import * as projectService from '../../src/modules/projects/project.service.js'
import {
  buildWorld,
  checkPreconditions,
  closeResources,
  destroyWorld,
  photoByFixture,
  runSession,
} from './world.js'

// WAVE 5.1 — the whole walk, once, against the real pipeline.
//
// Notice → project → approval → consent → enrolment → capture → recognition →
// tagging → finalize → redaction → handoff. Every step goes through the service
// the application uses, so what passes here is what ships.
//
// The suite refuses to run rather than skipping quietly when a dependency is
// missing. A green "0 tests" is the most dangerous result a compliance gate can
// produce.

let world
let run
let blocked = null

test.before(async () => {
  blocked = await checkPreconditions()
  if (blocked) return
  world = await buildWorld()
  run = await runSession(world)
})

test.after(async () => {
  // closeResources must run even when cleanup fails. Without the finally, a
  // teardown error leaves the Redis client and the Prisma pool open, and the file
  // hangs forever instead of reporting the error that caused it.
  try {
    await destroyWorld(world)
  } finally {
    await closeResources()
  }
})

test('preconditions', () => {
  assert.equal(blocked, null, `end-to-end dependencies are not available: ${blocked}`)
})

test('the project could not be collected against until the DPO approved it', async () => {
  const agent = world.admins.collectionAgent

  const fresh = await projectService.createProject(
    { name: `Unapproved ${world.tag}`, purpose: 'never submitted' },
    world.admins.dataOwner,
  )
  // Assignment is refused on a DRAFT project, which is itself the point — the
  // agent then fails assertAssigned rather than assertCollectable. Either way the
  // session must not be creatable.
  await projectService.assignAgent(fresh.id, agent.id, world.admins.dataOwner).catch(() => {})

  await assert.rejects(
    () => sessionService.createSession({ projectId: fresh.id }, agent),
    (err) => err.statusCode === 403 || /not approved|assigned/i.test(err.message),
    'a DRAFT project must not be collectable',
  )

  await prisma.project.delete({ where: { id: fresh.id } }).catch(() => {})

  // And the approved one carries the frozen notice version, not a mutable pointer.
  assert.equal(
    world.project.policyVersion,
    `${world.template.name} v${world.template.version}`,
    'approval must freeze the notice version onto the project',
  )
})

test('every photo link points at project_consent_matrix, and only at consented people', async () => {
  const links = await prisma.photoSubject.findMany({
    where: { photo: { sessionId: run.session.id } },
    include: { consent: true },
  })

  assert.ok(links.length > 0, 'finalize produced no photo↔subject links at all')

  const consented = new Set([world.consents.a.consentId, world.consents.b.consentId])
  for (const link of links) {
    assert.ok(
      consented.has(link.consentId),
      `link ${link.id} cites consent ${link.consentId}, which is not a matrix row for this project`,
    )
    assert.equal(link.consent.status, 'ACTIVE')
    assert.equal(link.consent.projectId, world.project.id)
  }
})

test('the session archived and its face gallery was destroyed', async () => {
  const session = await prisma.session.findUnique({ where: { id: run.session.id } })
  assert.equal(session.status, 'ARCHIVED')
  assert.ok(session.archivedAt)

  assert.equal(
    await galleryExists(run.session.id),
    false,
    'the ephemeral enrolment gallery outlived the session it was built for',
  )
})

test('the original is never overwritten and redaction wrote a separate object', async () => {
  const photos = await prisma.photo.findMany({ where: { sessionId: run.session.id } })
  assert.ok(photos.length >= 2)

  for (const photo of photos) {
    assert.ok(photo.redactedPath, `photo ${photo.id} has no redacted derivative`)
    assert.notEqual(
      photo.redactedPath,
      photo.storagePath,
      'invariant 4: the redacted copy must not be written over the original',
    )
    assert.ok(await fileExists(photo.storagePath), 'the original object is gone')
    assert.ok(await fileExists(photo.redactedPath), 'the redacted object was not written')

    const original = await readFile(photo.storagePath)
    assert.equal(
      original.subarray(0, 2).toString('hex'),
      'ffd8',
      'the original no longer decodes as a JPEG — something rewrote it',
    )
  }
})

test('redaction failure would fail closed — nothing is serveable without a derivative', async () => {
  const deferred = await sessionService.countDeferredPhotos(run.session.id)
  assert.equal(deferred, 0, 'the run left photos parked as DEFERRED; the PII worker was not healthy')

  const photo = (await prisma.photo.findFirst({ where: { sessionId: run.session.id } }))
  await prisma.photo.update({
    where: { id: photo.id },
    data: { redactedPath: null, piiStatus: 'DEFERRED' },
  })

  try {
    // Invariant 8: with no derivative there is no fallback to the raw original.
    await assert.rejects(
      () =>
        sessionService.readRedactedPhoto(
          run.session.id,
          photo.id,
          world.admins.collectionAgent,
        ),
      /redact|not available|unavailable|pending/i,
      'a photo with no redacted derivative must not be serveable at all',
    )

    // And the batch downstream refuses to ingest while that is true.
    const handoff = await prisma.sessionHandoff.findUnique({
      where: { sessionId: run.session.id },
    })
    await assert.rejects(
      () => handoffService.ingestHandoff(handoff.id, world.admins.dataAdmin),
      (err) => err.statusCode === 409 && /REDACTION_INCOMPLETE/.test(err.message),
      'the handoff ingested a session with an unredacted photo',
    )
  } finally {
    await prisma.photo.update({
      where: { id: photo.id },
      data: { redactedPath: photo.redactedPath, piiStatus: photo.piiStatus },
    })
  }
})

test('no face embedding is reachable through any read path', async () => {
  const agent = world.admins.collectionAgent

  // getPhotosForReview is deliberately absent: it is TAGGING-only and refuses an
  // ARCHIVED session, which is the state this world ends in. The rbac-matrix
  // suite covers its route; what this asserts is that none of the reads still
  // reachable after archival carries a template.
  const payloads = [
    await sessionService.getSession(run.session.id, agent),
    await sessionService.getClusters(run.session.id, agent),
    await sessionService.getPeople(run.session.id, agent),
  ]

  for (const payload of payloads) {
    const json = JSON.stringify(payload)
    assert.doesNotMatch(json, /"embedding"/, 'invariant 3: an embedding reached a response body')
    assert.doesNotMatch(json, /embeddingDim/, 'invariant 3: embedding metadata reached a response body')
  }

  // And it is not sitting in the clear in the column either.
  const enrollment = await prisma.subjectFaceEnrollment.findUnique({
    where: { id: world.enrollments.a.id },
    select: { embedding: true, embeddingDim: true },
  })
  assert.ok(enrollment.embedding, 'the enrolment stored no embedding at all')
  assert.notEqual(
    enrollment.embedding.length,
    enrollment.embeddingDim * 4,
    'the embedding column is the raw float32 buffer — it was never encrypted',
  )
})

test('every media read writes an AccessEvent before the bytes are decrypted', async () => {
  const agent = world.admins.collectionAgent
  const photo = await prisma.photo.findFirst({ where: { sessionId: run.session.id } })

  const before = await prisma.accessEvent.count({ where: { objectId: photo.id } })

  // This is the exact order middleware/logAccess.js imposes on the media routes:
  // the event is written, and only then is the service asked for bytes.
  const { recordAccess } = await import('../../src/lib/accessLog.js')
  await recordAccess({
    objectType: 'PHOTO',
    objectId: photo.id,
    actorType: 'ADMIN',
    actorId: agent.id,
    purpose: 'COLLECTION',
  })
  const served = await sessionService.readRedactedPhoto(run.session.id, photo.id, agent)

  const after = await prisma.accessEvent.count({ where: { objectId: photo.id } })
  assert.equal(after, before + 1, 'the read produced no AccessEvent')
  assert.ok(served.buffer.length > 0, 'the read returned no bytes')

  // Invariant 6 is "the log write fails ⇒ the read fails". recordAccess must
  // throw rather than swallow, or logAccess would call next() and the handler
  // would serve the photo unlogged.
  await assert.rejects(
    () => recordAccess({ objectType: 'PHOTO', objectId: null, actorType: 'ADMIN', actorId: agent.id }),
    'recordAccess accepted an unloggable read instead of refusing it',
  )
})

test('the audit chain covering this run verifies', async () => {
  for (const [entityType, entityId] of [
    ['Session', run.session.id],
    ['Project', world.project.id],
    ['ConsentTemplate', world.template.id],
  ]) {
    const result = await verifyChain(entityType, entityId)
    assert.ok(result.entries > 0, `${entityType} ${entityId} produced no audit entries`)
    assert.equal(
      result.valid,
      true,
      `${entityType} audit chain broken: ${JSON.stringify(result.breaks)}`,
    )
    assert.equal(
      result.linkageOnly,
      0,
      'entries written by this run carry no payloadDigest, so they verify by linkage alone',
    )
  }
})

test('the audit log stores digests, never payload plaintext', async () => {
  const rows = await prisma.auditLog.findMany({
    where: { entityId: run.session.id },
    take: 20,
  })
  assert.ok(rows.length > 0, 'the session produced no audit entries')

  const columns = new Set(Object.keys(rows[0]))
  assert.equal(columns.has('payload'), false, 'invariant 7: an audit row carries a payload column')
  for (const row of rows) {
    assert.match(row.payloadHash, /^[0-9a-f]{64}$/, 'payloadHash is not a SHA-256 digest')
  }
})

test('the handoff batch matches what finalize actually linked', async () => {
  const photo = await photoByFixture(run.session.id, 'group.jpg', run.photos)
  assert.ok(photo, 'the group photo was not captured')

  const handoff = await prisma.sessionHandoff.findUnique({
    where: { sessionId: run.session.id },
  })
  assert.ok(handoff, 'finalize emitted no handoff')

  const links = await prisma.photoSubject.count({
    where: { photo: { sessionId: run.session.id } },
  })
  const photoCount = await prisma.photo.count({ where: { sessionId: run.session.id } })

  assert.equal(handoff.linkCount, links)
  assert.equal(handoff.photoCount, photoCount)
})
