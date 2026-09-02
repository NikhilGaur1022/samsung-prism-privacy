import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import sharp from 'sharp'

import { prisma } from '../../src/config/prisma.js'
import { redis } from '../../src/config/redis.js'
import { writeFile, resolvePath } from '../../src/lib/storage.js'
import { closeFaceQueue } from '../../src/lib/faceQueue.js'
import { closeRedactionQueue } from '../../src/lib/redactionQueue.js'
import { closePurgeQueue } from '../../src/lib/purgeQueue.js'
import {
  listErasurePackage,
  confirmErasure,
} from '../../src/modules/dsar/erasurePackage.service.js'
import { summariseOutcome } from '../../src/modules/dsar/certificate.service.js'
import * as dsarService from '../../src/modules/dsar/dsar.service.js'

// The review step, and the gate it puts in front of an irreversible act.
//
// Before this, an erasure ran on a DPO's approval alone: the person who asked for
// it had never been shown what "it" covered, and there was no record that they
// still wanted it once they knew. The three things under test here:
//
//   1. Execution is REFUSED until the principal confirms. Approval is necessary
//      and no longer sufficient.
//   2. The package they review is scoped to their own frames in the named
//      project, and says, per frame, whether it will be destroyed or redacted.
//   3. The counts the certificate reports are the ones the purge actually
//      produced — erased vs redacted, not "locations processed".

const RUN = randomUUID().slice(0, 8)
const fx = { writtenPaths: [] }

async function makeJpeg(seed) {
  return sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: seed % 255, g: 90, b: 140 } },
  })
    .jpeg()
    .toBuffer()
}

async function addPhoto(label) {
  const buffer = await makeJpeg(label.length)
  const storagePath = `sessions/${fx.session.id}/photos/rev-${RUN}-${label}.jpg`
  await writeFile(storagePath, buffer)
  fx.writtenPaths.push(storagePath)

  // A redacted derivative too, because a photo that has been through the pipeline
  // always has one — and discovery only emits an L6 location when redactedPath is
  // set (discovery.service.js:279). Without it there is nothing to re-render for
  // the participants who remain, so a fixture that omits it cannot exercise the
  // rebuild branch at all and quietly tests the wrong thing.
  const redactedPath = `sessions/${fx.session.id}/redacted/rev-${RUN}-${label}.jpg`
  await writeFile(redactedPath, buffer)
  fx.writtenPaths.push(redactedPath)

  return prisma.photo.create({
    data: {
      sessionId: fx.session.id,
      storagePath,
      redactedPath,
      cameraSource: 'IPHONE_UPLOAD',
      sha256: createHash('sha256').update(buffer).digest('hex'),
      mimeType: 'image/jpeg',
      sizeBytes: buffer.length,
    },
  })
}

