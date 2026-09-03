import test from 'node:test'
import assert from 'node:assert/strict'

import { prisma } from '../../src/config/prisma.js'
import { fileExists } from '../../src/lib/storage.js'
import * as dsarService from '../../src/modules/dsar/dsar.service.js'
import * as consentService from '../../src/modules/consent/consent.service.js'
import { runDiscovery } from '../../src/modules/dsar/discovery.service.js'
import { verifyCertificate } from '../../src/modules/dsar/certificate.service.js'
import {
  confirmErasure,
  listErasurePackage,
} from '../../src/modules/dsar/erasurePackage.service.js'
import {
  buildWorld,
  checkPreconditions,
  closeResources,
  destroyWorld,
  photoByFixture,
  runSession,
} from './world.js'

// WAVE 5.2 — erasure, on a photo that holds two people.
//
// The single property this file exists to defend: erasure is per PhotoSubject
// link, never per photo (invariant 5). When A erases from a frame that also holds
// B, the frame must survive for B, must be rebuilt with A blurred, and must never
// be handed to a delete. Everything else here — the certificate, the crypto
// shred, the audit trail — is downstream of getting that right.

let world
let run
let groupPhotoBefore
let soloPhotoBefore
let blocked = null

test.before(async () => {
  blocked = await checkPreconditions()
  if (blocked) return

  world = await buildWorld()
  run = await runSession(world)

  groupPhotoBefore = await photoByFixture(run.session.id, 'group.jpg', run.photos)
  soloPhotoBefore = await photoByFixture(run.session.id, 'solo-a.jpg', run.photos)
})

test.after(async () => {
  // See full-lifecycle.test.js: closeResources has to run even when cleanup
  // throws, or the file hangs instead of reporting why.
  try {
    await destroyWorld(world)
  } finally {
    await closeResources()
  }
})

test('preconditions', () => {
  assert.equal(blocked, null, `end-to-end dependencies are not available: ${blocked}`)
})

test('the fixture actually puts two consented people on one photo', () => {
  const subjectsOnGroup = new Set(groupPhotoBefore.subjects.map((s) => s.subjectId))
  assert.equal(
    subjectsOnGroup.size,
    2,
    `group.jpg links ${subjectsOnGroup.size} subject(s); this suite proves nothing unless it links 2`,
  )
  assert.ok(subjectsOnGroup.has(world.subjects.a.masterUserId))
  assert.ok(subjectsOnGroup.has(world.subjects.b.masterUserId))
})

test('discovery finds the subject everywhere and flags the shared photo', async () => {
  const discovery = await runDiscovery(world.subjects.a.masterUserId)

  const codes = new Set(discovery.locations.map((l) => l.locationCode))
  for (const expected of ['L2', 'L3', 'L4', 'L5', 'L6']) {
    assert.ok(codes.has(expected), `discovery missed location ${expected}`)
  }

  assert.ok(
    discovery.multiSubjectPhotos.some(
      (p) => (p.photoId ?? p.id ?? p) === groupPhotoBefore.id,
    ),
    'discovery did not flag the shared photo — the purge would be free to delete it',
  )
})

test('erasure runs to completion and issues a signed certificate', async () => {
  const request = await dsarService.createRequest({
    subjectId: world.subjects.a.masterUserId,
    type: 'ERASE',
    description: 'End-to-end erasure of subject A.',
  })

  await dsarService.assign(
    request.id,
    { assignedAdminId: world.admins.dataAdmin.id },
    world.admins.dpo,
  )
  await dsarService.runDiscoveryForRequest(request.id, world.admins.dataAdmin)

  // The principal authorises their own erasure. assertSubjectConfirmed() refuses
  // execute() until this has happened, which is the whole point of the review
  // gate — an operator's approval says the request is lawful, not that the
  // person still wants it having seen what it covers.
  //
  // This test predates the gate and drove execute() straight off discovery, so
  // it has been failing (and taking the four assertions below with it) since the
  // gate shipped. Walking the real path is also the stronger test: the manifest
  // the principal is shown is built from the same scoping query the purge
  // re-derives from, so a drift between them now fails here.
  const review = await listErasurePackage(request.id, world.subjects.a.masterUserId)
  assert.ok(
    review.counts.total > 0,
    'the review package was empty — the principal would be asked to authorise nothing',
  )
  await confirmErasure(request.id, world.subjects.a.masterUserId)

  const result = await dsarService.execute(request.id, world.admins.dataAdmin)

  assert.equal(
    result.purgeJob.status,
    'COMPLETED',
    `purge did not complete: ${JSON.stringify(result.purgeJob.status)}`,
  )
  assert.ok(result.certificateId, 'a completed purge issued no deletion certificate')

  world.erasure = { requestId: request.id, ...result }
})

test("A's data is gone", async () => {
  const subjectId = world.subjects.a.masterUserId

  assert.equal(
    await prisma.photoSubject.count({ where: { subjectId } }),
    0,
    'photo links survived the erasure',
  )
  assert.equal(
    await prisma.subjectFaceEnrollment.count({ where: { subjectId, deletedAt: null } }),
    0,
    'live enrolment rows survived the erasure',
  )
  assert.equal(
    await prisma.sessionParticipant.count({ where: { subjectId } }),
    0,
    'roster entries survived the erasure',
  )

  assert.equal(
    await fileExists(world.enrollments.a.imagePath),
    false,
    "A's enrolment selfie is still on disk",
  )

  const subject = await prisma.subject.findUnique({ where: { masterUserId: subjectId } })
  assert.equal(subject.status, 'ERASED')

  // Crypto-shred: the per-subject DEK is what makes backup copies unrecoverable.
  const key = await prisma.subjectKey.findUnique({ where: { subjectId } })
  assert.ok(!key || key.destroyedAt, 'the per-subject key was never destroyed')

  const solo = await prisma.photo.findUnique({ where: { id: soloPhotoBefore.id } })
  if (solo) {
    assert.equal(
      await fileExists(solo.storagePath),
      false,
      'the solo original survived even though nobody is left on it',
    )
  }
})

