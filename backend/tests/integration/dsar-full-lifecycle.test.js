import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'

import { prisma } from '../../src/config/prisma.js'
import { closeRedactionQueue } from '../../src/lib/redactionQueue.js'
import { closeItemActionQueue } from '../../src/lib/itemActionQueue.js'
import { fileExists, shredFile } from '../../src/lib/storage.js'
import * as importService from '../../src/modules/import/import.service.js'
import { listItemsForRequest, searchSubjects } from '../../src/modules/dsar/itemSearch.service.js'
import { requestActions, listActions } from '../../src/modules/dsar/itemAction.service.js'
import { buildAccessPackage } from '../../src/modules/dsar/export.service.js'
import { closeRequest } from '../../src/modules/dsar/dsar.service.js'
import { getRequestTimeline, getSubjectTimeline } from '../../src/modules/dsar/timeline.service.js'
import { runDiscovery } from '../../src/modules/dsar/discovery.service.js'
import { indexSubject } from '../../src/modules/dsar/itemIndex.service.js'

// PLAN Phase 9's acceptance test: one request driven the whole way through the
// system that Phases 3–7 built —
//
//   import → search → per-item redact → bulk delete → selective export → close
//   → timeline (operator) → timeline (principal)
//
// Each earlier phase has its own file that proves its own contract in isolation.
// This one exists because those contracts have to hold *composed*, and three of
// them only interact here:
//
//   * an IMPORTED item must be findable by a search that was written against
//     collected data, and must survive into a package;
//   * a bulk DELETE that lands on a shared frame must come back as a redaction
//     with the refusal on the record, not as a silent smaller number;
//   * the close guard must see the deletes finish before it will let the request
//     be declared discharged.
//
// Needs the database, the media store and Redis. Not under tests/e2e/ on
// purpose: it drives services directly and needs no face worker, no Qdrant and
// no image-pii worker, so it runs in the ordinary suite.
//   node --test tests/integration/dsar-full-lifecycle.test.js

const RUN = randomUUID().slice(0, 8)

const ids = {
  admin: randomUUID(),
  project: randomUUID(),
  session: randomUUID(),
  subject: randomUUID(),
  bystander: randomUUID(),
  request: randomUUID(),
}

const dataAdmin = { id: ids.admin, role: 'dataAdmin' }

const COLLECTED_SOLO = 2
const COLLECTED_SHARED = 1
const IMPORTED = 2
const EXPECTED_ITEMS = COLLECTED_SOLO + COLLECTED_SHARED + IMPORTED

const writtenPaths = []
const importedPhotoIds = []
let batchId = null

async function jpeg(seed) {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: seed, g: 60, b: 120 } },
  })
    .jpeg()
    .toBuffer()
}

async function seedSubject(masterUserId, name) {
  await prisma.subject.create({
    data: {
      masterUserId,
      group: 'VOLUNTEER',
      status: 'ACTIVE',
      fullName: `${RUN} ${name}`,
      email: `${name.toLowerCase()}-${RUN}@lifecycle.test`,
      registrationChannel: 'AGENT',
    },
  })
  return prisma.projectConsent.create({
    data: {
      subjectId: masterUserId,
      projectId: ids.project,
      status: 'ACTIVE',
      policyVersion: 'v1',
      signatureHash: 'test',
    },
  })
}

