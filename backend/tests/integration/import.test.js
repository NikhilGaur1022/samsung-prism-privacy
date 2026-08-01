import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'

import { prisma } from '../../src/config/prisma.js'
import { closeRedactionQueue } from '../../src/lib/redactionQueue.js'
import { deleteFile } from '../../src/lib/storage.js'
import { indexSubject } from '../../src/modules/dsar/itemIndex.service.js'
import { listSubjectItems } from '../../src/modules/dsar/itemSearch.service.js'
import { runDiscovery } from '../../src/modules/dsar/discovery.service.js'
import * as importService from '../../src/modules/import/import.service.js'

// PLAN Phase 3. The properties under test are the ones that make an import
// honest rather than merely functional:
//
//   * an imported item is discoverable — if it were not, a DSAR response would
//     be a false statement about what is held;
//   * it keeps `origin=IMPORT` and its lawful-basis flag across an index
//     REBUILD. The indexer labels every photo link COLLECTION_SESSION, so a
//     rebuild that overwrote the origin would silently launder an unverified
//     basis into a consented one — the single worst thing this leg can do;
//   * no consent is manufactured. Without a live ProjectConsent the link's
//     consentId stays null and the item says `IMPORT_UNVERIFIED`;
//   * an import into an ERASED subject is refused, because it would re-create
//     data a signed certificate says was destroyed.
//
// Needs the database, the media store and Redis (the ingest enqueues a
// redaction). Run alone with:
//   node --test tests/integration/import.test.js

const RUN = randomUUID().slice(0, 8)

const ids = {
  admin: randomUUID(),
  project: randomUUID(),
  subject: randomUUID(),
  consented: randomUUID(),
  erased: randomUUID(),
}

const admin = { id: ids.admin, role: 'dataAdmin' }

const writtenPaths = []
const createdPhotoIds = []

// A real JPEG, because ingestItem runs it through sharp. Two distinct pixel
// colours give two distinct sha256s without needing fixture files on disk.
async function jpeg(seed) {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: seed, g: 40, b: 90 } },
  })
    .jpeg()
    .toBuffer()
}

async function file(seed) {
  return { buffer: await jpeg(seed), mimetype: 'image/jpeg', originalname: `import-${seed}.jpg` }
}

async function seedSubject(masterUserId, name, status = 'ACTIVE') {
  return prisma.subject.create({
    data: {
      masterUserId,
      group: 'VOLUNTEER',
      status,
      fullName: `${RUN} ${name}`,
      email: `${name.toLowerCase()}-${RUN}@import.test`,
      registrationChannel: 'AGENT',
    },
  })
}

test.before(async () => {
  await prisma.adminUser.create({
    data: { id: ids.admin, email: `${ids.admin}@import.test`, role: 'dataAdmin', status: 'ACTIVE' },
  })
  await prisma.project.create({
    data: {
      id: ids.project,
      name: `import test ${RUN}`,
      purpose: 'testing',
      status: 'ACTIVE',
      ownerAdminId: ids.admin,
    },
  })

  await seedSubject(ids.subject, 'Unconsented')
  await seedSubject(ids.consented, 'Consented')
  await seedSubject(ids.erased, 'Erased', 'ERASED')

  await prisma.projectConsent.create({
    data: {
      subjectId: ids.consented,
      projectId: ids.project,
      status: 'ACTIVE',
      policyVersion: 'v1',
      signatureHash: 'test',
    },
  })
})

test.after(async () => {
  try {
    // Blobs first: the rows are what tell us where they are.
    const photos = await prisma.photo.findMany({
      where: { id: { in: createdPhotoIds } },
      select: { storagePath: true, redactedPath: true },
    })
    for (const p of photos) {
      writtenPaths.push(p.storagePath)
      if (p.redactedPath) writtenPaths.push(p.redactedPath)
    }
    for (const path of writtenPaths) await deleteFile(path).catch(() => {})

    // Subject cascade takes links, consents, index rows and import batches.
    // Imported photos have no session to cascade from, so they go explicitly.
    await prisma.subject.deleteMany({
      where: { masterUserId: { in: [ids.subject, ids.consented, ids.erased] } },
    })
    await prisma.photo.deleteMany({ where: { id: { in: createdPhotoIds } } })
    await prisma.project.deleteMany({ where: { id: ids.project } })
    await prisma.adminUser.deleteMany({ where: { id: ids.admin } })
  } finally {
    await closeRedactionQueue()
    await prisma.$disconnect()
  }
})

test('an import with no project records IMPORT_UNVERIFIED and manufactures no consent', async () => {
  const batch = await importService.createBatch({ subjectId: ids.subject }, admin)
  assert.equal(batch.status, 'OPEN')

  const result = await importService.ingestItem({ batchId: batch.id, file: await file(10) }, admin)
  createdPhotoIds.push(result.photoId)

  assert.equal(result.duplicate, false)
  assert.equal(result.lawfulBasis, 'IMPORT_UNVERIFIED')

  const link = await prisma.photoSubject.findFirst({
    where: { photoId: result.photoId, subjectId: ids.subject },
  })
  assert.equal(link.consentId, null, 'an import must never invent a ProjectConsent to satisfy a FK')

  const item = await prisma.subjectDataItem.findFirst({
    where: { subjectId: ids.subject, sourceId: link.id },
  })
  assert.equal(item.origin, 'IMPORT')
  assert.equal(item.meta.lawfulBasis, 'IMPORT_UNVERIFIED')
  assert.equal(item.meta.identification, 'ADMIN_ASSERTED')
  assert.equal(item.meta.importBatchId, batch.id)
  assert.equal(item.sessionId, null)
})

