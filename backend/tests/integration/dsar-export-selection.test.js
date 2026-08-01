import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'

import { prisma } from '../../src/config/prisma.js'
import { indexSubject } from '../../src/modules/dsar/itemIndex.service.js'
import { buildAccessPackage, downloadPackage } from '../../src/modules/dsar/export.service.js'
import { requestActions } from '../../src/modules/dsar/itemAction.service.js'
import { writeFile, shredFile, fileExists } from '../../src/lib/storage.js'
import { closeRedactionQueue } from '../../src/lib/redactionQueue.js'
import { closeItemActionQueue } from '../../src/lib/itemActionQueue.js'

// Phase 6. The risk this file is written against is not a missing feature — it
// is a package that is narrower than the principal thinks it is. A §11 response
// that silently omitted half of someone's data would be a false statement made
// under a statutory obligation, so every assertion here is about the package
// SAYING what it is:
//
//   * selection 'ALL' still produces the whole-subject package and still reports
//     itself as complete. Existing behaviour must not move.
//   * a narrowed package carries selection.complete === false, an itemCount and
//     an excludedCount that add up to what is held.
//   * the manifest that lands INSIDE the archive is the one the evidence row
//     describes — not a second, more flattering copy.
//   * a shared frame is counted as a redacted substitution, because the original
//     was withheld to protect someone else.
//   * an item id from another principal's grid is refused.
//
// Needs the media store (it writes and reads real sealed derivatives) and the
// DB. No Redis unless an EXPORT action is raised, which one subtest does.
//   node --test tests/integration/dsar-export-selection.test.js

const RUN = randomUUID().slice(0, 8)

const ids = {
  admin: randomUUID(),
  project: randomUUID(),
  otherProject: randomUUID(),
  session: randomUUID(),
  otherSession: randomUUID(),
  subject: randomUUID(),
  bystander: randomUUID(),
  outsider: randomUUID(),
  accessRequest: randomUUID(),
  eraseRequest: randomUUID(),
  outsiderRequest: randomUUID(),
}

const SOLO_PHOTOS = 3
const SHARED_PHOTOS = 2
const TOTAL_PHOTOS = SOLO_PHOTOS + SHARED_PHOTOS

const dataAdmin = { id: ids.admin, role: 'dataAdmin' }
const writtenPaths = []

// A minimal ZIP reader for the first entry only — enough to prove manifest.json
// is really in the archive and says what the evidence row says. lib/zip.js
// writes stored or deflated entries with no ZIP64 and no data descriptor, so the
// local header is complete and the payload follows it directly.
function readFirstZipEntry(buffer) {
  assert.equal(buffer.readUInt32LE(0), 0x04034b50, 'not a zip local header')
  const method = buffer.readUInt16LE(8)
  const compressedSize = buffer.readUInt32LE(18)
  const nameLen = buffer.readUInt16LE(26)
  const extraLen = buffer.readUInt16LE(28)
  const start = 30 + nameLen + extraLen
  const name = buffer.subarray(30, 30 + nameLen).toString('utf8')
  const payload = buffer.subarray(start, start + compressedSize)
  return { name, data: method === 8 ? inflateRawSync(payload) : payload }
}

