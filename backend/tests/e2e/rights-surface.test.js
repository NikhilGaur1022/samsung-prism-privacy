import test from 'node:test'
import assert from 'node:assert/strict'

import { prisma } from '../../src/config/prisma.js'
import * as meService from '../../src/modules/me/me.service.js'
import * as sessionService from '../../src/modules/sessions/session.service.js'
import * as projectService from '../../src/modules/projects/project.service.js'
import * as dsarService from '../../src/modules/dsar/dsar.service.js'
import * as dashboardService from '../../src/modules/dashboard/dashboard.service.js'
import { buildAccessPackage, downloadPackage, issuePackageToken } from '../../src/modules/dsar/export.service.js'
import { buildWorld, checkPreconditions, closeResources, destroyWorld, runSession } from './world.js'

// WAVE 6 — the rights and oversight surface added on top of the wave-5 pipeline.
//
// These endpoints exist because a principal could not answer "how many photos am
// I in" without filing a 30-day request, an owner could not see what their own
// project collected, and an auditor could not see the evidence vault without
// first naming a request. Each one is a read across data the rest of the platform
// already guards, so what this file actually tests is the scoping: who sees what,
// and — more importantly — what never appears in a response at all.

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
  try {
    await destroyWorld(world)
  } finally {
    await closeResources()
  }
})

test('preconditions', () => {
  assert.equal(blocked, null, `end-to-end dependencies are not available: ${blocked}`)
})

// ---------------------------------------------------------------------------
// DPDP §11 — the principal's own view
// ---------------------------------------------------------------------------

