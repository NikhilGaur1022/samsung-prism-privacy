import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import sharp from 'sharp'

import { prisma } from '../../src/config/prisma.js'
import { redis } from '../../src/config/redis.js'
import { writeFile, resolvePath, fileExists } from '../../src/lib/storage.js'
import { findSubjectResidue, findOrphans, findDanglingReferences } from '../../src/lib/storageSweep.js'
import { deleteRowsAndBlobs, loadReferencedPaths } from '../../src/lib/blobLifecycle.js'
import { closeFaceQueue } from '../../src/lib/faceQueue.js'
import { closeRedactionQueue } from '../../src/lib/redactionQueue.js'
import { closePurgeQueue } from '../../src/lib/purgeQueue.js'

// The test that makes the deletion certificate honest.
//
// It has to sweep the FILESYSTEM, and that is the whole point. Discovery
// (discovery.service.js) and purge (purge.service.js) both enumerate a subject's
// blobs by walking the rows that point at them, so a row-based test cannot see a
// row-based bug — and the bug was exactly that: 1,123 files under the media root
// (265 MB) referenced by no row at all, including 383 cropped face images and
// 135 enrolment selfies. An erasure completed, a certificate was signed, and 518
// biometric files stayed on disk.

const RUN = randomUUID().slice(0, 8)
const fx = {}

async function makeJpeg(seed) {
  return sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: seed % 255, g: 80, b: 120 } },
  })
    .jpeg()
    .toBuffer()
}

test.before(async () => {
  fx.subject = await prisma.subject.create({
    data: {
      fullName: `Erasure Fixture ${RUN}`,
      email: `erasure-${RUN}@test.invalid`,
      group: 'VOLUNTEER',
      status: 'ACTIVE',
      registrationChannel: 'SELF',
    },
  })

  fx.owner = await prisma.adminUser.create({
    data: { email: `erasure-${RUN}-owner@test.invalid`, role: 'dataOwner', status: 'ACTIVE' },
  })
  fx.agent = await prisma.adminUser.create({
    data: { email: `erasure-${RUN}-agent@test.invalid`, role: 'collectionAgent', status: 'ACTIVE' },
  })

  fx.project = await prisma.project.create({
    data: {
      name: `Erasure ${RUN}`,
      purpose: 'erasure-completeness fixture',
      ownerAdminId: fx.owner.id,
      status: 'APPROVED',
    },
  })

  fx.session = await prisma.session.create({
    data: {
      code: `ERZ-${RUN}`,
      projectId: fx.project.id,
      agentId: fx.agent.id,
      status: 'ACTIVE',
    },
  })
})

test.after(async () => {
  // Everything this file wrote, whether or not an assertion got that far.
  for (const p of fx.writtenPaths ?? []) {
    await fs.rm(resolvePath(p), { force: true }).catch(() => {})
  }
  await prisma.faceDetection.deleteMany({ where: { photo: { sessionId: fx.session?.id } } })
  await prisma.photo.deleteMany({ where: { sessionId: fx.session?.id } })
  await prisma.session.deleteMany({ where: { code: `ERZ-${RUN}` } })
  await prisma.project.deleteMany({ where: { name: `Erasure ${RUN}` } })
  await prisma.subject.deleteMany({ where: { email: { contains: `erasure-${RUN}` } } })
  await prisma.adminUser.deleteMany({ where: { email: { contains: `erasure-${RUN}-` } } })
  await prisma.orphanBlob.deleteMany({ where: { storagePath: { contains: RUN } } })

  await Promise.allSettled([
    closeFaceQueue(),
    closeRedactionQueue(),
    closePurgeQueue(),
    redis.quit(),
    prisma.$disconnect(),
  ])
})

// ---------------------------------------------------------------------------

test('deleting face detections takes their crops off disk with them', async () => {
  const buffer = await makeJpeg(1)
  const photoPath = `sessions/${fx.session.id}/photos/erz-${RUN}.jpg`
  await writeFile(photoPath, buffer)

  const photo = await prisma.photo.create({
    data: {
      sessionId: fx.session.id,
      storagePath: photoPath,
      cameraSource: 'IPHONE_UPLOAD',
      sha256: createHash('sha256').update(buffer).digest('hex'),
      mimeType: 'image/jpeg',
      sizeBytes: buffer.length,
    },
  })

  // Three crops, as a recognition pass would write them.
  const cropPaths = []
  for (let i = 0; i < 3; i += 1) {
    const cropPath = `sessions/${fx.session.id}/crops/erz-${RUN}-${i}.jpg`
    await writeFile(cropPath, await makeJpeg(i + 10))
    cropPaths.push(cropPath)
    await prisma.faceDetection.create({
      data: { photoId: photo.id, bbox: [0, 0, 10, 10], cropPath },
    })
  }
  fx.writtenPaths = [photoPath, ...cropPaths]

  for (const p of cropPaths) {
    assert.ok(await fileExists(p), `crop ${p} should exist before the delete`)
  }

  // The re-run path. Before deleteRowsAndBlobs it dropped every FaceDetection
  // row and left every crop on disk — one of the two confirmed routes by which
  // 383 orphaned biometric files were manufactured.
  const result = await deleteRowsAndBlobs({
    reason: `TEST_RECOGNITION_RERUN_${RUN}`,
    collectPaths: async (tx) => {
      const rows = await tx.faceDetection.findMany({
        where: { photo: { sessionId: fx.session.id } },
        select: { cropPath: true },
      })
      return rows.map((r) => r.cropPath)
    },
    deleteRows: async (tx) => {
      await tx.faceDetection.deleteMany({ where: { photo: { sessionId: fx.session.id } } })
    },
  })

  assert.equal(result.shredded, 3, 'all three crops should have been shredded')
  assert.deepEqual(result.failed, [], 'no crop should have failed to delete')

  const remaining = []
  for (const p of cropPaths) {
    if (await fileExists(p)) remaining.push(p)
  }
  assert.deepEqual(
    remaining,
    [],
    'cropped face images survived the deletion of their rows. Files in that state ' +
      'are invisible to DSAR discovery and unreachable by purge, so a signed ' +
      'deletion certificate would attest to an erasure that did not happen.',
  )

  // And the rows really are gone, so this is not a vacuous pass.
  const rows = await prisma.faceDetection.count({ where: { photo: { sessionId: fx.session.id } } })
  assert.equal(rows, 0)
})