test.before(async () => {
  await prisma.adminUser.create({
    data: { id: ids.admin, email: `admin-${RUN}@lifecycle.test`, role: 'dataAdmin', status: 'ACTIVE' },
  })
  await prisma.project.create({
    data: {
      id: ids.project,
      name: `lifecycle ${RUN}`,
      purpose: 'testing',
      status: 'ACTIVE',
      ownerAdminId: ids.admin,
    },
  })

  const consent = await seedSubject(ids.subject, 'Meenakshi')
  const bystanderConsent = await seedSubject(ids.bystander, 'Ravindra')

  await prisma.session.create({
    data: {
      id: ids.session,
      code: `LC-${randomUUID().slice(0, 8)}`,
      projectId: ids.project,
      agentId: ids.admin,
      status: 'ARCHIVED',
    },
  })

  // The collected leg. The last frame carries a bystander, which is what makes
  // the delete downgrade reachable.
  for (let n = 0; n < COLLECTED_SOLO + COLLECTED_SHARED; n += 1) {
    const storagePath = `sessions/${ids.session}/original/${RUN}-${n}.jpg`
    const redactedPath = `sessions/${ids.session}/redacted/${RUN}-${n}.jpg`
    const { writeFile } = await import('../../src/lib/storage.js')
    await writeFile(storagePath, await jpeg(n * 20))
    await writeFile(redactedPath, await jpeg(n * 20 + 5))
    writtenPaths.push(storagePath, redactedPath)

    const photo = await prisma.photo.create({
      data: {
        sessionId: ids.session,
        storagePath,
        redactedPath,
        piiStatus: 'CLEAN',
        cameraSource: 'IPHONE_UPLOAD',
        sha256: `${RUN}-collected-${n}-${randomUUID()}`,
        mimeType: 'image/jpeg',
        sizeBytes: 2048,
        takenAt: new Date(Date.UTC(2026, 6, 15, 9, n)),
      },
    })
    await prisma.photoSubject.create({
      data: { photoId: photo.id, subjectId: ids.subject, consentId: consent.consentId },
    })
    if (n >= COLLECTED_SOLO) {
      await prisma.photoSubject.create({
        data: { photoId: photo.id, subjectId: ids.bystander, consentId: bystanderConsent.consentId },
      })
    }
  }

  await prisma.dsarRequest.create({
    data: {
      id: ids.request,
      subjectId: ids.subject,
      type: 'ACCESS',
      status: 'DISCOVERY',
      channel: 'PORTAL',
      assignedAdminId: ids.admin,
      slaDueAt: new Date(Date.now() + 30 * 86_400_000),
    },
  })

  await indexSubject(ids.subject)
  await indexSubject(ids.bystander)
})

test.after(async () => {
  try {
    const packages = await prisma.dsarEvidence.findMany({
      where: { dsarRequestId: ids.request, storagePath: { not: null } },
      select: { storagePath: true },
    })
    const imported = await prisma.photo.findMany({
      where: { id: { in: importedPhotoIds } },
      select: { storagePath: true, redactedPath: true },
    })
    const paths = [
      ...packages.map((p) => p.storagePath),
      ...imported.flatMap((p) => [p.storagePath, p.redactedPath].filter(Boolean)),
      ...writtenPaths,
    ]
    for (const p of paths) if (await fileExists(p)) await shredFile(p)

    // access_events is append-only for prism_app — never cleaned here, and a
    // deleteMany would abort teardown before the fixtures below were removed.
    await prisma.dsarRequest.deleteMany({ where: { id: ids.request } })
    await prisma.subject.deleteMany({
      where: { masterUserId: { in: [ids.subject, ids.bystander] } },
    })
    await prisma.photo.deleteMany({ where: { id: { in: importedPhotoIds } } })
    await prisma.session.deleteMany({ where: { id: ids.session } })
    await prisma.project.deleteMany({ where: { id: ids.project } })
    await prisma.adminUser.deleteMany({ where: { id: ids.admin } })
  } finally {
    await Promise.allSettled([closeRedactionQueue(), closeItemActionQueue()])
    await prisma.$disconnect()
  }
})

test('1 — import brings pre-existing data in, flagged as unverified', async () => {
  const batch = await importService.createBatch({ subjectId: ids.subject }, dataAdmin)
  batchId = batch.id

  for (let n = 0; n < IMPORTED; n += 1) {
    const result = await importService.ingestItem(
      { batchId: batch.id, file: { buffer: await jpeg(200 + n), mimetype: 'image/jpeg' } },
      dataAdmin,
    )
    assert.equal(result.duplicate, false)
    assert.equal(result.lawfulBasis, 'IMPORT_UNVERIFIED')
    importedPhotoIds.push(result.photoId)
  }

  const closed = await importService.closeBatch(batch.id, {}, dataAdmin)
  assert.equal(closed.status, 'CLOSED')
  assert.equal(closed.itemsDone, IMPORTED)
})