test('a principal can count the photos they appear in, and sees only their own links', async () => {
  const a = world.subjects.a.masterUserId
  const b = world.subjects.b.masterUserId

  const mine = await meService.summariseMyPhotos(a)

  const linkCount = await prisma.photoSubject.count({ where: { subjectId: a } })
  assert.equal(mine.totalPhotos, linkCount, 'the §11 count must equal the link rows erasure would destroy')
  assert.ok(mine.totalPhotos > 0, 'the fixture did not link subject A to any photo')
  assert.equal(mine.projectCount, 1)

  const group = mine.projects[0]
  assert.equal(group.project.id, world.project.id)
  assert.equal(group.project.purpose, world.project.purpose)
  assert.ok(group.consent.consentId, 'the purpose a photo was collected under must be visible with it')

  // Nothing in the response may name the other principal on the same frame.
  const serialized = JSON.stringify(mine)
  assert.ok(!serialized.includes(b), "another principal's id appeared in the §11 response")
  assert.ok(
    !serialized.includes(world.subjects.b.fullName),
    "another principal's name appeared in the §11 response",
  )

  // Nor may it name where anything is stored.
  assert.ok(!/storagePath|redactedPath|storage\//.test(serialized), 'a storage path leaked into the §11 response')

  // Nor may it identify an individual photograph. §11 is a summary right; the
  // material comes from an approved ACCESS package. A photo id here would let a
  // portal — or anyone with a stolen session cookie — enumerate the dataset,
  // which is what this response used to permit.
  const linkedIds = await prisma.photoSubject.findMany({
    where: { subjectId: a },
    select: { photoId: true, photo: { select: { sessionId: true } } },
  })
  for (const link of linkedIds) {
    assert.ok(!serialized.includes(link.photoId), 'a photo id leaked into the §11 summary')
    assert.ok(!serialized.includes(link.photo.sessionId), 'a session id leaked into the §11 summary')
  }
  assert.ok(!/"viewable"|"photos"\s*:\s*\[/.test(serialized), 'the §11 summary carried per-photo rows')

  // What it must still carry: the numbers, so the principal can tell whether the
  // count is right and challenge it if not.
  assert.equal(group.photoCount, mine.totalPhotos)
  assert.ok(group.sessionCount >= 1)
  assert.ok(mine.firstCollectedAt instanceof Date, 'the summary must say when collection happened')
})

test('there is no subject-facing route that serves a photograph', async () => {
  // The §11 read channel was removed rather than narrowed, so the assertion is
  // about absence: neither the service function nor the route may come back
  // without this failing. rbac-matrix.test.js covers the mount; this covers the
  // module surface, because an export with no route is one line away from one.
  assert.equal(
    sessionService.readPersonRedactedPhotoForSubject,
    undefined,
    'a subject-facing photo reader is exported again — material must come from an approved ACCESS package',
  )

  // And the package path still works, which is what makes the removal a
  // redirection of the access right rather than a removal of it.
  assert.equal(typeof buildAccessPackage, 'function')
})

// ---------------------------------------------------------------------------
// Project-scoped oversight
// ---------------------------------------------------------------------------

test('a data owner can see their own project\'s sessions, with counts and no identities', async () => {
  const { items } = await projectService.listProjectSessions(world.project.id, world.admins.dataOwner)

  const session = items.find((s) => s.id === run.session.id)
  assert.ok(session, 'the session the fixture captured is missing from the project view')
  assert.equal(session.photoCount, run.photos.length)
  assert.equal(session.participantCount, 2)
  assert.equal(session.status, 'ARCHIVED')

  const serialized = JSON.stringify(items)
  for (const key of ['a', 'b']) {
    assert.ok(
      !serialized.includes(world.subjects[key].masterUserId),
      'a participant id leaked into the project session view',
    )
    assert.ok(
      !serialized.includes(world.subjects[key].fullName),
      'a participant name leaked into the project session view',
    )
  }
})

test('a data owner cannot read a project they do not own', async () => {
  const other = await prisma.adminUser.create({
    data: { email: `e2e-${world.tag}-other-owner@test.invalid`, role: 'dataOwner', status: 'ACTIVE' },
  })

  try {
    for (const call of [
      () => projectService.listProjectSessions(world.project.id, other),
      () => projectService.listProjectHandoffs(world.project.id, other),
      () => projectService.getProjectReport(world.project.id, other),
    ]) {
      await assert.rejects(call, (err) => err.statusCode === 403)
    }
  } finally {
    await prisma.adminUser.delete({ where: { id: other.id } })
  }
})

test('the project report counts what is actually in the database', async () => {
  const report = await projectService.getProjectReport(world.project.id, world.admins.dataOwner)

  const [photos, links, activeConsents] = await Promise.all([
    prisma.photo.count({ where: { session: { projectId: world.project.id } } }),
    prisma.photoSubject.count({ where: { photo: { session: { projectId: world.project.id } } } }),
    prisma.projectConsent.count({ where: { projectId: world.project.id, status: 'ACTIVE' } }),
  ])

  assert.equal(report.collection.photos, photos)
  assert.equal(report.collection.photoSubjectLinks, links)
  assert.equal(report.consent.active, activeConsents)
  assert.equal(report.project.status, 'APPROVED')

  // blockedFrames is the number that decides whether anything can be handed off.
  const deferred = await prisma.photo.count({
    where: { session: { projectId: world.project.id }, piiStatus: { in: ['DEFERRED', 'FAILED'] } },
  })
  assert.equal(report.collection.blockedFrames, deferred)
})

// ---------------------------------------------------------------------------
// Evidence vault and break-glass targeting
// ---------------------------------------------------------------------------

test('the evidence vault lists content hashes and never a payload or a path', async () => {
  const request = await dsarService.createRequest({
    subjectId: world.subjects.a.masterUserId,
    type: 'ACCESS',
    description: 'e2e vault listing',
    projectId: world.project.id,
  })

  await buildAccessPackage(request.id, world.admins.dataAdmin)

  const items = await dsarService.listEvidenceVault(
    { admin: world.admins.dataAdmin },
    { kind: 'EXPORT_PACKAGE' },
  )

  const row = items.find((e) => e.dsarRequestId === request.id)
  assert.ok(row, 'the package just built is not in the vault index')
  assert.ok(row.contentHash, 'the vault index is useless without the tamper-evidence hash')
  assert.equal(row.hasFile, true)

  // The EXPORT_PACKAGE payload holds a live download token hash. Returning the
  // payload would hand every vault reader the means to redeem someone else's
  // package, so the field must not survive the projection.
  assert.equal(row.payload, undefined, 'the evidence payload leaked into the vault index')
  assert.equal(row.storagePath, undefined, 'a storage path leaked into the vault index')
  assert.ok(!JSON.stringify(row).includes(world.subjects.a.masterUserId), 'the vault index named the principal')
  assert.ok(row.subjectRef, 'the vault index must carry a pseudonym in place of the identity')

  world.vaultRequestId = request.id
})

test('break-glass targeting lists only the frames the request\'s own subject is on', async () => {
  const request = await prisma.dsarRequest.findUnique({ where: { id: world.vaultRequestId } })
  const result = await dsarService.listSubjectMedia(request.id, world.admins.dataAdmin)

  const expected = await prisma.photoSubject.count({ where: { subjectId: world.subjects.a.masterUserId } })
  assert.equal(result.items.length, expected)

  for (const item of result.items) {
    const links = await prisma.photoSubject.findMany({
      where: { photoId: item.photoId },
      select: { subjectId: true },
    })
    assert.ok(
      links.some((l) => l.subjectId === world.subjects.a.masterUserId),
      'a frame the request subject is not on was offered as a break-glass target',
    )
    // An operator about to justify break-glass on a shared frame has to be able
    // to see that it is shared.
    assert.equal(item.subjectsOnPhoto, links.length)
  }

  assert.ok(
    !JSON.stringify(result).includes(world.subjects.b.masterUserId),
    'the co-subject on a shared frame was named in the targeting response',
  )

  // A dataOwner is not an erasure operator and must not be able to enumerate media.
  await assert.rejects(
    () => dsarService.listSubjectMedia(request.id, world.admins.dataOwner),
    (err) => err.statusCode === 403,
  )
})

// ---------------------------------------------------------------------------
// The §11 package, delivered to the principal
// ---------------------------------------------------------------------------

test('a principal can mint a download token, and it is spent on first use', async () => {
  const requestId = world.vaultRequestId
  const a = world.subjects.a.masterUserId

  const issued = await issuePackageToken(requestId, a)
  assert.ok(issued.token && issued.token.length >= 20)
  assert.ok(new Date(issued.expiresAt) > new Date())

  const { buffer, filename } = await downloadPackage(requestId, issued.token, { subjectId: a })
  assert.ok(buffer.length > 0)
  assert.match(filename, /\.zip$/)

  // Single-use is the property: a link that has been clicked is spent, even
  // though the principal can always mint another.
  await assert.rejects(
    () => downloadPackage(requestId, issued.token, { subjectId: a }),
    (err) => err.statusCode === 410,
    'a spent download token was accepted a second time',
  )

  const again = await issuePackageToken(requestId, a)
  assert.notEqual(again.token, issued.token, 'a re-issued token must not repeat the spent one')
})

test('a principal cannot mint a token for another principal\'s request', async () => {
  await assert.rejects(
    () => issuePackageToken(world.vaultRequestId, world.subjects.b.masterUserId),
    (err) => err.statusCode === 403,
  )
})

// ---------------------------------------------------------------------------
// Compliance report
// ---------------------------------------------------------------------------

test('the compliance report is scoped by role and never claims a rate it cannot support', async () => {
  const dpoReport = await dashboardService.getComplianceReport(world.admins.dpo)

  assert.ok(dpoReport.period.from && dpoReport.period.to)
  assert.equal(dpoReport.scope.projectIds, 'ALL')
  assert.equal(typeof dpoReport.access.events, 'number')
  assert.equal(typeof dpoReport.dsar.open, 'number')

  // Null, not 0% and not 100%, when nothing closed in the window. A rate derived
  // from an empty set is a claim the data does not support, and this report is
  // shown to a regulator.
  if (dpoReport.dsar.closed === 0) {
    assert.equal(dpoReport.dsar.onTimeRate, null)
    assert.equal(dpoReport.dsar.medianDaysToClose, null)
  }

  const ownerReport = await dashboardService.getComplianceReport(world.admins.dataOwner)
  assert.ok(Array.isArray(ownerReport.scope.projectIds), 'a data owner report must be scoped to owned projects')
  assert.ok(ownerReport.scope.projectIds.includes(world.project.id))

  await assert.rejects(
    () => dashboardService.getComplianceReport(world.admins.collectionAgent),
    (err) => err.statusCode === 403,
    'a collection agent was allowed to generate an accountability report',
  )
})
