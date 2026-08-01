import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { prisma } from '../../src/config/prisma.js'
import { indexSubject } from '../../src/modules/dsar/itemIndex.service.js'
import {
  listItemsForRequest,
  listSubjectItems,
  searchSubjects,
} from '../../src/modules/dsar/itemSearch.service.js'

// Phase 4's contract, which is a completeness claim rather than a feature:
//
//   * `totals.all` is a count() over the index. If it were `items.length` a
//     paged view would report a page as the whole of a person's data — the exact
//     failure that makes a DSAR response a false statement.
//   * every seeded item is reachable by walking the cursor, exactly once.
//   * identity search matches exactly or by prefix and NEVER fuzzily. A wrong
//     match hands one principal another principal's data.
//   * an IMPORT-origin row keeps its origin and lawful-basis flag across a
//     rebuild — the index must not launder an unverified basis into a consented
//     one.
//
// Seeds tables directly, like tests/unit/itemIndex.test.js: this exercises
// services over rows, so it needs a database and nothing else — no face worker,
// no Qdrant, no Redis. Run alone with:
//   node --test tests/integration/dsar-item-search.test.js
//
// Phase 3 (the import pipeline) is not built, so the imported photo is seeded the
// way import.service.js will create it: Photo.sessionId null, PhotoSubject
// .consentId null (both nullable since 20260731000003), and the SubjectDataItem
// written by the import path itself with origin=IMPORT.

const ids = {
  admin: randomUUID(),
  project: randomUUID(),
  otherProject: randomUUID(),
  sessions: [randomUUID(), randomUUID(), randomUUID()],
  subject: randomUUID(),
  bystander: randomUUID(),
  request: randomUUID(),
}

const PHOTOS_PER_SESSION = 4
const IMPORTED_PHOTOS = 2
const ENROLLMENTS = 1
// 3 sessions × 4 + 2 imported + 1 selfie
const EXPECTED_ITEMS = ids.sessions.length * PHOTOS_PER_SESSION + IMPORTED_PHOTOS + ENROLLMENTS

// Identity search runs against the whole register, so fixture names must not be
// able to collide with a previous run's leftovers — a stale row with the same
// name reads as a fuzzy-match failure that isn't one.
const RUN = randomUUID().slice(0, 8)
const SUBJECT_NAME = `${RUN} Kalpana Ramaswamy`
const BYSTANDER_NAME = `${RUN} Kalpesh Nair`

const dataAdmin = { id: ids.admin, role: 'dataAdmin' }
const dpo = { id: randomUUID(), role: 'dpo' }
const dataOwner = { id: randomUUID(), role: 'dataOwner' }

let importedPhotoIds = []