test('2 — the imported data is reachable by identity search and by discovery', async () => {
  const found = await searchSubjects({ q: `${RUN} Meenakshi` }, { admin: dataAdmin })
  const hit = found.items.find((s) => s.subjectId === ids.subject)

  assert.ok(hit, 'the subject must be findable by an exact name')
  assert.equal(hit.itemCount, EXPECTED_ITEMS, 'the count must include the imported items')

  // The discovery walk is the independent second opinion on the index. If they
  // disagree, the completeness claim is only as good as whichever one is right.
  const discovery = await runDiscovery(ids.subject)
  const l2 = discovery.locations.filter((l) => l.locationCode === 'L2')
  for (const photoId of importedPhotoIds) {
    assert.ok(
      l2.some((l) => l.objectId === photoId),
      'an imported frame that discovery cannot name is a frame an erasure would miss',
    )
  }
})

test('3 — the item grid reports the whole holding, not the page', async () => {
  const page = await listItemsForRequest(ids.request, dataAdmin, { limit: 2 })

  assert.equal(page.items.length, 2)
  assert.equal(page.totals.all, EXPECTED_ITEMS, 'totals.all is the completeness claim')
  assert.equal(page.totals.byOrigin.IMPORT, IMPORTED)
  assert.equal(page.index.consistent, true)
  // Pseudonymous and path-free: a dpo works this same screen.
  assert.ok(page.subjectRef?.startsWith('SUB-'))
  assert.equal(page.items[0].storagePath, undefined)
})

test('4 — a per-item redact is recorded, then executed', async () => {
  const items = await prisma.subjectDataItem.findMany({
    where: { subjectId: ids.subject, deletedAt: null, origin: 'IMPORT' },
  })

  const batch = await requestActions(
    {
      dsarRequestId: ids.request,
      itemIds: [items[0].id],
      kind: 'REDACT',
      reason: 'masking pass before release',
    },
    dataAdmin,
    { inline: true },
  )

  assert.equal(batch.summary.requested, 1)
  const rows = await prisma.dsarItemAction.findMany({ where: { batchId: batch.batchId } })
  assert.equal(rows.length, 1)
  assert.ok(['DONE', 'SKIPPED'].includes(rows[0].status), 'the action must reach a terminal state')
})

test('5 — a bulk delete spares the shared frame and says so', async () => {
  const items = await prisma.subjectDataItem.findMany({
    where: { subjectId: ids.subject, deletedAt: null },
  })
  const shared = items.filter((i) => i.sharedSubjectCount > 1)
  assert.equal(shared.length, COLLECTED_SHARED, 'the fixture must contain a shared frame')

  const batch = await requestActions(
    {
      dsarRequestId: ids.request,
      itemIds: items.map((i) => i.id),
      kind: 'DELETE',
      reason: 'erasure of everything held for this principal',
    },
    dataAdmin,
    { inline: true },
  )

  assert.equal(
    batch.summary.downgraded,
    COLLECTED_SHARED,
    'a delete on a frame holding another principal must become a redaction',
  )

  const rows = await prisma.dsarItemAction.findMany({ where: { batchId: batch.batchId } })
  const refused = rows.filter((r) => r.kind === 'DELETE' && r.status === 'SKIPPED')
  assert.equal(refused.length, COLLECTED_SHARED)
  assert.match(
    refused[0].error,
    /other data principal/i,
    'a refused delete must carry the reason — an operator who asked for a deletion is owed the news that they did not get one',
  )

  // And the downgrade is a real REDACT row, not just a note on the refusal.
  assert.ok(rows.some((r) => r.kind === 'REDACT' && r.reason?.includes('downgrade')))

  const tombstoned = await prisma.subjectDataItem.count({
    where: { subjectId: ids.subject, deletedAt: { not: null } },
  })
  assert.ok(tombstoned > 0, 'a deleted item must survive as a tombstone so the timeline can prove it existed')

  // No certificate: a scoped item deletion is not a whole-subject erasure, and
  // signing one would be a false statement.
  const scoped = await prisma.purgeJob.findMany({
    where: { dsarRequestId: ids.request, scope: 'PARTIAL' },
  })
  assert.ok(scoped.length > 0, 'a delete should have planned at least one scoped purge job')
  const certificate = await prisma.deletionCertificate.findUnique({
    where: { dsarRequestId: ids.request },
  })
  assert.equal(certificate, null, 'a scoped deletion must never be certifiable as a full erasure')
})

