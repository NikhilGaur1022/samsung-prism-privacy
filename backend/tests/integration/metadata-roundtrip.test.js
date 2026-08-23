// Loads .env so the signing key is available. Every other suite gets this by
// importing config/prisma.js; this one touches no database, so it says so here.
import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

import {
  stampImage,
  readStamp,
  verifyStamp,
  signStamp,
  buildStampPayload,
  subjectRefFor,
  formatSupportsStamp,
} from '../../src/lib/imageMetadata.js'
import { zipStream, zipToBuffer } from '../../src/lib/zipStream.js'

// The metadata requirement, tested the only way that means anything: write the
// bytes, put them through what a real user does to them, and read them back.
//
// The requirement was 0% implemented — a repo-wide grep for
// `exif|xmp|iptc|withMetadata` across backend/src returned one hit and it was a
// comment — and the ingest transform actively DESTROYED what the camera wrote.
// So the tests that matter are: does the stamp go in, does it survive a rename,
// does it survive the archive, and does tampering show.

const RUN = randomUUID().slice(0, 8)
let tmpDir

async function makeJpeg(seed = 1) {
  return sharp({
    create: { width: 48, height: 36, channels: 3, background: { r: seed % 255, g: 90, b: 140 } },
  })
    .jpeg({ quality: 92 })
    .toBuffer()
}

const FIELDS = {
  projectId: `proj-${RUN}`,
  exportId: `exp-${RUN}`,
  photoId: `photo-${RUN}`,
  consentId: `consent-${RUN}`,
  captureSessionId: `sess-${RUN}`,
  redaction: 'REDACTED',
}

test.before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `prism-md-${RUN}-`))
})

test.after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

// ---------------------------------------------------------------------------

test('a stamped image reads back with the project and the people on it', async () => {
  const src = await makeJpeg()
  const subjectRefs = [subjectRefFor('subject-one', FIELDS.exportId), subjectRefFor('subject-two', FIELDS.exportId)]

  const { buffer } = await stampImage(src, { ...FIELDS, subjectRefs })
  const read = await readStamp(buffer)

  assert.equal(read.found, true, 'no stamp was found in the image')
  assert.equal(read.valid, true, 'the stamp did not verify')
  assert.equal(read.payload.projectId, FIELDS.projectId)
  assert.equal(read.payload.captureSessionId, FIELDS.captureSessionId)
  assert.equal(read.payload.redaction, 'REDACTED')
  assert.deepEqual(read.payload.subjectRefs.sort(), [...subjectRefs].sort())
})

test('the stamp carries no name and no email', async () => {
  // Embedding an identity into an image that leaves the platform creates new
  // personal data in a less-controlled place, and it fights crypto-shred
  // directly: once a downloaded image has a subject id baked in, erasure cannot
  // reach it. So the stamp is pseudonymous by construction and this asserts it.
  const src = await makeJpeg()
  const { buffer, payload } = await stampImage(src, {
    ...FIELDS,
    subjectRefs: [subjectRefFor('subject-one', FIELDS.exportId)],
  })

  const asText = JSON.stringify(payload)
  for (const forbidden of ['@', 'fullName', 'email', 'name']) {
    assert.ok(
      !asText.includes(forbidden),
      `the stamp payload contains "${forbidden}" — it must carry pseudonyms only`,
    )
  }

  // And the same at byte level, in case a field is added later that serialises
  // somewhere the payload check misses.
  assert.ok(
    !buffer.toString('latin1').includes('@test'),
    'an address appears in the stamped image bytes',
  )
})

test('a subjectRef is scoped to its export and cannot be correlated across two', async () => {
  const a = subjectRefFor('the-same-person', 'export-one')
  const b = subjectRefFor('the-same-person', 'export-two')
  assert.notEqual(a, b, 'the same subject produced the same ref in two exports')
  assert.equal(a, subjectRefFor('the-same-person', 'export-one'), 'the ref is not deterministic')
  assert.ok(!a.includes('the-same-person'), 'the ref leaks the subject id')
})

test('the stamp survives renaming every file', async () => {
  // The requirement names this case explicitly, and it is the one people
  // actually hit: files get renamed on the way into a dataset.
  const src = await makeJpeg(3)
  const { buffer } = await stampImage(src, {
    ...FIELDS,
    subjectRefs: [subjectRefFor('subject-one', FIELDS.exportId)],
  })

  const original = path.join(tmpDir, 'IMG_0001.jpg')
  await fs.writeFile(original, buffer)

  // Rename, copy under another name, and move into a subdirectory — three
  // separate things a user does, all of which change the path and none of which
  // should change the content.
  const renamed = path.join(tmpDir, 'subject-photo-final-v2.jpg')
  await fs.rename(original, renamed)

  const nested = path.join(tmpDir, 'nested')
  await fs.mkdir(nested, { recursive: true })
  const moved = path.join(nested, 'anything-at-all.jpeg')
  await fs.copyFile(renamed, moved)

  for (const file of [renamed, moved]) {
    const read = await readStamp(await fs.readFile(file))
    assert.equal(read.valid, true, `the stamp did not survive being written as ${path.basename(file)}`)
    assert.equal(read.payload.photoId, FIELDS.photoId)
  }
})

