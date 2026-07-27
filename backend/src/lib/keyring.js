import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

import { prisma } from '../config/prisma.js'

// Envelope key management. One master KEK from the environment, everything else
// derived — see 01_PRIVACY_DATAFLOW §3.2.
//
//   MEDIA_KEK (32B, base64)
//     ├─ per-project DEK  HKDF-SHA256(KEK, salt=projectId,       info="media-v1")
//     ├─ per-subject DEK  HKDF-SHA256(KEK, salt=<random, stored>, info="biometric-v1")
//     └─ per-export  DEK  random 32B, wrapped under KEK, stored on the job row
//
// The per-subject salt is random and persisted in `subject_keys` rather than
// being the subjectId. That difference is the entire erasure story: a key derived
// deterministically from the KEK can always be re-derived, so it can never be
// destroyed — deleting the salt destroys the key for good, including inside
// backups nobody can rewrite. That is what makes DPDP §12(3) erasure achievable
// in O(1) for biometrics instead of "we think we got all the copies".

const KEY_BYTES = 32
const KEY_ID_BYTES = 8
const SALT_BYTES = 32
const WRAP_NONCE_BYTES = 12

export const INFO_PROJECT = 'media-v1'
export const INFO_SUBJECT = 'biometric-v1'
export const INFO_EXPORT = 'export-v1'
export const INFO_PATH = 'path-v1'

export class KeyDestroyedError extends Error {
  constructor(subjectId) {
    super(`Subject key for ${subjectId} was destroyed — data sealed with it is unrecoverable by design`)
    this.name = 'KeyDestroyedError'
    this.code = 'KEY_DESTROYED'
    this.subjectId = subjectId
  }
}