async function seedSubject(masterUserId, name) {
  await prisma.subject.create({
    data: {
      masterUserId,
      group: 'VOLUNTEER',
      status: 'ACTIVE',
      fullName: `${RUN} ${name}`,
      email: `${name.toLowerCase()}-${RUN}@exportsel.test`,
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
    data: { id: ids.admin, email: `admin-${RUN}@exportsel.test`, role: 'dataAdmin', status: 'ACTIVE' },
  })
  await prisma.project.createMany({
    data: [
      { id: ids.project, name: `export-sel ${RUN}`, purpose: 'testing', status: 'ACTIVE', ownerAdminId: ids.admin },
      { id: ids.otherProject, name: `export-sel other ${RUN}`, purpose: 'testing', status: 'ACTIVE', ownerAdminId: ids.admin },
    ],
  })

  const consent = await seedSubject(ids.subject, 'Devika')
  const bystanderConsent = await seedSubject(ids.bystander, 'Rohit')
  await seedSubject(ids.outsider, 'Yusuf')

  await prisma.session.createMany({
    data: [
      { id: ids.session, code: `EX-${randomUUID().slice(0, 8)}`, projectId: ids.project, agentId: ids.admin, status: 'ARCHIVED' },
      { id: ids.otherSession, code: `EX-${randomUUID().slice(0, 8)}`, projectId: ids.otherProject, agentId: ids.admin, status: 'ARCHIVED' },
    ],
  })

  for (let n = 0; n < TOTAL_PHOTOS; n += 1) {
    // The last photo lives on the second project so a projectId filter has
    // something to exclude.
    const sessionId = n === TOTAL_PHOTOS - 1 ? ids.otherSession : ids.session
    const redactedPath = `sessions/${sessionId}/redacted/${RUN}-${n}.jpg`
    // Real bytes through the sealed writer: the package reads derivatives back
    // through storage.readFile, so a fixture that skipped sealing would exercise
    // a path the product does not have.
    await writeFile(redactedPath, Buffer.from(`redacted-derivative-${RUN}-${n}`.repeat(8), 'utf8'))
    writtenPaths.push(redactedPath)

    const photo = await prisma.photo.create({
      data: {
        sessionId,
        storagePath: `sessions/${sessionId}/original/${RUN}-${n}.jpg`,
        redactedPath,
        piiStatus: 'CLEAN',
        cameraSource: 'IPHONE_UPLOAD',
        sha256: `${RUN}-${n}-${randomUUID()}`,
        mimeType: 'image/jpeg',
        sizeBytes: 2048,
        takenAt: new Date(Date.UTC(2026, 6, 10, 9, n)),
      },
    })
    await prisma.photoSubject.create({
      data: { photoId: photo.id, subjectId: ids.subject, consentId: consent.consentId },
    })
    if (n >= SOLO_PHOTOS) {
      await prisma.photoSubject.create({
        data: { photoId: photo.id, subjectId: ids.bystander, consentId: bystanderConsent.consentId },
      })
    }
  }

  const outsiderPhoto = await prisma.photo.create({
    data: {
      sessionId: ids.session,
      storagePath: `sessions/${ids.session}/original/${RUN}-outsider.jpg`,
      cameraSource: 'IPHONE_UPLOAD',
      sha256: `${RUN}-outsider-${randomUUID()}`,
      mimeType: 'image/jpeg',
      sizeBytes: 2048,
    },
  })
  await prisma.photoSubject.create({ data: { photoId: outsiderPhoto.id, subjectId: ids.outsider } })

  await prisma.dsarRequest.createMany({
    data: [
      { id: ids.accessRequest, subjectId: ids.subject, type: 'ACCESS', status: 'DISCOVERY', channel: 'PORTAL', slaDueAt: new Date(Date.now() + 30 * 86_400_000) },
      { id: ids.eraseRequest, subjectId: ids.subject, type: 'ERASE', status: 'DISCOVERY', channel: 'PORTAL', slaDueAt: new Date(Date.now() + 30 * 86_400_000) },
      { id: ids.outsiderRequest, subjectId: ids.outsider, type: 'ACCESS', status: 'DISCOVERY', channel: 'PORTAL', slaDueAt: new Date(Date.now() + 30 * 86_400_000) },
    ],
  })

  await indexSubject(ids.subject)
  await indexSubject(ids.bystander)
  await indexSubject(ids.outsider)
})

test.after(async () => {
  try {
    const packages = await prisma.dsarEvidence.findMany({
      where: { dsarRequestId: { in: [ids.accessRequest, ids.eraseRequest] }, storagePath: { not: null } },
      select: { storagePath: true },
    })
    for (const p of [...packages.map((p) => p.storagePath), ...writtenPaths]) {
      if (await fileExists(p)) await shredFile(p)
    }
    await prisma.dsarRequest.deleteMany({
      where: { id: { in: [ids.accessRequest, ids.eraseRequest, ids.outsiderRequest] } },
    })
    await prisma.subject.deleteMany({
      where: { masterUserId: { in: [ids.subject, ids.bystander, ids.outsider] } },
    })
    await prisma.session.deleteMany({ where: { id: { in: [ids.session, ids.otherSession] } } })
    await prisma.project.deleteMany({ where: { id: { in: [ids.project, ids.otherProject] } } })
    await prisma.adminUser.deleteMany({ where: { id: ids.admin } })
  } finally {
    await Promise.allSettled([closeRedactionQueue(), closeItemActionQueue()])
    await prisma.$disconnect()
  }
})