test('the stamp survives an archive round trip', async () => {
  const entries = []
  for (let i = 0; i < 5; i += 1) {
    const src = await makeJpeg(i)
    const { buffer } = await stampImage(src, {
      ...FIELDS,
      photoId: `photo-${RUN}-${i}`,
      subjectRefs: [subjectRefFor(`subject-${i}`, FIELDS.exportId)],
    })
    entries.push({ name: `photos/session-a/${i}.jpg`, data: buffer })
  }

  const archive = await zipToBuffer(entries)
  const archivePath = path.join(tmpDir, 'export.zip')
  await fs.writeFile(archivePath, archive)

  // Read back through the archive's own central directory rather than trusting
  // the writer: this is the only check that the ZIP is well-formed AND that the
  // stamped bytes came out unaltered.
  const { execFileSync } = await import('node:child_process')
  let extracted = null
  try {
    const out = path.join(tmpDir, 'unzipped')
    await fs.mkdir(out, { recursive: true })
    execFileSync(
      process.platform === 'win32' ? 'powershell' : 'unzip',
      process.platform === 'win32'
        ? ['-NoProfile', '-Command', `Expand-Archive -Path '${archivePath}' -DestinationPath '${out}' -Force`]
        : ['-o', archivePath, '-d', out],
      { stdio: 'ignore' },
    )
    extracted = out
  } catch {
    // No extractor available in this environment. The archive's own bytes are
    // still checked below, so the test degrades rather than passing vacuously.
    extracted = null
  }

  if (extracted) {
    for (let i = 0; i < 5; i += 1) {
      const file = path.join(extracted, 'photos', 'session-a', `${i}.jpg`)
      const read = await readStamp(await fs.readFile(file))
      assert.equal(read.valid, true, `image ${i} lost its stamp in the archive`)
      assert.equal(read.payload.photoId, `photo-${RUN}-${i}`)
    }
  } else {
    // Fall back to asserting the stamps are present in the archive bytes, which
    // at least proves the writer did not strip or re-encode them.
    const text = archive.toString('latin1')
    const stampCount = (text.match(/PRISM1\./g) ?? []).length
    assert.ok(stampCount >= 5, `expected 5 stamps in the archive, found ${stampCount}`)
  }
})

test('an altered payload fails verification', async () => {
  const src = await makeJpeg(4)
  const { stamp } = await stampImage(src, {
    ...FIELDS,
    subjectRefs: [subjectRefFor('subject-one', FIELDS.exportId)],
  })

  assert.equal(verifyStamp(stamp).valid, true)

  const [prefix, body, signature, keyId] = stamp.split('.')
  const decoded = Buffer.from(body, 'base64url').toString('utf8')
  const forgedBody = decoded.replace(FIELDS.projectId, 'some-other-project')
  assert.notEqual(forgedBody, decoded, 'the fixture did not actually change anything')

  const forged = [prefix, Buffer.from(forgedBody, 'utf8').toString('base64url'), signature, keyId].join('.')
  const result = verifyStamp(forged)

  assert.equal(result.valid, false, 'a rewritten payload verified — the stamp is not tamper-evident')
  assert.equal(result.reason, 'BAD_SIGNATURE')
})

test('the stamp records a hash of the image it was written into', async () => {
  // The hash is of the image BEFORE stamping, because a stamp cannot cover
  // itself. That is what makes it possible to detect pixels changed after
  // export.
  const src = await makeJpeg(5)
  const { payload } = await stampImage(src, {
    ...FIELDS,
    subjectRefs: [subjectRefFor('subject-one', FIELDS.exportId)],
  })
  assert.equal(payload.contentHash, createHash('sha256').update(src).digest('hex'))
})

test('a format that cannot carry EXIF is reported, not silently shipped', async () => {
  // sharp writes EXIF on JPEG, WebP and AVIF but not PNG — PNG needs tEXt/iTXt
  // chunks. A manifest claiming every image is stamped while some are not is the
  // kind of small lie an auditor finds, so the capability is checked rather than
  // assumed.
  assert.equal(formatSupportsStamp('image/jpeg'), true)
  assert.equal(formatSupportsStamp('image/webp'), true)
  assert.equal(formatSupportsStamp('image/png'), false)
})

test('a manifest signature verifies independently of the images', async () => {
  const manifestBody = { files: ['a.jpg', 'b.jpg'], counts: { photos: 2 } }
  const signature = signStamp(
    buildStampPayload({
      projectId: FIELDS.projectId,
      exportId: FIELDS.exportId,
      photoId: 'MANIFEST',
      subjectRefs: [],
      redaction: 'REDACTED',
      contentHash: createHash('sha256').update(JSON.stringify(manifestBody)).digest('hex'),
    }),
  )

  const result = verifyStamp(signature)
  assert.equal(result.valid, true, 'the manifest signature did not verify')
  assert.equal(result.payload.photoId, 'MANIFEST')
})
