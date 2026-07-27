import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

// Env must be set BEFORE the modules under test are imported: storage.js resolves
// ENCRYPTION_ENABLED once at module load, which is the behaviour we want in
// production and the reason this file uses dynamic imports.
const TEST_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-crypto-'))
process.env.MEDIA_KEK = randomBytes(32).toString('base64')
process.env.MEDIA_ENCRYPTION = 'on'
process.env.STORAGE_ROOT = TEST_ROOT

const { sealBlob, openBlob, isSealed, readHeader, HEADER_BYTES, MAGIC } = await import(
  '../../src/lib/blobCrypto.js'
)
const { writeFile, readFile, shredFile } = await import('../../src/lib/storage.js')
const { deriveProjectKey } = await import('../../src/lib/keyring.js')

// A real JPEG starts FF D8 FF and ends FF D9. The whole point of encryption at
// rest is that a sealed file has neither.
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
function fakeJpeg(size = 4096) {
  const body = randomBytes(size)
  return Buffer.concat([JPEG_MAGIC, body, Buffer.from([0xff, 0xd9])])
}

test('sealBlob → openBlob round-trips exactly', () => {
  const { key, keyId } = deriveProjectKey('11111111-1111-4111-8111-111111111111')
  const plaintext = fakeJpeg()

  const sealed = sealBlob(plaintext, key, keyId)
  const opened = openBlob(sealed, key, keyId)

  assert.deepEqual(opened, plaintext)
  assert.equal(
    createHash('sha256').update(opened).digest('hex'),
    createHash('sha256').update(plaintext).digest('hex'),
  )
})

test('a sealed blob carries the PRSM header and no JPEG magic', () => {
  const { key, keyId } = deriveProjectKey('22222222-2222-4222-8222-222222222222')
  const plaintext = fakeJpeg()
  const sealed = sealBlob(plaintext, key, keyId)

  assert.ok(isSealed(sealed))
  assert.deepEqual(sealed.subarray(0, MAGIC.length), MAGIC)
  assert.equal(readHeader(sealed).keyId.length > 0, true)

  // The ciphertext must not contain the JPEG SOI marker anywhere. Checking only
  // the first bytes would pass even if the body were stored verbatim after a
  // header, which is the mistake this asserts against.
  assert.equal(sealed.includes(JPEG_MAGIC), false, 'JPEG magic found inside the sealed blob')
  assert.equal(sealed.length, HEADER_BYTES + plaintext.length)
})

test('flipping one ciphertext byte triggers GCM authentication failure', () => {
  const { key, keyId } = deriveProjectKey('33333333-3333-4333-8333-333333333333')
  const sealed = sealBlob(fakeJpeg(), key, keyId)

  const tampered = Buffer.from(sealed)
  tampered[HEADER_BYTES + 10] ^= 0x01

  assert.throws(() => openBlob(tampered, key, keyId), /auth|integrity|tag|unable to authenticate/i)
})

test('truncation is detected', () => {
  const { key, keyId } = deriveProjectKey('44444444-4444-4444-8444-444444444444')
  const sealed = sealBlob(fakeJpeg(), key, keyId)
  assert.throws(() => openBlob(sealed.subarray(0, sealed.length - 32), key, keyId))
})

test('the wrong key cannot open a blob', () => {
  const a = deriveProjectKey('55555555-5555-4555-8555-555555555555')
  const b = deriveProjectKey('66666666-6666-4666-8666-666666666666')
  const sealed = sealBlob(fakeJpeg(), a.key, a.keyId)

  assert.throws(() => openBlob(sealed, b.key, a.keyId))
})