test.before(async () => {
  const mk = (name, extra = {}) =>
    prisma.subject.create({
      data: {
        fullName: `${name} ${RUN}`,
        email: `${name.toLowerCase()}-${RUN}@test.invalid`,
        group: 'VOLUNTEER',
        status: 'ACTIVE',
        registrationChannel: 'SELF',
        ...extra,
      },
    })

  fx.erasing = await mk('Erasing')
  fx.other = await mk('Bystander')

  fx.agent = await prisma.adminUser.create({
    data: { email: `rev-${RUN}-agent@test.invalid`, role: 'collectionAgent', status: 'ACTIVE' },
  })
  fx.admin = await prisma.adminUser.create({
    data: { email: `rev-${RUN}-admin@test.invalid`, role: 'dataAdmin', status: 'ACTIVE' },
  })

  fx.project = await prisma.project.create({
    data: {
      name: `Review ${RUN}`,
      purpose: 'erasure review fixture',
      status: 'APPROVED',
    },
  })
  // A SECOND project the subject also appears in. It is the control: nothing in
  // the package or the purge may touch it.
  fx.otherProject = await prisma.project.create({
    data: { name: `Untouched ${RUN}`, purpose: 'control', status: 'APPROVED' },
  })

  fx.session = await prisma.session.create({
    data: { code: `REV-${RUN}`, projectId: fx.project.id, agentId: fx.agent.id, status: 'ACTIVE' },
  })
  fx.otherSession = await prisma.session.create({
    data: { code: `CTL-${RUN}`, projectId: fx.otherProject.id, agentId: fx.agent.id, status: 'ACTIVE' },
  })

  // Real consent rows, and their ids go on the photo links below.
  //
  // Not decoration: project-scoped discovery narrows photo links by
  // `consentId IN (this project's consents)`, so a link with a null consentId is
  // invisible to it and would never be erased. Both capture
  // (session.service.js:1228) and import (import.service.js:196) always set it,
  // so a fixture that omits it is testing a state the product cannot produce —
  // and would pass while the real path failed, or vice versa.
  fx.consent = {}
  for (const [key, projectId] of [
    ['project', fx.project.id],
    ['otherProject', fx.otherProject.id],
  ]) {
    const consent = await prisma.projectConsent.create({
      data: {
        subjectId: fx.erasing.masterUserId,
        projectId,
        status: 'ACTIVE',
        policyVersion: 'test-1',
        signatureHash: randomUUID(),
      },
      select: { consentId: true },
    })
    fx.consent[key] = consent.consentId
  }

  // The bystander consents to the erasing subject's project too — they are a
  // lawful participant in the shared frame, which is why it survives.
  fx.otherConsent = (
    await prisma.projectConsent.create({
      data: {
        subjectId: fx.other.masterUserId,
        projectId: fx.project.id,
        status: 'ACTIVE',
        policyVersion: 'test-1',
        signatureHash: randomUUID(),
      },
      select: { consentId: true },
    })
  ).consentId

  // Solo frame: the erasing subject is the only person in it, so it is destroyed.
  fx.solo = await addPhoto('solo')
  await prisma.photoSubject.create({
    data: { photoId: fx.solo.id, subjectId: fx.erasing.masterUserId, consentId: fx.consent.project },
  })

  // Shared frame: a bystander is also in it and has not withdrawn anything, so
  // the frame survives and is rebuilt with the erasing subject blurred.
  fx.shared = await addPhoto('shared')
  await prisma.photoSubject.create({
    data: { photoId: fx.shared.id, subjectId: fx.erasing.masterUserId, consentId: fx.consent.project },
  })
  await prisma.photoSubject.create({
    data: { photoId: fx.shared.id, subjectId: fx.other.masterUserId, consentId: fx.otherConsent },
  })

  // The control frame, in the OTHER project.
  const controlBuffer = await makeJpeg(7)
  const controlPath = `sessions/${fx.otherSession.id}/photos/rev-${RUN}-control.jpg`
  await writeFile(controlPath, controlBuffer)
  fx.writtenPaths.push(controlPath)
  fx.control = await prisma.photo.create({
    data: {
      sessionId: fx.otherSession.id,
      storagePath: controlPath,
      cameraSource: 'IPHONE_UPLOAD',
      sha256: createHash('sha256').update(controlBuffer).digest('hex'),
      mimeType: 'image/jpeg',
      sizeBytes: controlBuffer.length,
    },
  })
  await prisma.photoSubject.create({
    data: { photoId: fx.control.id, subjectId: fx.erasing.masterUserId, consentId: fx.consent.otherProject },
  })

  fx.request = await prisma.dsarRequest.create({
    data: {
      subjectId: fx.erasing.masterUserId,
      projectId: fx.project.id,
      type: 'ERASE',
      status: 'DISCOVERY',
      slaDueAt: new Date(Date.now() + 30 * 86400_000),
    },
  })
})

test.after(async () => {
  for (const p of fx.writtenPaths) {
    await fs.rm(resolvePath(p), { force: true }).catch(() => {})
  }
  const sessionIds = [fx.session?.id, fx.otherSession?.id].filter(Boolean)
  await prisma.photoSubject.deleteMany({ where: { photo: { sessionId: { in: sessionIds } } } })
  await prisma.photo.deleteMany({ where: { sessionId: { in: sessionIds } } })
  await prisma.dsarRequest.deleteMany({ where: { id: fx.request?.id } })
  await prisma.session.deleteMany({ where: { id: { in: sessionIds } } })
  await prisma.projectConsent.deleteMany({
    where: { subjectId: { in: [fx.erasing?.masterUserId, fx.other?.masterUserId].filter(Boolean) } },
  })
  await prisma.project.deleteMany({
    where: { id: { in: [fx.project?.id, fx.otherProject?.id].filter(Boolean) } },
  })
  await prisma.subject.deleteMany({
    where: { masterUserId: { in: [fx.erasing?.masterUserId, fx.other?.masterUserId].filter(Boolean) } },
  })
  await prisma.adminUser.deleteMany({
    where: { id: { in: [fx.agent?.id, fx.admin?.id].filter(Boolean) } },
  })
  await Promise.all([closeFaceQueue(), closeRedactionQueue(), closePurgeQueue(), prisma.$disconnect(), redis.quit()])
})

test('the package is scoped to the named project, and to this subject', async () => {
  const pkg = await listErasurePackage(fx.request.id, fx.erasing.masterUserId)

  const ids = pkg.items.map((i) => i.photoId).sort()
  assert.deepEqual(
    ids,
    [fx.solo.id, fx.shared.id].sort(),
    'the package must contain exactly this project\'s frames',
  )
  // The control frame is in another project the subject has not asked to leave.
  // Including it would show them material this request has no business touching,
  // and would imply it is about to be erased.
  assert.ok(
    !ids.includes(fx.control.id),
    'a frame from a different project leaked into the erasure package',
  )
  assert.equal(pkg.project.id, fx.project.id)
})

