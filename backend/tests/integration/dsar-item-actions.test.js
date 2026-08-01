import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { prisma } from '../../src/config/prisma.js'
import { indexSubject } from '../../src/modules/dsar/itemIndex.service.js'
import { requestActions, executeAction, listActions, MAX_BATCH } from '../../src/modules/dsar/itemAction.service.js'
import { issueCertificate } from '../../src/modules/dsar/certificate.service.js'
import { closeRedactionQueue } from '../../src/lib/redactionQueue.js'
import { closeItemActionQueue } from '../../src/lib/itemActionQueue.js'

// Phase 5's contract. Every assertion here is about a guarantee that is only
// worth having if it holds under the worst input, so the fixtures are built to
// supply that input:
//
//   * a DELETE on a frame that holds another principal is REFUSED and downgraded
//     to a REDACT, from the server's own sharedSubjectCount. The refusal is
//     recorded (SKIPPED + REDACT), never a silent no-op.
//   * a double-submitted batch collapses onto the rows the first one created.
//   * one failing item does not take the rest of the batch with it.
//   * a scoped delete produces a PARTIAL purge job which is NOT certifiable —
//     the certificate is the document that says a principal's data is gone, and
//     a per-item delete is not that.
//   * an id from another principal's grid is refused outright.
//
// DB-only, like dsar-item-search.test.js: no face worker, no Qdrant. Redis IS
// needed, because a REDACT enqueues.
//   node --test tests/integration/dsar-item-actions.test.js

const RUN = randomUUID().slice(0, 8)

const ids = {
  admin: randomUUID(),
  project: randomUUID(),
  session: randomUUID(),
  subject: randomUUID(),
  bystander: randomUUID(),
  outsider: randomUUID(),
  request: randomUUID(),
  otherRequest: randomUUID(),
}

const SOLO_PHOTOS = 4
const SHARED_PHOTOS = 2

const dataAdmin = { id: ids.admin, role: 'dataAdmin' }
const dpo = { id: randomUUID(), role: 'dpo' }
const dataOwner = { id: randomUUID(), role: 'dataOwner' }

