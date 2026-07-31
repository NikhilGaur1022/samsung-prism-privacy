import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { prisma } from '../../src/config/prisma.js'
import {
  SOURCE,
  indexPhotoSubject,
  indexSubject,
  markItemDeleted,
} from '../../src/modules/dsar/itemIndex.service.js'

// The item index is a projection, so what has to be tested is the projection's
// three invariants, not the services that produce the source rows:
//
//   1. it is idempotent — rebuilding never duplicates and never churns counts;
//   2. `sharedSubjectCount` is the number of principals on the frame, because
//      that single integer is what stops a bulk delete removing someone else's
//      photo in Phase 5;
//   3. a vanished source row becomes a tombstone, never a missing row — a DSAR
//      timeline has to prove an item existed and was destroyed.
//
// Unlike tests/e2e/world.js this seeds tables directly. That is deliberate: the
// indexer's contract is with the ROWS, and going through the capture services
// would drag in the face worker, Qdrant and Redis to test a function that reads
// three tables. Nothing here asserts on service behaviour.

const ids = {
  admin: randomUUID(),
  project: randomUUID(),
  session: randomUUID(),
  subjectA: randomUUID(),
  subjectB: randomUUID(),
}

let soloPhoto
let groupPhoto

async function seedSubject(masterUserId, name) {
  await prisma.subject.create({
    data: {
      masterUserId,
      group: 'VOLUNTEER',
      status: 'ACTIVE',
      fullName: name,
      email: `${masterUserId}@itemindex.test`,
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

async function seedPhoto(label) {
  return prisma.photo.create({
    data: {
      sessionId: ids.session,
      storagePath: `sessions/${ids.session}/original/${label}.jpg`,
      cameraSource: 'IPHONE_UPLOAD',
      sha256: `${label}-${randomUUID()}`,
      mimeType: 'image/jpeg',
      sizeBytes: 1024,
      takenAt: new Date('2026-07-01T10:00:00Z'),
    },
  })
}

const liveItems = (subjectId) =>
  prisma.subjectDataItem.findMany({
    where: { subjectId, deletedAt: null },
    orderBy: { sourceId: 'asc' },
  })

test.before(async () => {
  await prisma.adminUser.create({
    data: { id: ids.admin, email: `${ids.admin}@itemindex.test`, role: 'collectionAgent', status: 'ACTIVE' },
  })
  await prisma.project.create({
    data: { id: ids.project, name: 'item-index test', purpose: 'testing', status: 'ACTIVE', ownerAdminId: ids.admin },
  })
  const consentA = await seedSubject(ids.subjectA, 'Subject A')
  const consentB = await seedSubject(ids.subjectB, 'Subject B')
  await prisma.session.create({
    data: { id: ids.session, code: `IX-${randomUUID().slice(0, 8)}`, projectId: ids.project, agentId: ids.admin, status: 'ARCHIVED' },
  })

  soloPhoto = await seedPhoto('solo')
  groupPhoto = await seedPhoto('group')

  await prisma.photoSubject.createMany({
    data: [
      { photoId: soloPhoto.id, subjectId: ids.subjectA, consentId: consentA.consentId },
      { photoId: groupPhoto.id, subjectId: ids.subjectA, consentId: consentA.consentId },
      { photoId: groupPhoto.id, subjectId: ids.subjectB, consentId: consentB.consentId },
    ],
  })

  await prisma.subjectFaceEnrollment.create({
    data: {
      subjectId: ids.subjectA,
      imagePath: `enrollments/${ids.subjectA}/selfie.jpg`,
      sha256: `enroll-${randomUUID()}`,
      detScore: 0.99,
      source: 'AGENT',
    },
  })
})

test.after(async () => {
  try {
    // Subject cascade takes photo_subjects, consents, enrollments and the index
    // rows with it; the session cascade takes the photos.
    await prisma.subject.deleteMany({ where: { masterUserId: { in: [ids.subjectA, ids.subjectB] } } })
    await prisma.session.deleteMany({ where: { id: ids.session } })
    await prisma.project.deleteMany({ where: { id: ids.project } })
    await prisma.adminUser.deleteMany({ where: { id: ids.admin } })
  } finally {
    await prisma.$disconnect()
  }
})

test('indexing a subject twice produces one row per source row', async () => {
  const first = await indexSubject(ids.subjectA)
  // 2 photo links + 1 enrollment selfie
  assert.equal(first.indexed, 3)

  const afterFirst = await liveItems(ids.subjectA)
  assert.equal(afterFirst.length, 3)

  const second = await indexSubject(ids.subjectA)
  assert.equal(second.indexed, 3)
  assert.equal(second.tombstoned, 0, 'a rebuild must not tombstone rows it just wrote')

  const afterSecond = await liveItems(ids.subjectA)
  assert.equal(afterSecond.length, 3, 'the second pass duplicated rows')
  assert.deepEqual(
    afterSecond.map((i) => i.id).sort(),
    afterFirst.map((i) => i.id).sort(),
    'the second pass replaced rows instead of upserting them',
  )
})

test('the live photo item count equals the link rows an erasure would destroy', async () => {
  await indexSubject(ids.subjectA)
  const links = await prisma.photoSubject.count({ where: { subjectId: ids.subjectA } })
  const items = await prisma.subjectDataItem.count({
    where: { subjectId: ids.subjectA, sourceTable: SOURCE.PHOTO_SUBJECT, deletedAt: null },
  })
  assert.equal(items, links)
})

test('sharedSubjectCount counts every principal on the frame, including this one', async () => {
  await indexSubject(ids.subjectA)
  await indexSubject(ids.subjectB)

  const items = await prisma.subjectDataItem.findMany({
    where: { sourceTable: SOURCE.PHOTO_SUBJECT, deletedAt: null, subjectId: { in: [ids.subjectA, ids.subjectB] } },
    select: { subjectId: true, sessionId: true, storagePath: true, sharedSubjectCount: true },
  })

  const solo = items.filter((i) => i.storagePath === soloPhoto.storagePath)
  const group = items.filter((i) => i.storagePath === groupPhoto.storagePath)

  assert.equal(solo.length, 1)
  assert.equal(solo[0].sharedSubjectCount, 1, 'a sole-subject photo must be deletable')
  assert.equal(group.length, 2)
  for (const item of group) {
    assert.equal(item.sharedSubjectCount, 2, 'a shared frame must never present as deletable')
  }
})

test('an enrollment selfie is indexed as an ENROLLMENT-origin item with no project', async () => {
  await indexSubject(ids.subjectA)
  const item = await prisma.subjectDataItem.findFirst({
    where: { subjectId: ids.subjectA, sourceTable: SOURCE.ENROLLMENT, deletedAt: null },
  })
  assert.ok(item, 'the enrollment selfie was not indexed')
  assert.equal(item.origin, 'ENROLLMENT')
  assert.equal(item.projectId, null)
  assert.equal(item.sharedSubjectCount, 1)
  assert.equal(item.redactedAvailable, false)
})

test('tagging a third link refreshes the shared count on the other principals', async () => {
  const consentB = await prisma.projectConsent.findFirst({ where: { subjectId: ids.subjectB } })
  const extra = await prisma.photoSubject.create({
    data: { photoId: soloPhoto.id, subjectId: ids.subjectB, consentId: consentB.consentId },
  })

  await indexPhotoSubject(extra)

  const onSolo = await prisma.subjectDataItem.findMany({
    where: { storagePath: soloPhoto.storagePath, deletedAt: null },
    select: { subjectId: true, sharedSubjectCount: true },
  })
  assert.equal(onSolo.length, 2)
  for (const item of onSolo) {
    assert.equal(item.sharedSubjectCount, 2, 'the pre-existing item kept a stale shared count')
  }

  await prisma.photoSubject.delete({ where: { id: extra.id } })
})

test('a vanished source row is tombstoned, not removed, and excluded from live reads', async () => {
  await indexSubject(ids.subjectA)

  const link = await prisma.photoSubject.findFirst({
    where: { subjectId: ids.subjectA, photoId: soloPhoto.id },
  })
  await prisma.photoSubject.delete({ where: { id: link.id } })

  const result = await indexSubject(ids.subjectA)
  assert.equal(result.tombstoned, 1)

  const tombstone = await prisma.subjectDataItem.findFirst({
    where: { subjectId: ids.subjectA, sourceTable: SOURCE.PHOTO_SUBJECT, sourceId: link.id },
  })
  assert.ok(tombstone, 'the item row was deleted — the timeline can no longer prove the item existed')
  assert.ok(tombstone.deletedAt instanceof Date)

  const live = await liveItems(ids.subjectA)
  assert.ok(!live.some((i) => i.sourceId === link.id), 'a tombstoned item appeared in a live read')

  // Rebuilding does not resurrect it, and does not re-tombstone it either.
  const again = await indexSubject(ids.subjectA)
  assert.equal(again.tombstoned, 0)
})

test('markItemDeleted is idempotent and keeps the first deletion time', async () => {
  await indexSubject(ids.subjectB)
  const item = await prisma.subjectDataItem.findFirst({ where: { subjectId: ids.subjectB, deletedAt: null } })

  const first = await markItemDeleted(item.id)
  assert.ok(first.deletedAt)

  const second = await markItemDeleted(item.id)
  assert.equal(second.deletedAt.getTime(), first.deletedAt.getTime(), 'a retried delete rewrote the deletion time')

  assert.equal(await markItemDeleted(randomUUID()), null)
})