test('6 — a narrowed package says on its face that it is narrowed', async () => {
  const surviving = await prisma.subjectDataItem.findMany({
    where: { subjectId: ids.subject, deletedAt: null },
    take: 1,
  })

  const pkg = await buildAccessPackage(ids.request, dataAdmin, {
    selection: { itemIds: surviving.map((i) => i.id) },
  })

  assert.equal(pkg.selection.mode, 'ITEM_IDS')
  assert.equal(pkg.selection.complete, false, 'anything but ALL must be marked incomplete')
  assert.equal(pkg.selection.itemCount, surviving.length)
})

test('7 — closing is refused while work is in flight, and permitted once it is not', async () => {
  // The transition table only admits CLOSED from REVIEW, and that is deliberate:
  // a request cannot be discharged straight out of discovery without anyone
  // having reviewed what was done. Moved here directly rather than through
  // approveResolution because the guard under test is the in-flight one.
  await prisma.dsarRequest.update({ where: { id: ids.request }, data: { status: 'REVIEW' } })

  const before = await listActions(ids.request, {}, dataAdmin)
  assert.equal(before.inFlight, 0, 'every action was run inline, so nothing should still be pending')

  // Manufacture the in-flight case rather than racing the queue for it: the
  // guard is the thing under test, not the scheduler.
  const one = await prisma.dsarItemAction.findFirst({ where: { dsarRequestId: ids.request } })
  await prisma.dsarItemAction.update({ where: { id: one.id }, data: { status: 'RUNNING' } })

  await assert.rejects(
    () => closeRequest(ids.request, { note: 'done' }, dataAdmin),
    (err) => err.statusCode === 409,
    'a request closed over a running deletion would record a completion that had not happened',
  )

  await prisma.dsarItemAction.update({
    where: { id: one.id },
    data: { status: 'DONE', completedAt: new Date() },
  })

  const closed = await closeRequest(
    ids.request,
    { note: 'All held data was located, acted on and packaged.' },
    dataAdmin,
  )
  assert.equal(closed.status, 'CLOSED')
  assert.equal(closed.coarseStatus, 'CLOSED')
})

test('8 — the operator timeline shows every step, in order, with an actor', async () => {
  const timeline = await getRequestTimeline(ids.request, dataAdmin)
  const kinds = timeline.entries.map((e) => e.kind)

  for (const expected of ['ITEM_ACTION_BATCH', 'EVIDENCE', 'PURGE_PLANNED', 'ACCESS']) {
    assert.ok(kinds.includes(expected), `the timeline is missing ${expected}`)
  }

  const times = timeline.entries.map((e) => e.at)
  assert.deepEqual(times, [...times].sort(), 'entries must be time-ordered')

  // Batched, not per-item: two bulk submissions are two decisions, and one row
  // per item would bury everything else on the one screen that answers "what
  // happened".
  const batches = timeline.entries.filter((e) => e.kind === 'ITEM_ACTION_BATCH')
  assert.equal(batches.length, 2)

  assert.ok(timeline.subjectRef.startsWith('SUB-'), 'the timeline must stay pseudonymous')
  assert.ok(timeline.integrity.auditEntries > 0)
  assert.equal(timeline.integrity.verifyWith, '/api/v1/audit/verify')
})

test('9 — the principal sees milestones, and nothing about who worked their case', async () => {
  const mine = await getSubjectTimeline(ids.request, ids.subject)

  assert.equal(mine.coarseStatus, 'CLOSED')
  assert.ok(mine.entries.length > 0)
  assert.equal(mine.status, undefined, 'the internal 7-state status is not the principal’s business')

  const serialised = JSON.stringify(mine)
  assert.ok(!serialised.includes(ids.admin), 'no internal actor id may appear in the subject view')
  assert.ok(!serialised.includes(ids.bystander), 'no other principal may appear')
  for (const e of mine.entries) {
    assert.equal(e.actor, undefined)
    assert.equal(e.hash, undefined)
  }

  // Another principal's request is a 404, not a 403: confirming that an id
  // exists is itself information about someone else.
  await assert.rejects(
    () => getSubjectTimeline(ids.request, ids.bystander),
    (err) => err.statusCode === 404,
  )
})