async function seedSubject(masterUserId, name) {
  await prisma.subject.create({
    data: {
      masterUserId,
      group: 'VOLUNTEER',
      status: 'ACTIVE',
      fullName: `${RUN} ${name}`,
      email: `${name.toLowerCase()}-${RUN}@itemactions.test`,
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

async function itemsFor(subjectId) {
  return prisma.subjectDataItem.findMany({
    where: { subjectId, deletedAt: null },
    orderBy: { capturedAt: 'asc' },
  })
}

test.before(async () => {
  await prisma.adminUser.create({
    data: { id: ids.admin, email: `admin-${RUN}@itemactions.test`, role: 'dataAdmin', status: 'ACTIVE' },
  })
  await prisma.project.create({
    data: { id: ids.project, name: `item-actions ${RUN}`, purpose: 'testing', status: 'ACTIVE', ownerAdminId: ids.admin },
  })

  const consent = await seedSubject(ids.subject, 'Meera')
  const bystanderConsent = await seedSubject(ids.bystander, 'Anand')
  await seedSubject(ids.outsider, 'Farida')

  await prisma.session.create({
    data: {
      id: ids.session,
      code: `IA-${randomUUID().slice(0, 8)}`,
      projectId: ids.project,
      agentId: ids.admin,
      status: 'ARCHIVED',
    },
  })

  for (let n = 0; n < SOLO_PHOTOS + SHARED_PHOTOS; n += 1) {
    const photo = await prisma.photo.create({
      data: {
        sessionId: ids.session,
        storagePath: `sessions/${ids.session}/original/${n}.jpg`,
        // Present so the L6 location is planned; the file itself never exists,
        // and the purge handlers are written to tolerate that (fileExists guard).
        redactedPath: `sessions/${ids.session}/redacted/${n}.jpg`,
        piiStatus: 'CLEAN',
        cameraSource: 'IPHONE_UPLOAD',
        sha256: `${RUN}-${n}-${randomUUID()}`,
        mimeType: 'image/jpeg',
        sizeBytes: 2048,
        takenAt: new Date(Date.UTC(2026, 6, 1, 9, n)),
      },
    })
    await prisma.photoSubject.create({
      data: { photoId: photo.id, subjectId: ids.subject, consentId: consent.consentId },
    })
    // The last SHARED_PHOTOS frames also hold a bystander, which is what turns a
    // DELETE into a REDACT.
    if (n >= SOLO_PHOTOS) {
      await prisma.photoSubject.create({
        data: { photoId: photo.id, subjectId: ids.bystander, consentId: bystanderConsent.consentId },
      })
    }
  }

  // Outsider gets one frame of their own, so "an id from another grid" is a real
  // item id rather than a random uuid that would 404 for the wrong reason.
  const outsiderPhoto = await prisma.photo.create({
    data: {
      sessionId: ids.session,
      storagePath: `sessions/${ids.session}/original/outsider.jpg`,
      cameraSource: 'IPHONE_UPLOAD',
      sha256: `${RUN}-outsider-${randomUUID()}`,
      mimeType: 'image/jpeg',
      sizeBytes: 2048,
      takenAt: new Date(Date.UTC(2026, 6, 2, 9, 0)),
    },
  })
  await prisma.photoSubject.create({ data: { photoId: outsiderPhoto.id, subjectId: ids.outsider } })

  for (const [id, subjectId] of [
    [ids.request, ids.subject],
    [ids.otherRequest, ids.outsider],
  ]) {
    await prisma.dsarRequest.create({
      data: {
        id,
        subjectId,
        type: 'ERASE',
        status: 'DISCOVERY',
        channel: 'PORTAL',
        slaDueAt: new Date(Date.now() + 30 * 86_400_000),
      },
    })
  }

  await indexSubject(ids.subject)
  await indexSubject(ids.bystander)
  await indexSubject(ids.outsider)
})

test.after(async () => {
  try {
    await prisma.dsarRequest.deleteMany({ where: { id: { in: [ids.request, ids.otherRequest] } } })
    await prisma.subject.deleteMany({
      where: { masterUserId: { in: [ids.subject, ids.bystander, ids.outsider] } },
    })
    await prisma.session.deleteMany({ where: { id: ids.session } })
    await prisma.project.deleteMany({ where: { id: ids.project } })
    await prisma.adminUser.deleteMany({ where: { id: ids.admin } })
  } finally {
    // access_events is append-only for prism_app; nothing to clean there.
    await Promise.allSettled([closeRedactionQueue(), closeItemActionQueue()])
    await prisma.$disconnect()
  }
})

test('a DELETE on a shared frame is refused and downgraded to a REDACT', async () => {
  const shared = (await itemsFor(ids.subject)).filter((i) => i.sharedSubjectCount > 1)
  assert.equal(shared.length, SHARED_PHOTOS, 'fixture should hold two shared frames')

  const result = await requestActions(
    {
      dsarRequestId: ids.request,
      itemIds: shared.map((i) => i.id),
      kind: 'DELETE',
      reason: 'principal asked for these frames to be removed',
    },
    dataAdmin,
    { inline: true },
  )

  assert.equal(result.summary.downgraded, SHARED_PHOTOS)
  assert.equal(result.summary.delete, 0, 'no delete should have been planned for a shared frame')

  const rows = await prisma.dsarItemAction.findMany({ where: { batchId: result.batchId } })
  const deletes = rows.filter((r) => r.kind === 'DELETE')
  const redacts = rows.filter((r) => r.kind === 'REDACT')

  assert.equal(deletes.length, SHARED_PHOTOS)
  assert.equal(redacts.length, SHARED_PHOTOS)
  for (const d of deletes) {
    assert.equal(d.status, 'SKIPPED', 'a refused delete must be recorded, never a silent no-op')
    assert.match(d.error, /other data principal/i)
  }

  // The photos are still there. This is the whole point of the rule.
  for (const item of shared) {
    const live = await prisma.subjectDataItem.findUnique({ where: { id: item.id } })
    assert.equal(live.deletedAt, null, 'a shared frame must survive a delete request')
    const link = await prisma.photoSubject.findUnique({ where: { id: item.sourceId } })
    assert.notEqual(link, null, 'the consent link for a shared frame must survive')
  }
})

test('a scoped delete removes the item and leaves a PARTIAL purge job that cannot be certified', async () => {
  const solo = (await itemsFor(ids.subject)).filter((i) => i.sharedSubjectCount === 1)[0]
  assert.ok(solo, 'fixture should hold a sole-subject frame')

  const result = await requestActions(
    { dsarRequestId: ids.request, itemIds: [solo.id], kind: 'DELETE', reason: 'erasure of a single frame' },
    dataAdmin,
    { inline: true },
  )

  const action = (await prisma.dsarItemAction.findMany({ where: { batchId: result.batchId } }))[0]
  assert.equal(action.status, 'DONE', action.error ?? '')
  assert.equal(action.hashBefore, solo.contentHash, 'the pre-delete hash is the only evidence the object existed')

  const tombstone = await prisma.subjectDataItem.findUnique({ where: { id: solo.id } })
  assert.notEqual(tombstone, null, 'the index row is a tombstone, never a hard delete')
  assert.notEqual(tombstone.deletedAt, null)

  const link = await prisma.photoSubject.findUnique({ where: { id: solo.sourceId } })
  assert.equal(link, null, 'the consent link should be gone')

  const job = await prisma.purgeJob.findFirst({
    where: { dsarRequestId: ids.request, scope: 'PARTIAL' },
    orderBy: { createdAt: 'desc' },
  })
  assert.ok(job, 'a scoped delete must run through the erasure executor, not a private path')
  assert.equal(job.scope, 'PARTIAL')
  assert.equal(job.status, 'COMPLETED')
  assert.equal(job.keyDestroyedAt, null, 'a per-item delete must never crypto-shred the subject key')
  assert.equal(job.meta.batchId, result.batchId)

  // The load-bearing refusal: a completed scoped job looks exactly like a small
  // completed erasure, and signing it would be a false statement.
  await assert.rejects(
    () => issueCertificate(job.id, dataAdmin),
    (err) => err.statusCode === 409 && /scoped/i.test(err.message),
  )
  const certificate = await prisma.deletionCertificate.findUnique({ where: { dsarRequestId: ids.request } })
  assert.equal(certificate, null, 'no certificate may exist for a request whose only purge was scoped')
})

test('a double-submitted batch collapses onto the rows the first submission created', async () => {
  const solo = (await itemsFor(ids.subject)).filter((i) => i.sharedSubjectCount === 1)[0]

  const first = await requestActions(
    { dsarRequestId: ids.request, itemIds: [solo.id], kind: 'EXPORT' },
    dataAdmin,
    { inline: true },
  )
  const second = await requestActions(
    { dsarRequestId: ids.request, itemIds: [solo.id], kind: 'EXPORT' },
    dataAdmin,
    { inline: true },
  )

  assert.notEqual(first.batchId, second.batchId, 'each submission gets its own batch id')

  const rows = await prisma.dsarItemAction.findMany({
    where: { dsarRequestId: ids.request, itemId: solo.id, kind: 'EXPORT' },
  })
  assert.equal(rows.length, 1, 'the unique constraint must collapse the duplicate')
  assert.equal(rows[0].batchId, first.batchId, 'the surviving row belongs to the first submission')
  assert.equal(second.actions.length, 0, 'the second batch created nothing')
})

test('an item belonging to another principal is refused', async () => {
  const foreign = (await itemsFor(ids.outsider))[0]
  assert.ok(foreign)

  await assert.rejects(
    () =>
      requestActions(
        { dsarRequestId: ids.request, itemIds: [foreign.id], kind: 'DELETE', reason: 'should never happen' },
        dataAdmin,
        { inline: true },
      ),
    (err) => err.statusCode === 403 && /do not belong/i.test(err.message),
  )

  const acted = await prisma.dsarItemAction.count({ where: { itemId: foreign.id } })
  assert.equal(acted, 0, 'nothing may be recorded against an item outside the request')
})

test('a DELETE without a written reason is refused', async () => {
  const solo = (await itemsFor(ids.subject)).filter((i) => i.sharedSubjectCount === 1)[0]
  await assert.rejects(
    () =>
      requestActions({ dsarRequestId: ids.request, itemIds: [solo.id], kind: 'DELETE', reason: 'oops' }, dataAdmin, {
        inline: true,
      }),
    (err) => err.statusCode === 400 && /reason/i.test(err.message),
  )
})

test('only dataAdmin and super_admin may act; dpo and dataOwner may not', async () => {
  const solo = (await itemsFor(ids.subject)).filter((i) => i.sharedSubjectCount === 1)[0]
  for (const actor of [dpo, dataOwner]) {
    await assert.rejects(
      () => requestActions({ dsarRequestId: ids.request, itemIds: [solo.id], kind: 'EXPORT' }, actor, { inline: true }),
      (err) => err.statusCode === 403,
      `${actor.role} must not be able to act on a principal's data`,
    )
  }
  // Reading the log is oversight, and the dpo keeps it.
  const log = await listActions(ids.request, {}, dpo)
  assert.ok(log.items.length > 0)
})

test('filter-based selection is resolved server-side and never reaches tombstones', async () => {
  const live = await itemsFor(ids.subject)
  const result = await requestActions(
    { dsarRequestId: ids.request, filter: { origin: 'COLLECTION_SESSION' }, kind: 'EXPORT' },
    dataAdmin,
    { inline: true },
  )

  const marked = await prisma.dsarItemAction.findMany({
    where: { dsarRequestId: ids.request, kind: 'EXPORT' },
    select: { itemId: true },
  })
  const markedIds = new Set(marked.map((m) => m.itemId))

  assert.equal(markedIds.size, live.length, 'select-all-matching must cover every live matching item')
  for (const item of live) assert.ok(markedIds.has(item.id))

  const tombstoned = await prisma.subjectDataItem.findMany({
    where: { subjectId: ids.subject, deletedAt: { not: null } },
    select: { id: true },
  })
  for (const t of tombstoned) {
    const actedThisBatch = await prisma.dsarItemAction.count({
      where: { batchId: result.batchId, itemId: t.id },
    })
    assert.equal(actedThisBatch, 0, 'a tombstoned item must not be re-selected by a filter')
  }
})

test('actions are refused outside DISCOVERY / EXECUTING / REVIEW', async () => {
  const solo = (await itemsFor(ids.subject)).filter((i) => i.sharedSubjectCount === 1)[0]
  await prisma.dsarRequest.update({ where: { id: ids.request }, data: { status: 'TRIAGE' } })
  try {
    await assert.rejects(
      () =>
        requestActions({ dsarRequestId: ids.request, itemIds: [solo.id], kind: 'REDACT' }, dataAdmin, {
          inline: true,
        }),
      (err) => err.statusCode === 409 && /TRIAGE/.test(err.message),
    )
  } finally {
    await prisma.dsarRequest.update({ where: { id: ids.request }, data: { status: 'DISCOVERY' } })
  }
})

test('one failing item does not take the rest of the batch with it', async () => {
  const live = (await itemsFor(ids.subject)).filter((i) => i.sharedSubjectCount === 1).slice(0, 2)
  assert.equal(live.length, 2, 'need two live sole-subject frames')

  // Break exactly one of them: the index row points at a source link that no
  // longer exists, which is what a race between a revocation and a bulk action
  // looks like from here.
  await prisma.photoSubject.delete({ where: { id: live[0].sourceId } })

  const result = await requestActions(
    {
      dsarRequestId: ids.request,
      itemIds: live.map((i) => i.id),
      kind: 'DELETE',
      reason: 'partial-failure isolation check',
    },
    dataAdmin,
    { inline: true },
  )

  const rows = await prisma.dsarItemAction.findMany({ where: { batchId: result.batchId } })
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.ok(['DONE', 'SKIPPED', 'FAILED'].includes(row.status), `row left in ${row.status}`)
  }
  // The intact one still went. A batch that aborts on its first bad row leaves
  // the operator with no way to tell what did happen.
  const intact = rows.find((r) => r.itemId === live[1].id)
  assert.equal(intact.status, 'DONE', intact.error ?? '')
  const tombstone = await prisma.subjectDataItem.findUnique({ where: { id: live[1].id } })
  assert.notEqual(tombstone.deletedAt, null)
})

test('executing a terminal action twice is a no-op', async () => {
  const done = await prisma.dsarItemAction.findFirst({
    where: { dsarRequestId: ids.request, status: 'DONE', kind: 'DELETE' },
  })
  assert.ok(done, 'need a completed delete')
  const again = await executeAction(done.id)
  assert.equal(again.status, 'DONE')
  assert.deepEqual(again.completedAt, done.completedAt, 'a replayed action must not re-run')
})

test('the batch ceiling is a real number, not advice', async () => {
  assert.ok(MAX_BATCH > 0 && MAX_BATCH <= 5000)
  const log = await listActions(ids.request, {}, dataAdmin)
  assert.equal(log.inFlight, 0, 'every action raised by this file should have reached a terminal state')
})