export class MissingKekError extends Error {
  constructor() {
    super(
      'MEDIA_KEK is not set. Media at rest cannot be sealed without it. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    )
    this.name = 'MissingKekError'
    this.code = 'MEDIA_KEK_MISSING'
  }
}

function parseKek(raw, label) {
  const buffer = Buffer.from(raw, 'base64')
  if (buffer.length !== KEY_BYTES) {
    throw new Error(`${label} must decode to exactly ${KEY_BYTES} bytes (got ${buffer.length}). It is a base64 AES-256 key.`)
  }
  return buffer
}

// Resolved lazily, not at import: a dev box without MEDIA_KEK must still be able
// to boot and serve everything that is not media, and must fail loudly and
// specifically the moment it tries to seal a blob.
let kekCache = null

function loadKeks() {
  if (kekCache) return kekCache

  const current = process.env.MEDIA_KEK
  if (!current) throw new MissingKekError()

  const version = Number.parseInt(process.env.MEDIA_KEK_VERSION ?? '1', 10)
  if (!Number.isInteger(version) || version < 1) {
    throw new Error('MEDIA_KEK_VERSION must be a positive integer')
  }

  // Rotation: the previous KEK stays readable so old blobs open while new writes
  // use the new one. Blobs carry keyId, so re-encryption can be lazy-on-read
  // instead of a flag-day rewrite of the whole store.
  const previous = process.env.MEDIA_KEK_PREVIOUS
  kekCache = {
    current: { version, key: parseKek(current, 'MEDIA_KEK') },
    previous: previous ? { version: version - 1, key: parseKek(previous, 'MEDIA_KEK_PREVIOUS') } : null,
  }
  return kekCache
}

export function kekAvailable() {
  return Boolean(process.env.MEDIA_KEK)
}

// Test seam only — the env is read once and cached, so a test that swaps keys
// has to be able to say so.
export function resetKeyringCache() {
  kekCache = null
}

export function currentKekVersion() {
  return loadKeks().current.version
}

function kekForVersion(version) {
  const keks = loadKeks()
  if (version === keks.current.version) return keks.current.key
  if (keks.previous && version === keks.previous.version) return keks.previous.key
  throw new Error(`No KEK available for version ${version}. Set MEDIA_KEK_PREVIOUS to complete the rotation.`)
}

function derive(kek, salt, info) {
  return Buffer.from(hkdfSync('sha256', kek, salt, Buffer.from(info, 'utf8'), KEY_BYTES))
}

// keyId is an 8-byte tag over (kekVersion, info, salt) under the KEK. It is not
// key material and is safe in a blob header and in a DB column: it identifies
// which key a ciphertext expects, and comparing it before an AES-GCM open turns
// "wrong key" from an opaque auth failure into a precise error.
function computeKeyId(kek, version, info, salt) {
  return createHmac('sha256', kek)
    .update(`v${version}|${info}|`)
    .update(salt)
    .digest()
    .subarray(0, KEY_ID_BYTES)
    .toString('hex')
}

export function keyIdMatches(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

// --- project scope -------------------------------------------------------
// Deterministic: no table, no round trip, and a project's blobs stay readable as
// long as the KEK does. Project media is deleted by unlinking blobs, not by
// shredding keys, because the same key protects other subjects' lawful data.
export function deriveProjectKey(projectId, { version } = {}) {
  if (!projectId) throw new Error('deriveProjectKey requires a projectId')
  const v = version ?? currentKekVersion()
  const kek = kekForVersion(v)
  const salt = Buffer.from(String(projectId), 'utf8')
  return {
    key: derive(kek, salt, INFO_PROJECT),
    keyId: computeKeyId(kek, v, INFO_PROJECT, salt),
    version: v,
    scope: 'project',
  }
}

// --- path scope ----------------------------------------------------------
// Fallback for callers that do not (yet) know the owning project — the storage
// layer derives a stable scope string from the object's path prefix. Same KEK,
// same HKDF, different salt namespace; it is a weaker *grouping*, never weaker
// crypto. Wave 1+ callers should pass an explicit project scope.
export function derivePathKey(scopeId, { version } = {}) {
  if (!scopeId) throw new Error('derivePathKey requires a scopeId')
  const v = version ?? currentKekVersion()
  const kek = kekForVersion(v)
  const salt = Buffer.from(String(scopeId), 'utf8')
  return {
    key: derive(kek, salt, INFO_PATH),
    keyId: computeKeyId(kek, v, INFO_PATH, salt),
    version: v,
    scope: 'path',
  }
}

// --- subject scope -------------------------------------------------------
export async function getSubjectKey(subjectId, { create = true, client = prisma } = {}) {
  if (!subjectId) throw new Error('getSubjectKey requires a subjectId')

  let row = await client.subjectKey.findUnique({ where: { subjectId } })

  if (row && (row.destroyedAt || !row.salt)) throw new KeyDestroyedError(subjectId)

  if (!row) {
    if (!create) return null
    const version = currentKekVersion()
    const kek = kekForVersion(version)
    const salt = randomBytes(SALT_BYTES)
    const keyId = computeKeyId(kek, version, INFO_SUBJECT, salt)

    // Two concurrent enrollments for one subject must not mint two salts — the
    // loser of the race adopts the winner's row, it does not overwrite it, or
    // the first enrollment's ciphertext becomes garbage.
    row = await client.subjectKey
      .create({ data: { subjectId, keyId, salt, kekVersion: version } })
      .catch(async (error) => {
        if (error?.code !== 'P2002') throw error
        return client.subjectKey.findUnique({ where: { subjectId } })
      })

    if (!row) throw new Error(`Failed to establish a subject key for ${subjectId}`)
    if (row.destroyedAt || !row.salt) throw new KeyDestroyedError(subjectId)
  }

  const kek = kekForVersion(row.kekVersion)
  const salt = Buffer.from(row.salt)
  return {
    key: derive(kek, salt, INFO_SUBJECT),
    keyId: row.keyId,
    version: row.kekVersion,
    scope: 'subject',
  }
}

// Crypto-shredding. Deleting the salt is irreversible on purpose — it is the
// last step of a purge, after the blobs and rows are gone, so a resumed job can
// still read what it has not finished deleting. The row survives with salt NULL
// as the tombstone the deletion certificate cites.
export async function destroySubjectKey(subjectId, { client = prisma } = {}) {
  if (!subjectId) throw new Error('destroySubjectKey requires a subjectId')

  const existing = await client.subjectKey.findUnique({ where: { subjectId } })
  if (!existing) return { destroyed: false, alreadyDestroyed: false, keyId: null }
  if (existing.destroyedAt || !existing.salt) {
    // Idempotent: a resumed purge job re-runs this step and must not fail.
    return { destroyed: false, alreadyDestroyed: true, keyId: existing.keyId, destroyedAt: existing.destroyedAt }
  }

  const updated = await client.subjectKey.update({
    where: { subjectId },
    data: { salt: null, destroyedAt: new Date() },
  })
  return { destroyed: true, alreadyDestroyed: false, keyId: updated.keyId, destroyedAt: updated.destroyedAt }
}

export async function isSubjectKeyDestroyed(subjectId, { client = prisma } = {}) {
  const row = await client.subjectKey.findUnique({ where: { subjectId } })
  return Boolean(row && (row.destroyedAt || !row.salt))
}

// --- export scope --------------------------------------------------------
// A random DEK wrapped under the KEK, handed back for storage on the job row.
// Exports are the one artifact that leaves the system, so their key has to die
// with the job — dropping the wrapped bytes shreds the bundle, TTL or no TTL.
export function createExportKey() {
  const version = currentKekVersion()
  const kek = kekForVersion(version)
  const key = randomBytes(KEY_BYTES)
  const nonce = randomBytes(WRAP_NONCE_BYTES)

  const cipher = createCipheriv('aes-256-gcm', kek, nonce)
  cipher.setAAD(Buffer.from(INFO_EXPORT, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(key), cipher.final()])

  const wrapped = Buffer.concat([Buffer.from([version]), nonce, cipher.getAuthTag(), ciphertext])
  return {
    key,
    keyId: computeKeyId(kek, version, INFO_EXPORT, wrapped.subarray(1, 1 + WRAP_NONCE_BYTES)),
    version,
    wrapped,
    scope: 'export',
  }
}

export function openExportKey(wrapped) {
  const buffer = Buffer.isBuffer(wrapped) ? wrapped : Buffer.from(wrapped)
  if (buffer.length !== 1 + WRAP_NONCE_BYTES + 16 + KEY_BYTES) {
    throw new Error('openExportKey: malformed wrapped key')
  }
  const version = buffer[0]
  const kek = kekForVersion(version)
  const nonce = buffer.subarray(1, 1 + WRAP_NONCE_BYTES)
  const tag = buffer.subarray(1 + WRAP_NONCE_BYTES, 1 + WRAP_NONCE_BYTES + 16)
  const ciphertext = buffer.subarray(1 + WRAP_NONCE_BYTES + 16)

  const decipher = createDecipheriv('aes-256-gcm', kek, nonce)
  decipher.setAAD(Buffer.from(INFO_EXPORT, 'utf8'))
  decipher.setAuthTag(tag)
  const key = Buffer.concat([decipher.update(ciphertext), decipher.final()])

  return { key, keyId: computeKeyId(kek, version, INFO_EXPORT, nonce), version, scope: 'export' }
}

// --- generic resolution --------------------------------------------------
export async function resolveKey({ scope, scopeId, wrapped, version, client = prisma } = {}) {
  switch (scope) {
    case 'project':
      return deriveProjectKey(scopeId, { version })
    case 'path':
      return derivePathKey(scopeId, { version })
    case 'subject':
      return getSubjectKey(scopeId, { client })
    case 'export':
      return wrapped ? openExportKey(wrapped) : createExportKey()
    default:
      throw new Error(`resolveKey: unknown scope "${scope}"`)
  }
}

// Best-effort hygiene: a DEK sitting in a long-lived Buffer is a DEK in a heap
// dump. Callers zero what they are done with.
export function zeroKey(key) {
  if (Buffer.isBuffer(key)) key.fill(0)
}