async function selectionOf(evidenceId) {
  const evidence = await prisma.dsarEvidence.findUnique({ where: { id: evidenceId } })
  return { evidence, selection: evidence.payload.selection }
}

test("the default package is unchanged: whole subject, and it says so", async () => {
  const pkg = await buildAccessPackage(ids.accessRequest, dataAdmin)
  const { evidence, selection } = await selectionOf(pkg.evidenceId)

  assert.equal(selection.mode, 'ALL')
  assert.equal(selection.complete, true)
  assert.equal(selection.itemCount, TOTAL_PHOTOS, 'every held photo should be in the default package')
  assert.equal(selection.excludedCount, 0)
  assert.equal(
    selection.redactedSubstitutions,
    SHARED_PHOTOS,
    'a frame holding another principal ships as a redacted derivative and must be counted as such',
  )
  assert.equal(evidence.payload.photosIncluded, TOTAL_PHOTOS)
  assert.equal(evidence.kind, 'EXPORT_PACKAGE')
  assert.ok(pkg.token, 'the download token is minted exactly once, here')
})

test('the manifest inside the archive is the one the evidence row describes', async () => {
  const pkg = await buildAccessPackage(ids.accessRequest, dataAdmin)
  const { selection } = await selectionOf(pkg.evidenceId)

  const { buffer } = await downloadPackage(ids.accessRequest, pkg.token)
  const first = readFirstZipEntry(buffer)
  assert.equal(first.name, 'manifest.json', 'the manifest must be the first entry')

  const manifest = JSON.parse(first.data.toString('utf8'))
  assert.deepEqual(manifest.selection, JSON.parse(JSON.stringify(selection)))
  assert.equal(manifest.photos.length, TOTAL_PHOTOS, 'the manifest lists every photo, included or not')
  assert.equal(manifest.photos.filter((p) => p.included).length, TOTAL_PHOTOS)
  assert.equal(manifest.photos.filter((p) => p.sharedFrame).length, SHARED_PHOTOS)
  // Invariant 3, re-asserted where it would be easiest to break: a package is
  // the one artifact that leaves the building. The manifest is allowed to SAY
  // how many templates are held (§11 asks for a summary of processing); what it
  // may never carry is a template. So the check is for a vector, not for the
  // word — `embeddingsHeld: 1` is the disclosure working correctly.
  const walk = (node, path = '$') => {
    if (Array.isArray(node)) {
      assert.equal(
        node.length > 16 && node.every((v) => typeof v === 'number'),
        false,
        `${path} looks like a face template — no embedding may leave in a package`,
      )
      node.forEach((v, i) => walk(v, `${path}[${i}]`))
      return
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        assert.notEqual(k, 'embedding', `${path}.${k} is a raw embedding field`)
        walk(v, `${path}.${k}`)
      }
    }
  }
  walk(manifest)
  assert.equal(typeof manifest.biometrics.embeddingsHeld, 'number', 'the §11 summary still states the count')
})

test('an itemIds selection narrows the package and refuses to call itself complete', async () => {
  const items = await prisma.subjectDataItem.findMany({
    where: { subjectId: ids.subject, deletedAt: null, sharedSubjectCount: 1 },
    orderBy: { capturedAt: 'asc' },
    take: 2,
  })
  assert.equal(items.length, 2)

  const pkg = await buildAccessPackage(ids.accessRequest, dataAdmin, {
    selection: { itemIds: items.map((i) => i.id) },
  })
  const { selection } = await selectionOf(pkg.evidenceId)

  assert.equal(selection.mode, 'ITEM_IDS')
  assert.equal(selection.complete, false, 'a narrowed package must never read as the complete §11 answer')
  assert.equal(selection.itemCount, 2)
  assert.equal(selection.excludedCount, TOTAL_PHOTOS - 2)
  assert.equal(selection.excludedBySelection, TOTAL_PHOTOS - 2)
  assert.equal(selection.itemCount + selection.excludedCount, TOTAL_PHOTOS, 'the counts must account for everything held')
  assert.equal(selection.redactedSubstitutions, 0, 'no shared frame was selected')

  const { buffer } = await downloadPackage(ids.accessRequest, pkg.token)
  const manifest = JSON.parse(readFirstZipEntry(buffer).data.toString('utf8'))
  const excluded = manifest.photos.filter((p) => !p.included)
  assert.equal(excluded.length, TOTAL_PHOTOS - 2)
  for (const p of excluded) assert.match(p.reason, /^NOT_SELECTED/)
})