async function seedSubject(masterUserId, fullName, email) {
  await prisma.subject.create({
    data: {
      masterUserId,
      group: 'VOLUNTEER',
      status: 'ACTIVE',
      fullName,
      email,
      employeeRef: `EMP-${masterUserId.slice(0, 8)}`,
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
    data: { id: ids.admin, email: `${ids.admin}@itemsearch.test`, role: 'dataAdmin', status: 'ACTIVE' },
  })
  await prisma.project.createMany({
    data: [
      { id: ids.project, name: 'item-search test', purpose: 'testing', status: 'ACTIVE', ownerAdminId: ids.admin },
      { id: ids.otherProject, name: 'item-search other', purpose: 'testing', status: 'ACTIVE', ownerAdminId: ids.admin },
    ],
  })

  // Not uuid-derived: an email that starts with the subject's own id would match
  // the uuid-prefix probe below through the email clause and hide the rule under
  // test.
  const consent = await seedSubject(ids.subject, SUBJECT_NAME, `kalpana-${RUN}@itemsearch.test`)
  const bystanderConsent = await seedSubject(ids.bystander, BYSTANDER_NAME, `kalpesh-${RUN}@itemsearch.test`)

  // Three sessions, one of them on a second project so the projectId filter has
  // something to exclude.
  for (const [i, sessionId] of ids.sessions.entries()) {
    await prisma.session.create({
      data: {
        id: sessionId,
        code: `IS-${randomUUID().slice(0, 8)}`,
        projectId: i === 2 ? ids.otherProject : ids.project,
        agentId: ids.admin,
        status: 'ARCHIVED',
      },
    })

    for (let n = 0; n < PHOTOS_PER_SESSION; n += 1) {
      const photo = await prisma.photo.create({
        data: {
          sessionId,
          storagePath: `sessions/${sessionId}/original/${n}.jpg`,
          cameraSource: 'IPHONE_UPLOAD',
          sha256: `${sessionId}-${n}-${randomUUID()}`,
          mimeType: 'image/jpeg',
          sizeBytes: 2048,
          takenAt: new Date(Date.UTC(2026, 5, 1 + i, 9, n)),
        },
      })
      await prisma.photoSubject.create({
        data: { photoId: photo.id, subjectId: ids.subject, consentId: consent.consentId },
      })
      // One frame per session also carries a bystander, so sharedSubjectCount
      // has both values to report.
      if (n === 0) {
        await prisma.photoSubject.create({
          data: { photoId: photo.id, subjectId: ids.bystander, consentId: bystanderConsent.consentId },
        })
      }
    }
  }

  await prisma.subjectFaceEnrollment.create({
    data: {
      subjectId: ids.subject,
      imagePath: `enrollments/${ids.subject}/selfie.jpg`,
      sha256: `enroll-${randomUUID()}`,
      detScore: 0.98,
      source: 'AGENT',
    },
  })

  // The import leg, seeded as Phase 3's ingestItem() will write it.
  for (let n = 0; n < IMPORTED_PHOTOS; n += 1) {
    const photo = await prisma.photo.create({
      data: {
        sessionId: null,
        storagePath: `imports/${ids.subject}/${n}.jpg`,
        cameraSource: 'IPHONE_UPLOAD',
        sha256: `import-${n}-${randomUUID()}`,
        mimeType: 'image/jpeg',
        sizeBytes: 4096,
        takenAt: null,
      },
    })
    importedPhotoIds.push(photo.id)
    const link = await prisma.photoSubject.create({
      data: { photoId: photo.id, subjectId: ids.subject, consentId: null },
    })
    await prisma.subjectDataItem.create({
      data: {
        subjectId: ids.subject,
        type: 'PHOTO',
        origin: 'IMPORT',
        sourceTable: 'photo_subjects',
        sourceId: link.id,
        storagePath: photo.storagePath,
        contentHash: photo.sha256,
        capturedAt: null,
        sharedSubjectCount: 1,
        redactedAvailable: false,
        meta: { lawfulBasis: 'IMPORT_UNVERIFIED' },
      },
    })
  }

  await prisma.dsarRequest.create({
    data: {
      id: ids.request,
      subjectId: ids.subject,
      type: 'ACCESS',
      status: 'DISCOVERY',
      channel: 'PORTAL',
      slaDueAt: new Date(Date.now() + 30 * 86_400_000),
    },
  })

  await indexSubject(ids.subject)
  await indexSubject(ids.bystander)
})

test.after(async () => {
  try {
    await prisma.dsarRequest.deleteMany({ where: { id: ids.request } })
    // access_events is deliberately append-only for prism_app — a DELETE here is
    // a 42501, and the events this run wrote are meant to outlive it.
    // Subject cascade takes links, consents, enrollments and index rows; the
    // session cascade takes the session photos. Imported photos have no session,
    // so they are removed explicitly.
    await prisma.subject.deleteMany({ where: { masterUserId: { in: [ids.subject, ids.bystander] } } })
    await prisma.photo.deleteMany({ where: { id: { in: importedPhotoIds } } })
    await prisma.session.deleteMany({ where: { id: { in: ids.sessions } } })
    await prisma.project.deleteMany({ where: { id: { in: [ids.project, ids.otherProject] } } })
    await prisma.adminUser.deleteMany({ where: { id: ids.admin } })
  } finally {
    await prisma.$disconnect()
  }
})

test('totals.all is a count over the index, not the size of the page', async () => {
  const page = await listSubjectItems({ subjectId: ids.subject, limit: 5 })

  assert.equal(page.items.length, 5, 'the page should honour the limit')
  assert.equal(page.totals.all, EXPECTED_ITEMS, 'totals.all is the completeness claim and must count the index')
  assert.notEqual(page.totals.all, page.items.length)
  assert.equal(page.totals.byType.PHOTO, EXPECTED_ITEMS)
  assert.equal(page.totals.byOrigin.IMPORT, IMPORTED_PHOTOS)
  assert.equal(page.totals.byOrigin.ENROLLMENT, ENROLLMENTS)
  assert.equal(page.index.consistent, true, 'the index disagrees with the source tables')
})

test('walking the cursor yields every item exactly once', async () => {
  const seen = new Set()
  let cursor = null
  let pages = 0

  do {
    const page = await listSubjectItems({ subjectId: ids.subject, limit: 4, cursor })
    pages += 1
    for (const item of page.items) {
      assert.equal(seen.has(item.itemId), false, `item ${item.itemId} was returned on two pages`)
      seen.add(item.itemId)
    }
    cursor = page.nextCursor
    assert.ok(pages < 20, 'the cursor walk did not terminate')
  } while (cursor)

  assert.equal(seen.size, EXPECTED_ITEMS, 'pagination did not reach every item')
})