test('storage.writeFile leaves no plaintext on disk and readFile returns it intact', async () => {
  const plaintext = fakeJpeg()
  const relative = 'sessions/aaaa/photos/bbbb.jpg'

  const { keyId, encrypted } = await writeFile(relative, plaintext)
  assert.equal(encrypted, true, 'encryption must be on for this suite')
  assert.ok(keyId)

  const onDisk = await fs.readFile(path.join(TEST_ROOT, relative))
  assert.notDeepEqual(onDisk, plaintext)
  assert.equal(onDisk.includes(JPEG_MAGIC), false, 'plaintext JPEG magic present on disk')
  assert.ok(isSealed(onDisk))

  const readBack = await readFile(relative)
  assert.deepEqual(readBack, plaintext)
})

test('shredFile destroys the envelope header, not just the directory entry', async () => {
  const relative = 'sessions/aaaa/photos/cccc.jpg'
  await writeFile(relative, fakeJpeg())
  const full = path.join(TEST_ROOT, relative)

  await shredFile(relative)

  // Either the file is gone, or if an inode were recovered its header must no
  // longer be openable — the nonce and tag live there, so overwriting them makes
  // the remaining ciphertext useless.
  const stillThere = await fs
    .readFile(full)
    .then((b) => b)
    .catch(() => null)
  if (stillThere) {
    assert.equal(isSealed(stillThere), false, 'shredded file still presents a valid envelope header')
  }
  await assert.rejects(() => readFile(relative))
})

test('embedding round-trips and a tampered embedding fails to decrypt', async () => {
  process.env.FACE_EMBEDDING_KEY ??= randomBytes(32).toString('base64')
  const { encryptEmbedding, decryptEmbedding } = await import('../../src/lib/embeddingCrypto.js')

  const vector = Array.from({ length: 512 }, (_, i) => (i % 7) / 7 - 0.5)
  const sealed = encryptEmbedding(vector)
  const opened = decryptEmbedding(sealed)

  assert.equal(opened.length, 512)
  for (let i = 0; i < vector.length; i++) {
    assert.ok(Math.abs(opened[i] - vector[i]) < 1e-6, `component ${i} did not round-trip`)
  }

  const tampered = Buffer.from(sealed)
  tampered[tampered.length - 4] ^= 0xff
  assert.throws(() => decryptEmbedding(tampered))
})

test('destroying a subject key makes that subject’s data permanently unopenable', async () => {
  const { getSubjectKey, destroySubjectKey, isSubjectKeyDestroyed, KeyDestroyedError } = await import(
    '../../src/lib/keyring.js'
  )

  // An in-memory stand-in for the subject_keys table. The point under test is
  // keyring's behaviour once the salt is gone, not Prisma's.
  const rows = new Map()
  const client = {
    subjectKey: {
      findUnique: async ({ where }) => rows.get(where.subjectId) ?? null,
      create: async ({ data }) => {
        rows.set(data.subjectId, { ...data })
        return rows.get(data.subjectId)
      },
      update: async ({ where, data }) => {
        const row = { ...rows.get(where.subjectId), ...data }
        rows.set(where.subjectId, row)
        return row
      },
      upsert: async ({ where, create, update }) => {
        const existing = rows.get(where.subjectId)
        const row = existing ? { ...existing, ...update } : { ...create }
        rows.set(where.subjectId, row)
        return row
      },
    },
  }

  const subjectId = '77777777-7777-4777-8777-777777777777'
  const before = await getSubjectKey(subjectId, { client })
  const sealed = sealBlob(fakeJpeg(), before.key, before.keyId)
  assert.deepEqual(openBlob(sealed, before.key, before.keyId), openBlob(sealed, before.key, before.keyId))

  await destroySubjectKey(subjectId, { client })
  assert.equal(await isSubjectKeyDestroyed(subjectId, { client }), true)

  // The salt is gone, so the DEK cannot be re-derived — this is the O(1) erasure
  // that reaches into backups nobody can rewrite.
  await assert.rejects(
    () => getSubjectKey(subjectId, { client }),
    (err) => err instanceof KeyDestroyedError || /destroy/i.test(err.message),
  )
})

test.after(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true })
})