test('a filter selection resolves server-side against the item index', async () => {
  const pkg = await buildAccessPackage(ids.accessRequest, dataAdmin, {
    selection: { filter: { projectId: ids.otherProject } },
  })
  const { selection } = await selectionOf(pkg.evidenceId)

  assert.equal(selection.mode, 'FILTER')
  assert.equal(selection.complete, false)
  assert.equal(selection.itemCount, 1, 'only the frame on the second project should be packaged')
  assert.equal(selection.excludedCount, TOTAL_PHOTOS - 1)
})

test("'SELECTED' packages exactly what a Phase 5 EXPORT action marked", async () => {
  const items = await prisma.subjectDataItem.findMany({
    where: { subjectId: ids.subject, deletedAt: null },
    orderBy: { capturedAt: 'asc' },
    take: 3,
  })

  await requestActions(
    { dsarRequestId: ids.accessRequest, itemIds: items.map((i) => i.id), kind: 'EXPORT' },
    dataAdmin,
    { inline: true },
  )

  const pkg = await buildAccessPackage(ids.accessRequest, dataAdmin, { selection: 'SELECTED' })
  const { selection } = await selectionOf(pkg.evidenceId)

  assert.equal(selection.mode, 'SELECTED')
  assert.equal(selection.markedItems, 3)
  assert.equal(selection.itemCount, 3)
  assert.equal(selection.complete, false)
})

test('an item from another principal cannot be packaged into this request', async () => {
  const foreign = await prisma.subjectDataItem.findFirst({ where: { subjectId: ids.outsider } })
  assert.ok(foreign)

  await assert.rejects(
    () => buildAccessPackage(ids.accessRequest, dataAdmin, { selection: { itemIds: [foreign.id] } }),
    (err) => err.statusCode === 403,
  )
})

test('a handler may package a non-ACCESS request; an unattributed caller may not', async () => {
  const pkg = await buildAccessPackage(ids.eraseRequest, dataAdmin, { selection: 'ALL' })
  const { evidence } = await selectionOf(pkg.evidenceId)
  assert.equal(evidence.kind, 'EXPORT_PACKAGE', 'a handler-initiated export is recorded as evidence like any other')

  await assert.rejects(
    () => buildAccessPackage(ids.eraseRequest, null, { selection: 'ALL' }),
    (err) => err.statusCode === 400 && /does not produce an access package/.test(err.message),
  )
})

test('per-photo hashes are stable across two builds of the same selection', async () => {
  // Built and downloaded one at a time. downloadPackage resolves the LATEST
  // EXPORT_PACKAGE evidence row for the request, so building twice before
  // downloading would present the first token against the second row and fail
  // as an invalid token — which says nothing about hash stability.
  const manifestOf = async (pkg) => {
    const { buffer } = await downloadPackage(ids.accessRequest, pkg.token)
    return JSON.parse(readFirstZipEntry(buffer).data.toString('utf8'))
  }

  const a = await manifestOf(await buildAccessPackage(ids.accessRequest, dataAdmin))
  const b = await manifestOf(await buildAccessPackage(ids.accessRequest, dataAdmin))

  const hashes = (m) =>
    Object.fromEntries(m.photos.filter((p) => p.included).map((p) => [p.photoId, p.sha256]))
  assert.deepEqual(hashes(a), hashes(b), 'the same bytes must hash the same on every build')
  // The archive hash itself is deliberately NOT asserted stable: the manifest
  // carries generatedAt, so two builds a second apart are different documents.
  assert.notEqual(a.generatedAt, undefined)
  for (const [, sha] of Object.entries(hashes(a))) {
    assert.equal(sha.length, 64, 'a sha256 hex digest')
  }
  assert.equal(
    createHash('sha256').update('probe').digest('hex').length,
    64,
  )
})

test('a single-use download link cannot be redeemed twice', async () => {
  const pkg = await buildAccessPackage(ids.accessRequest, dataAdmin)
  await downloadPackage(ids.accessRequest, pkg.token)
  await assert.rejects(
    () => downloadPackage(ids.accessRequest, pkg.token),
    (err) => err.statusCode === 410,
  )
})