test('the keyset walk is stable across the null-capturedAt tail', async () => {
  // capturedAt is nullable and an item with no capture time is a real case (a
  // future non-photo type, or an import whose source row carries no date). The
  // cursor has to cross the NULLS LAST boundary without skipping or repeating,
  // so the boundary is manufactured here rather than hoped for.
  const victims = await prisma.subjectDataItem.findMany({
    where: { subjectId: ids.subject, deletedAt: null },
    orderBy: { id: 'asc' },
    take: 2,
    select: { id: true },
  })
  await prisma.subjectDataItem.updateMany({
    where: { id: { in: victims.map((v) => v.id) } },
    data: { capturedAt: null },
  })

  try {
    const all = await listSubjectItems({ subjectId: ids.subject, limit: 200 })
    const dated = all.items.filter((i) => i.capturedAt !== null).map((i) => new Date(i.capturedAt).getTime())

    assert.deepEqual(dated, [...dated].sort((a, b) => b - a), 'dated items are not newest-first')
    assert.deepEqual(
      all.items.slice(-victims.length).map((i) => i.capturedAt),
      new Array(victims.length).fill(null),
      'null capturedAt rows must sort after every dated row',
    )

    const seen = new Set()
    let cursor = null
    let pages = 0
    do {
      const page = await listSubjectItems({ subjectId: ids.subject, limit: 3, cursor })
      pages += 1
      for (const item of page.items) {
        assert.equal(seen.has(item.itemId), false, `item ${item.itemId} was returned twice across the null boundary`)
        seen.add(item.itemId)
      }
      cursor = page.nextCursor
      assert.ok(pages < 20, 'the cursor walk did not terminate')
    } while (cursor)

    assert.equal(seen.size, EXPECTED_ITEMS, 'the walk lost items at the null boundary')
  } finally {
    // Put the real capture times back — the rest of the file asserts on them.
    await indexSubject(ids.subject)
  }
})

test('filters narrow `matching` but never the completeness claim', async () => {
  const imports = await listSubjectItems({ subjectId: ids.subject, origin: 'IMPORT', limit: 50 })
  assert.equal(imports.items.length, IMPORTED_PHOTOS)
  assert.equal(imports.totals.matching, IMPORTED_PHOTOS)
  assert.equal(imports.totals.all, EXPECTED_ITEMS, 'a filtered view must still report the full holding')

  const byProject = await listSubjectItems({ subjectId: ids.subject, projectId: ids.otherProject, limit: 50 })
  assert.equal(byProject.totals.matching, PHOTOS_PER_SESSION)

  const window = await listSubjectItems({
    subjectId: ids.subject,
    from: new Date(Date.UTC(2026, 5, 2, 0, 0)),
    to: new Date(Date.UTC(2026, 5, 2, 23, 59)),
    limit: 50,
  })
  assert.equal(window.totals.matching, PHOTOS_PER_SESSION, 'the date window should isolate one session')
})

test('an IMPORT item keeps its origin and lawful basis through a rebuild', async () => {
  await indexSubject(ids.subject)

  const page = await listSubjectItems({ subjectId: ids.subject, origin: 'IMPORT', limit: 50 })
  assert.equal(page.items.length, IMPORTED_PHOTOS, 'a rebuild relabelled the imported items')
  for (const item of page.items) {
    assert.equal(item.origin, 'IMPORT')
    assert.equal(item.lawfulBasis, 'IMPORT_UNVERIFIED', 'the index laundered an unverified lawful basis')
  }
})

test('shared frames are reported as shared so a delete can be downgraded', async () => {
  const page = await listSubjectItems({ subjectId: ids.subject, limit: 200 })
  const shared = page.items.filter((i) => i.shared)

  assert.equal(shared.length, ids.sessions.length, 'one frame per session carries a bystander')
  for (const item of shared) {
    assert.equal(item.sharedSubjectCount, 2)
  }
})

test('a tombstoned item is excluded by default and visible on request', async () => {
  const link = await prisma.photoSubject.findFirst({
    where: { subjectId: ids.subject, consentId: null },
  })
  await prisma.photoSubject.delete({ where: { id: link.id } })
  await prisma.photo.delete({ where: { id: link.photoId } })
  importedPhotoIds = importedPhotoIds.filter((id) => id !== link.photoId)
  await indexSubject(ids.subject)

  const live = await listSubjectItems({ subjectId: ids.subject, limit: 200 })
  assert.equal(live.totals.all, EXPECTED_ITEMS - 1)
  assert.equal(live.totals.deleted, 1)
  assert.equal(live.items.some((i) => i.deletedAt !== null), false)

  const withDeleted = await listSubjectItems({ subjectId: ids.subject, includeDeleted: true, limit: 200 })
  assert.equal(withDeleted.items.length, EXPECTED_ITEMS)
  assert.equal(
    withDeleted.items.filter((i) => i.deletedAt !== null).length,
    1,
    'the destroyed item must remain provable, not disappear',
  )
})