test('each frame says whether it will be destroyed or redacted', async () => {
  const pkg = await listErasurePackage(fx.request.id, fx.erasing.masterUserId)
  const solo = pkg.items.find((i) => i.photoId === fx.solo.id)
  const shared = pkg.items.find((i) => i.photoId === fx.shared.id)

  // Sole participant: nothing survives the removal of the link, so the frame goes.
  assert.equal(solo.willBeDeleted, true)
  assert.equal(solo.othersInFrame, 0)

  // Someone else is still lawfully in this frame. Deleting it would destroy THEIR
  // data to honour a request they never made.
  assert.equal(shared.willBeDeleted, false)
  assert.equal(shared.othersInFrame, 1)

  assert.deepEqual(pkg.counts, { total: 2, willBeDeleted: 1, willBeRedacted: 1 })
})

test('another principal cannot open this package', async () => {
  await assert.rejects(
    () => listErasurePackage(fx.request.id, fx.other.masterUserId),
    // A 404, not a 403: confirming the id exists is itself a fact about someone
    // else's request.
    (err) => err.statusCode === 404,
    'a package was served to a principal who does not own the request',
  )
})

test('execution is refused until the principal confirms', async () => {
  await assert.rejects(
    () => dsarService.execute(fx.request.id, fx.admin, { inline: false }),
    (err) => err.statusCode === 409 && /has not confirmed/i.test(err.message),
    'an erasure executed without the principal confirming it',
  )

  // And the refusal must not have advanced the request — a half-transitioned
  // request would be executable on the next attempt without a confirmation.
  const after = await prisma.dsarRequest.findUnique({ where: { id: fx.request.id } })
  assert.equal(after.status, 'DISCOVERY', 'the refused execution still moved the request')
  assert.equal(after.subjectConfirmedAt, null)
})

test('confirming records who agreed, when, and to what', async () => {
  const result = await confirmErasure(fx.request.id, fx.erasing.masterUserId)
  assert.ok(result.request.subjectConfirmedAt, 'no confirmation timestamp was written')
  assert.deepEqual(result.counts, { total: 2, willBeDeleted: 1, willBeRedacted: 1 })

  // The audit chain proves a confirmation HAPPENED. It stores a hash and no
  // payload (invariant 7), so it cannot prove what was confirmed.
  const log = await prisma.auditLog.findFirst({
    where: { entityId: fx.request.id, action: 'ERASURE_CONFIRMED_BY_SUBJECT' },
    orderBy: { createdAt: 'desc' },
  })
  assert.ok(log, 'confirming wrote no audit row')
  assert.ok(log.payloadHash, 'the audit row has no chain hash')

  // DsarEvidence is where the scope lives, in full — that is what the table is
  // for. Authorisation for an irreversible act has to be provable to a regulator,
  // and a hash of "they agreed to something" is not proof of what.
  const evidence = await prisma.dsarEvidence.findFirst({
    where: { dsarRequestId: fx.request.id, kind: 'APPROVAL' },
    orderBy: { createdAt: 'desc' },
  })
  assert.ok(evidence, 'confirming recorded no evidence of what was agreed to')
  assert.equal(evidence.payload.countsShown.total, 2)
  assert.equal(evidence.payload.countsShown.willBeDeleted, 1)
  assert.equal(evidence.payload.photoIds.length, 2, 'the frames shown were not recorded')
  assert.ok(evidence.contentHash, 'the evidence row is unhashed and so not tamper-evident')
})

test('confirming twice is refused', async () => {
  await assert.rejects(
    () => confirmErasure(fx.request.id, fx.erasing.masterUserId),
    (err) => err.statusCode === 409 && /already confirmed/i.test(err.message),
  )
})

test('a confirmed project erasure executes, and certifies at its own scope', async () => {
  const result = await dsarService.execute(fx.request.id, fx.admin, { inline: true })

  assert.equal(result.purgeJob.status, 'COMPLETED', 'the purge did not complete')
  assert.equal(result.purgeJob.scope, 'PROJECT', 'a project request produced a whole-subject purge')

  // The shared frame survives: someone else is still lawfully in it.
  const shared = await prisma.photo.findUnique({ where: { id: fx.shared.id } })
  assert.ok(shared, 'a frame holding another participant was destroyed')
  // ...and the erasing subject's link to it is gone, which is what erasure means
  // for a shared object.
  const link = await prisma.photoSubject.findFirst({
    where: { photoId: fx.shared.id, subjectId: fx.erasing.masterUserId },
  })
  assert.equal(link, null, 'the erased subject is still linked to the shared frame')

  // The solo frame is gone entirely.
  const solo = await prisma.photo.findUnique({ where: { id: fx.solo.id } })
  assert.equal(solo, null, 'a frame with no other participant survived the erasure')

  // The control frame, in a project this request never named, is untouched. This
  // is the regression that motivated project scoping in the first place.
  const control = await prisma.photo.findUnique({ where: { id: fx.control.id } })
  assert.ok(control, "another project's frame was destroyed by a project-scoped erasure")

  // The per-subject key must SURVIVE: it protects the subject's other projects,
  // which they have not asked to erase.
  assert.equal(result.purgeJob.keyDestroyedAt, null, 'a project erasure crypto-shredded the subject')

  fx.certificateId = result.certificateId
  assert.ok(fx.certificateId, `no certificate was issued: ${result.certificateError ?? 'unknown'}`)
})

