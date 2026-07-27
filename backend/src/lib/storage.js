import fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

import { HEADER_BYTES, MAGIC, isSealed, openBlob, sealBlob } from './blobCrypto.js'
import {
  derivePathKey,
  deriveProjectKey,
  getSubjectKey,
  kekAvailable,
  openExportKey,
  zeroKey,
} from './keyring.js'

const ROOT = process.env.STORAGE_ROOT ?? './storage/media'

// Local-disk implementation of the media store, swappable for MinIO/S3 later —
// every caller goes through these functions and never touches fs directly. That
// single choke point is why envelope encryption is one file's worth of change:
// L2/L4/L6/L7 of 01_PRIVACY_DATAFLOW §2 all pass through here.
//
// Encryption is keyed off MEDIA_KEK being present. No key, no sealing — and in
// production that combination is refused at boot rather than quietly writing
// plaintext faces to disk. There is deliberately no per-call `encrypt: false`
// escape hatch: a caller must not be able to opt one object out.
const ENCRYPTION_ENABLED = (() => {
  const explicit = process.env.MEDIA_ENCRYPTION
  const enabled = explicit ? explicit === 'on' : kekAvailable()
  if (!enabled && process.env.NODE_ENV === 'production') {
    throw new Error(
      'Media encryption at rest is disabled but NODE_ENV=production. Set MEDIA_KEK (32 bytes, base64) before booting.',
    )
  }
  return enabled
})()

export function isEncryptionEnabled() {
  return ENCRYPTION_ENABLED
}

export function resolvePath(relativePath) {
  return path.join(ROOT, relativePath)
}

// Which DEK protects an object, inferred from where it lives. Callers that know
// better pass an explicit scope; this is the fallback, so no write can end up
// unencrypted merely because its caller has not been updated yet.
//
//   sessions/<sid>/...  -> path scope keyed on the session prefix (L2/L3/L6/L7)
//   subjects/<uid>/...  -> per-subject DEK, so crypto-shredding reaches L4
//   vault/<projectId>/  -> per-project DEK (L8)
//   exports/, dsar/     -> per-export DEK; refuses to guess, because the whole
//                          point of that key is that it is destroyable per job
export function scopeForPath(relativePath) {
  const parts = String(relativePath).split(/[\\/]+/).filter(Boolean)
  const [head, second] = parts

  if (head === 'subjects' && second) return { scope: 'subject', scopeId: second }
  if (head === 'vault' && second) return { scope: 'project', scopeId: second }
  if (head === 'exports' || head === 'dsar') {
    throw new Error(
      `storage: "${relativePath}" is an export artifact — pass {scope:'export', wrapped} explicitly so the key dies with the job`,
    )
  }
  if (head === 'sessions' && second) return { scope: 'path', scopeId: `sessions/${second}` }
  return { scope: 'path', scopeId: head ?? 'root' }
}

async function keyFor(relativePath, options) {
  const { scope, scopeId, wrapped } = options?.scope ? options : scopeForPath(relativePath)

  switch (scope) {
    case 'project':
      return deriveProjectKey(scopeId)
    case 'subject':
      return getSubjectKey(scopeId)
    case 'export':
      return openExportKey(wrapped)
    case 'path':
    default:
      return derivePathKey(scopeId)
  }
}

/**
 * Seals and writes an object.
 *
 * @param {string} relativePath
 * @param {Buffer} buffer plaintext
 * @param {{scope?: 'project'|'subject'|'export'|'path', scopeId?: string, wrapped?: Buffer}} [options]
 * @returns {Promise<{fullPath: string, keyId: string|null, encrypted: boolean}>} keyId belongs in
 *          the row's `encKeyId` column so a later key rotation knows what it is looking at.
 */
export async function writeFile(relativePath, buffer, options) {
  const fullPath = path.join(ROOT, relativePath)
  await fs.mkdir(path.dirname(fullPath), { recursive: true })

  if (!ENCRYPTION_ENABLED) {
    await fs.writeFile(fullPath, buffer)
    return { fullPath, keyId: null, encrypted: false }
  }

  const { key, keyId } = await keyFor(relativePath, options)
  try {
    await fs.writeFile(fullPath, sealBlob(buffer, key, keyId))
  } finally {
    zeroKey(key)
  }
  return { fullPath, keyId, encrypted: true }
}

/**
 * Returns plaintext. A sealed blob is opened; a legacy plaintext blob is passed
 * through, so the store stays readable while scripts/migrate-media-encrypt.js
 * works through the backlog. After that sweep, MEDIA_REQUIRE_SEALED=on turns the
 * tolerance off and any remaining plaintext object becomes a hard error rather
 * than a quiet success — which is the only way "everything is encrypted" ever
 * becomes a checkable claim.
 */
export async function readFile(relativePath, options) {
  const buffer = await fs.readFile(path.join(ROOT, relativePath))

  if (!isSealed(buffer)) {
    if (process.env.MEDIA_REQUIRE_SEALED === 'on') {
      throw new Error(`storage: "${relativePath}" is not sealed and MEDIA_REQUIRE_SEALED=on`)
    }
    return buffer
  }

  const { key, keyId } = await keyFor(relativePath, options)
  try {
    return openBlob(buffer, key, keyId)
  } finally {
    zeroKey(key)
  }
}

/**
 * Destroys an object rather than merely unlinking it. The envelope header holds
 * the nonce and the GCM tag, so overwriting it leaves the remaining ciphertext
 * unopenable even if the unlinked inode is later recovered. Legacy plaintext
 * blobs get the whole file overwritten instead — destroying nothing but their
 * first 41 bytes would be theatre.
 *
 * Honest limitation: on SSDs and copy-on-write filesystems an overwrite does not
 * guarantee the old blocks are gone. The durable guarantee for a DSAR erasure is
 * key destruction (`keyring.destroySubjectKey`); this is defence in depth.
 */
export async function shredFile(relativePath) {
  const fullPath = path.join(ROOT, relativePath)

  let handle
  try {
    handle = await fs.open(fullPath, 'r+')
    const { size } = await handle.stat()
    if (size > 0) {
      const head = Buffer.alloc(Math.min(size, HEADER_BYTES))
      await handle.read(head, 0, head.length, 0)
      const sealed = head.subarray(0, MAGIC.length).equals(MAGIC)
      const overwriteLength = sealed ? Math.min(size, HEADER_BYTES) : size
      await handle.write(randomBytes(overwriteLength), 0, overwriteLength, 0)
      await handle.sync()
    }
  } catch (error) {
    // ENOENT means the object is already gone — a resumed purge must not fail on
    // work it already completed.
    if (error.code !== 'ENOENT') throw error
  } finally {
    await handle?.close()
  }

  await fs.rm(fullPath, { force: true })
}

// Retained name for non-erasure callers (operational cleanup, failed uploads).
// Erasure paths should call shredFile explicitly so the intent is visible in the
// diff; the two are the same operation today and must not silently diverge.
export async function deleteFile(relativePath) {
  await shredFile(relativePath)
}

export async function fileExists(relativePath) {
  try {
    await fs.access(path.join(ROOT, relativePath))
    return true
  } catch {
    return false
  }
}