test('the paths are collected BEFORE the rows are deleted', async () => {
  // The ordering is the whole mechanism. Collecting after the delete returns an
  // empty list and the files are unrecoverable, which is precisely how the
  // orphans were made — so this asserts the contract rather than the outcome.
  const order = []

  await deleteRowsAndBlobs({
    reason: `TEST_ORDERING_${RUN}`,
    collectPaths: async () => {
      order.push('collect')
      return []
    },
    deleteRows: async () => {
      order.push('delete')
    },
  })

  assert.deepEqual(order, ['collect', 'delete'])
})

test('a filesystem sweep finds a blob whose row is gone', async () => {
  // Written directly with no row, which is exactly the state 83% of the media
  // store was in.
  const orphanPath = `sessions/${fx.session.id}/crops/orphan-${RUN}.jpg`
  await writeFile(orphanPath, await makeJpeg(42))
  fx.writtenPaths.push(orphanPath)

  const { referenced } = await loadReferencedPaths()
  assert.ok(
    !referenced.has(orphanPath),
    'the fixture orphan must not be referenced, or this test proves nothing',
  )

  const { orphans } = await findOrphans()
  const found = orphans.some((o) => o.path === orphanPath)
  assert.ok(found, 'the filesystem sweep did not find a file that no row references')
})

test('loadReferencedPaths refuses to return a partial reference set', async () => {
  // A partial read would classify live media as orphaned, and an orphan sweep
  // that deletes referenced media is far worse than the orphans it cleans up.
  // The guard is that a model named in PATH_COLUMNS but absent from the client
  // throws rather than being skipped.
  const { PATH_COLUMNS } = await import('../../src/lib/blobLifecycle.js')
  for (const { model } of PATH_COLUMNS) {
    assert.ok(
      typeof prisma[model]?.findMany === 'function',
      `PATH_COLUMNS names "${model}", which is not on the Prisma client — the ` +
        'reference set would silently omit every path in that table.',
    )
  }
})

test('subject residue search reaches files named for the subject', async () => {
  // The per-person redacted cache is written as
  // `<photoId>.person-<subjectId>.jpg`, so it lives under the SESSION prefix and
  // carries the subject id only in its filename. A row-based walk loses it the
  // moment its row is gone; a prefix-only sweep never had it.
  const subjectId = fx.subject.masterUserId
  const cachePath = `sessions/${fx.session.id}/redacted/cache-${RUN}.person-${subjectId}.jpg`
  await writeFile(cachePath, await makeJpeg(7))
  fx.writtenPaths.push(cachePath)

  const residue = await findSubjectResidue(prisma, subjectId)
  assert.ok(
    residue.includes(cachePath),
    'the residue sweep missed a file carrying the subject id in its name — this is ' +
      'the file a purge would leave behind while the certificate said otherwise',
  )
})

test('dangling references are detectable', async () => {
  // The mirror problem: a row pointing at a file that is not there. 167 of these
  // existed, 88 in the DSAR index, so a package build either failed at read time
  // or silently shipped short while totals.all counted the item.
  const missingPath = `sessions/${fx.session.id}/photos/never-written-${RUN}.jpg`
  const buffer = await makeJpeg(9)

  const photo = await prisma.photo.create({
    data: {
      sessionId: fx.session.id,
      storagePath: missingPath,
      cameraSource: 'IPHONE_UPLOAD',
      sha256: createHash('sha256').update(buffer).digest('hex'),
      mimeType: 'image/jpeg',
      sizeBytes: buffer.length,
    },
  })

  const dangling = await findDanglingReferences()
  assert.ok(
    dangling.includes(missingPath),
    'a row pointing at a missing file was not reported as a dangling reference',
  )

  await prisma.photo.delete({ where: { id: photo.id } })
})