test('the certificate names the project, the counts, and what it does NOT claim', async () => {
  const certificate = await prisma.deletionCertificate.findUnique({
    where: { id: fx.certificateId },
  })
  assert.ok(certificate, 'the certificate row is missing')
  const p = certificate.payload

  // A distinct type. Signing this as DPDP_ERASURE would assert that everything
  // held about the person is gone, which is false — they still have another
  // project, an identity row and a live key.
  assert.equal(p.certificateType, 'DPDP_PROJECT_ERASURE')
  assert.equal(p.scope, 'PROJECT')
  assert.equal(p.project.id, fx.project.id)
  assert.equal(p.project.name, `Review ${RUN}`)

  // The counts the mentor asked for, and the substance of a shared-object
  // erasure: one destroyed, one kept and rebuilt without this person.
  assert.equal(p.outcome.erased, 1, 'the certificate miscounts what was destroyed')
  assert.equal(p.outcome.redacted, 1, 'the certificate miscounts what was redacted')
  assert.equal(p.outcome.total, 2)

  // The timeline: asked, agreed, done.
  assert.ok(p.requestedAt, 'the certificate does not say when the request was raised')
  assert.ok(p.subjectConfirmedAt, 'the certificate does not say when the principal agreed')
  assert.ok(p.completedAt, 'the certificate does not say when it was carried out')

  // And the honesty clause. The whole-subject note claims the key was destroyed,
  // which would be a false cryptographic guarantee on a signed record here.
  assert.equal(p.keyDestroyed, false)
  assert.match(p.residualNote, /NOT destroyed/)
  assert.ok(
    !/rendering biometric material in those snapshots undecryptable/.test(p.residualNote),
    'the project certificate repeats the whole-subject key-destruction guarantee, which is false at this scope',
  )
})

test('the certificate verifies against the signing key', async () => {
  const { verifyCertificate } = await import('../../src/modules/dsar/certificate.service.js')
  const result = await verifyCertificate(fx.certificateId)
  assert.equal(result.valid, true, 'the issued certificate does not verify')
  assert.equal(result.hashMatches, true)
  assert.equal(result.signatureValid, true)
})

// The counts the certificate reports, derived from purge job rows rather than
// from the database as it stands afterwards.
test('summariseOutcome separates what was destroyed from what was rebuilt', () => {
  const locations = [
    // A photo where the subject was the last one: original DONE.
    { locationCode: 'L2', objectId: 'photo-solo', status: 'DONE' },
    { locationCode: 'L6', objectId: 'photo-solo', status: 'DONE' },
    // A photo others still hold: original SKIPPED, derivative rebuilt.
    { locationCode: 'L2', objectId: 'photo-shared', status: 'SKIPPED' },
    { locationCode: 'L6', objectId: 'photo-shared', status: 'DONE' },
    // A clip, destroyed outright.
    { locationCode: 'L20', objectId: 'clip-1', status: 'DONE' },
    { locationCode: 'L21', objectId: 'clip-1', status: 'DONE' },
  ]

  const outcome = summariseOutcome(locations)
  assert.equal(outcome.erased, 2, 'destroyed objects were miscounted')
  assert.equal(outcome.redacted, 1, 'rebuilt objects were miscounted')
  assert.equal(outcome.total, 3)
  // Each object is counted once, under its original's row — counting the rebuild
  // row too would double every figure.
  assert.deepEqual(outcome.byMedium.photo, { erased: 1, redacted: 1 })
  assert.deepEqual(outcome.byMedium.video, { erased: 1, redacted: 0 })
})

test('a SKIPPED original with no rebuild is not counted as redacted', () => {
  // The dangerous miscount: the original was kept but nothing was re-rendered, so
  // the subject is still visible in the derivative. Reporting that as "redacted"
  // on a signed certificate would be a false statement.
  const outcome = summariseOutcome([
    { locationCode: 'L2', objectId: 'photo-x', status: 'SKIPPED' },
    { locationCode: 'L6', objectId: 'photo-x', status: 'FAILED' },
  ])
  assert.equal(outcome.redacted, 0)
  assert.equal(outcome.erased, 0)
})