test('a live ProjectConsent is inherited rather than flagged', async () => {
  const batch = await importService.createBatch(
    { subjectId: ids.consented, projectId: ids.project },
    admin,
  )
  const result = await importService.ingestItem({ batchId: batch.id, file: await file(20) }, admin)
  createdPhotoIds.push(result.photoId)

  assert.equal(result.lawfulBasis, 'PROJECT_CONSENT')

  const link = await prisma.photoSubject.findFirst({ where: { photoId: result.photoId } })
  assert.ok(link.consentId, 'a live consent should have been recorded on the link')

  const item = await prisma.subjectDataItem.findFirst({ where: { sourceId: link.id } })
  assert.equal(item.meta.lawfulBasis, 'PROJECT_CONSENT')
  assert.equal(item.projectId, ids.project)
})

test('a revoked consent is a recorded gap, not an inherited basis', async () => {
  await prisma.projectConsent.update({
    where: { subjectId_projectId: { subjectId: ids.consented, projectId: ids.project } },
    data: { status: 'REVOKED', revokedAt: new Date() },
  })

  const batch = await importService.createBatch(
    { subjectId: ids.consented, projectId: ids.project },
    admin,
  )
  const result = await importService.ingestItem({ batchId: batch.id, file: await file(30) }, admin)
  createdPhotoIds.push(result.photoId)

  assert.equal(result.lawfulBasis, 'IMPORT_UNVERIFIED')

  const link = await prisma.photoSubject.findFirst({ where: { photoId: result.photoId } })
  const item = await prisma.subjectDataItem.findFirst({ where: { sourceId: link.id } })
  assert.equal(item.meta.consentGap, 'REVOKED', 'the reason the basis is missing must be on the record')

  await prisma.projectConsent.update({
    where: { subjectId_projectId: { subjectId: ids.consented, projectId: ids.project } },
    data: { status: 'ACTIVE', revokedAt: null },
  })
})

test('origin=IMPORT and the lawful-basis flag survive a full index rebuild', async () => {
  // The indexer labels every photo link COLLECTION_SESSION. If a rebuild
  // overwrote origin/meta it would relabel an unverified import as consented
  // collection — the completeness surface would then read as if a lawful basis
  // existed where none does.
  await indexSubject(ids.subject)

  const page = await listSubjectItems({ subjectId: ids.subject })
  const imported = page.items.filter((i) => i.origin === 'IMPORT')

  assert.equal(imported.length, 1)
  assert.equal(imported[0].lawfulBasis, 'IMPORT_UNVERIFIED')
  assert.equal(page.totals.byOrigin.IMPORT, 1)
  assert.equal(page.index.consistent, true, 'the index disagrees with the source tables')
})

test('the same file twice in one batch is one item', async () => {
  const batch = await importService.createBatch({ subjectId: ids.subject }, admin)
  const buffer = await jpeg(40)

  const first = await importService.ingestItem(
    { batchId: batch.id, file: { buffer, mimetype: 'image/jpeg' } },
    admin,
  )
  createdPhotoIds.push(first.photoId)
  const second = await importService.ingestItem(
    { batchId: batch.id, file: { buffer, mimetype: 'image/jpeg' } },
    admin,
  )

  assert.equal(first.duplicate, false)
  assert.equal(second.duplicate, true)
  // Photo@@unique([sessionId, sha256]) stops de-duplicating the moment sessionId
  // is null, so this has to be the explicit subject-scoped check in ingestItem
  // and not a database constraint doing it silently.
  assert.equal(second.photoId, first.photoId)
})

test('an imported photo is discoverable — it appears in the L2 discovery walk', async () => {
  const discovery = await runDiscovery(ids.subject)
  const l2 = discovery.locations.filter((l) => l.locationCode === 'L2')

  assert.ok(l2.length > 0, 'imported photos must be reachable by discovery, not only by the index')
  assert.ok(
    l2.some((l) => createdPhotoIds.includes(l.objectId)),
    'the discovery walk must name the imported photo itself',
  )
})

test('import into an ERASED subject is refused', async () => {
  await assert.rejects(
    () => importService.createBatch({ subjectId: ids.erased }, admin),
    (err) => err.statusCode === 409,
    'importing into an erased subject would re-create data a signed certificate says was destroyed',
  )
})

test('a closed batch accepts no further items', async () => {
  const batch = await importService.createBatch({ subjectId: ids.subject }, admin)
  const closed = await importService.closeBatch(batch.id, {}, admin)
  assert.equal(closed.status, 'CLOSED')
  assert.ok(closed.closedAt)

  const rejected = await file(50)
  await assert.rejects(
    () => importService.ingestItem({ batchId: batch.id, file: rejected }, admin),
    (err) => err.statusCode === 409,
  )
})

test('a non-image is refused by media type, not by file extension', async () => {
  const batch = await importService.createBatch({ subjectId: ids.subject }, admin)
  await assert.rejects(
    () =>
      importService.ingestItem(
        { batchId: batch.id, file: { buffer: Buffer.from('not an image'), mimetype: 'application/pdf' } },
        admin,
      ),
    (err) => err.statusCode === 415,
  )
})