test('identity search matches exactly and by prefix, and not fuzzily', async () => {
  const exact = await searchSubjects({ q: SUBJECT_NAME }, { admin: dataAdmin })
  assert.deepEqual(exact.items.map((i) => i.subjectId), [ids.subject])

  const prefix = await searchSubjects({ q: `${RUN} Kalp` }, { admin: dataAdmin })
  assert.deepEqual(
    prefix.items.map((i) => i.subjectId).sort(),
    [ids.subject, ids.bystander].sort(),
    'a shared prefix must match both principals',
  )

  // "Ramaswamy" is a substring of the seeded name but not a prefix of any
  // searchable field. A fuzzy or contains-based implementation returns the
  // subject here; an exact+prefix one must not.
  const substring = await searchSubjects({ q: 'Ramaswamy' }, { admin: dataAdmin })
  assert.deepEqual(substring.items, [], 'substring matching is fuzzy matching — a wrong match is a breach')

  // One transposed character. Nothing may come back.
  const typo = await searchSubjects({ q: `${RUN} Kaplana` }, { admin: dataAdmin })
  assert.deepEqual(typo.items, [])

  const byId = await searchSubjects({ q: ids.subject }, { admin: dataAdmin })
  assert.deepEqual(byId.items.map((i) => i.subjectId), [ids.subject])

  const idPrefix = await searchSubjects({ q: ids.subject.slice(0, 8) }, { admin: dataAdmin })
  assert.deepEqual(idPrefix.items, [], 'a uuid prefix is not evidence about a person')

  assert.equal(exact.items[0].itemCount > 0, true, 'search should carry the live item count')
})

test('identity search is denied to roles that may not see subject identity', async () => {
  for (const admin of [dpo, dataOwner]) {
    await assert.rejects(
      () => searchSubjects({ q: 'Kalp' }, { admin }),
      (err) => err.statusCode === 403,
      `${admin.role} must not reach the identity register`,
    )
  }
})

test('every identity search result is written to the read log', async () => {
  const before = await prisma.accessEvent.count({
    where: { objectId: ids.subject, action: 'SEARCH', objectType: 'SUBJECT_PII' },
  })
  await searchSubjects({ q: SUBJECT_NAME }, { admin: dataAdmin })
  const after = await prisma.accessEvent.count({
    where: { objectId: ids.subject, action: 'SEARCH', objectType: 'SUBJECT_PII' },
  })
  assert.equal(after, before + 1, 'a search that reads a person must leave a record')

  const miss = await prisma.accessEvent.count({ where: { action: 'SEARCH', objectId: 'no-such-subject' } })
  assert.equal(miss, 0)
})

test('the request listing is pseudonymous and logs the enumeration', async () => {
  const result = await listItemsForRequest(ids.request, dataAdmin, { limit: 5 })

  assert.match(result.subjectRef, /^SUB-[0-9a-f]{8}$/)
  assert.equal(Object.hasOwn(result, 'fullName'), false)
  for (const item of result.items) {
    assert.equal(Object.hasOwn(item, 'storagePath'), false, 'the item grid must not hand out blob paths')
  }
  assert.equal(result.totals.all, EXPECTED_ITEMS - 1)

  const logged = await prisma.accessEvent.count({
    where: { objectType: 'SUBJECT_DATA_ITEM', objectId: ids.subject, dsarRequestId: ids.request },
  })
  assert.equal(logged > 0, true, 'enumerating a person’s data must be logged')
})

test('a missing request 404s and an unprivileged role 403s before any read', async () => {
  await assert.rejects(
    () => listItemsForRequest(randomUUID(), dataAdmin, {}),
    (err) => err.statusCode === 404,
  )
  await assert.rejects(
    () => listItemsForRequest(ids.request, dataOwner, {}),
    (err) => err.statusCode === 403,
  )
})

test('a divergent index is repaired before it is served', async () => {
  // Delete an index row behind the service's back — the shape an index-refresh
  // failure leaves. The listing must not report the smaller number as the truth.
  const victim = await prisma.subjectDataItem.findFirst({
    where: { subjectId: ids.subject, deletedAt: null, sourceTable: 'photo_subjects' },
  })
  await prisma.subjectDataItem.delete({ where: { id: victim.id } })

  const page = await listSubjectItems({ subjectId: ids.subject, limit: 200 })
  assert.equal(page.index.repaired, true, 'the divergence was not detected')
  assert.equal(page.index.consistent, true, 'the index was served while still divergent')
  assert.equal(page.totals.all, EXPECTED_ITEMS - 1)
})