test("B's data is untouched — the shared photo survived and was re-redacted", async () => {
  const subjectB = world.subjects.b.masterUserId

  const photo = await prisma.photo.findUnique({
    where: { id: groupPhotoBefore.id },
    include: { subjects: true },
  })
  assert.ok(photo, 'invariant 5 broken: the shared photo was deleted along with A')

  assert.deepEqual(
    photo.subjects.map((s) => s.subjectId),
    [subjectB],
    'the shared photo should be left holding exactly B',
  )

  assert.ok(
    await fileExists(photo.storagePath),
    "the shared photo's original was deleted while B still holds consent to it",
  )
  assert.ok(photo.redactedPath, 'the shared photo has no derivative left to serve')
  assert.ok(await fileExists(photo.redactedPath), 'the rebuilt derivative was never written')

  // Rebuilt, not merely retained: a rebuild that failed parks the photo as
  // DEFERRED, which would leave B with nothing serveable at all.
  assert.notEqual(photo.piiStatus, 'DEFERRED', 'the rebuild failed and left the photo unserveable')
  assert.notEqual(photo.piiStatus, 'FAILED', 'the rebuild failed and left the photo unserveable')

  assert.equal(
    await prisma.subjectFaceEnrollment.count({ where: { subjectId: subjectB, deletedAt: null } }),
    1,
    "B's enrolment was collaterally erased",
  )
  const consentB = await prisma.projectConsent.findUnique({
    where: {
      subjectId_projectId: { subjectId: subjectB, projectId: world.project.id },
    },
  })
  assert.equal(consentB.status, 'ACTIVE', "B's consent row was collaterally revoked")
})

test("A's face crops are gone but B's remain", async () => {
  const faces = await prisma.faceDetection.findMany({
    where: { photoId: groupPhotoBefore.id },
    select: { id: true, cropPath: true, taggedSubjectId: true },
  })

  for (const face of faces) {
    if (face.taggedSubjectId === world.subjects.a.masterUserId) {
      assert.fail("a face crop is still tagged to the erased subject")
    }
  }

  for (const face of groupPhotoBefore.faces) {
    if (face.taggedSubjectId !== world.subjects.a.masterUserId) continue
    assert.equal(
      face.cropPath ? await fileExists(face.cropPath) : false,
      false,
      "an erased subject's face crop is still on disk",
    )
  }
})

test('the certificate verifies, and names nobody', async () => {
  const certificate = await prisma.deletionCertificate.findUnique({
    where: { id: world.erasure.certificateId },
  })
  assert.ok(certificate)

  const verdict = await verifyCertificate(certificate.id)
  assert.equal(verdict.hashMatches, true, 'the stored payload no longer hashes to payloadHash')
  assert.equal(verdict.signatureValid, true, 'the Ed25519 signature does not verify')

  const json = JSON.stringify(certificate.payload)
  assert.doesNotMatch(json, new RegExp(world.subjects.a.fullName), 'the certificate names the subject')
  assert.doesNotMatch(json, new RegExp(world.subjects.a.email), "the certificate carries the subject's email")
  assert.doesNotMatch(
    json,
    new RegExp(world.subjects.a.masterUserId),
    'the certificate carries the raw subject id instead of a pseudonym',
  )
  assert.ok(certificate.subjectPseudonym, 'the certificate has no pseudonym to identify the erasure by')

  // Every location carries the hash captured before its object was destroyed —
  // without it the certificate attests to nothing.
  const hashed = certificate.payload.locations.filter((l) => l.hashBefore)
  assert.ok(hashed.length > 0, 'no location recorded a pre-deletion hash')

  assert.match(
    certificate.payload.residualNote,
    /backup/i,
    'the certificate does not state the backup residual honestly',
  )
})

test('withdrawing consent raises an erasure by itself (DPDP §6(4))', async () => {
  const subjectB = world.subjects.b.masterUserId

  const before = await prisma.dsarRequest.count({ where: { subjectId: subjectB } })
  await consentService.revokeConsent(subjectB, world.project.id)

  const raised = await prisma.dsarRequest.findFirst({
    where: { subjectId: subjectB, type: 'WITHDRAWAL_ERASURE' },
  })
  assert.ok(
    raised,
    'a withdrawal produced no erasure request — the data would sit there after consent ended',
  )
  assert.equal(raised.autoRaised, true)
  assert.ok(
    (await prisma.dsarRequest.count({ where: { subjectId: subjectB } })) > before,
  )

  const consent = await prisma.projectConsent.findUnique({
    where: { subjectId_projectId: { subjectId: subjectB, projectId: world.project.id } },
  })
  assert.equal(consent.status, 'REVOKED')
})

test('the erasure left an audit trail with no plaintext in it', async () => {
  const rows = await prisma.auditLog.findMany({
    where: { entityType: 'DsarRequest', entityId: world.erasure.requestId },
  })
  assert.ok(rows.length > 0, 'the erasure wrote no audit entries')

  const actions = new Set(rows.map((r) => r.action))
  assert.ok(actions.has('DSAR_RAISED'))
  assert.ok(actions.has('DELETION_CERTIFICATE_ISSUED'))

  for (const row of rows) {
    assert.match(row.payloadHash, /^[0-9a-f]{64}$/)
    assert.equal(
      Object.prototype.hasOwnProperty.call(row, 'payload'),
      false,
      'invariant 7: an audit row carries payload plaintext',
    )
  }
})
