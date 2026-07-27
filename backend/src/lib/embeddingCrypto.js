import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import { isSealed, openBlob, readHeader, sealBlob } from './blobCrypto.js'
import { getSubjectKey, kekAvailable, zeroKey } from './keyring.js'

// A face embedding is biometric data under GDPR Art. 9 and personal data under
// DPDP — it is stored, so it is stored encrypted. Two formats coexist:
//
//   legacy  nonce(12) || tag(16) || ciphertext          key = FACE_EMBEDDING_KEY
//   sealed  PRSM|ver|keyId(8)|nonce(12)|tag(16)|ct      key = per-subject DEK
//
// Legacy rows are detected by the absence of the PRSM magic and keep decrypting
// forever — there is no flag day, and no migration that could silently zero a
// subject's enrollments. New writes should use the subject-keyed form, because
// only that one can be crypto-shredded: destroying the subject DEK makes every
// L5 embedding for that principal unrecoverable in O(1), including inside
// backups that cannot be rewritten (01_PRIVACY_DATAFLOW §3.2).
const ALGORITHM = 'aes-256-gcm'
const NONCE_BYTES = 12
const TAG_BYTES = 16

// The legacy key is resolved lazily, so a deployment that has fully migrated to
// MEDIA_KEK can drop FACE_EMBEDDING_KEY. What is NOT lazy is the demand that at
// least one of the two exists: a server with neither is one that quietly writes
// plaintext vectors, or that "works" right up until the first enrollment.
if (!process.env.FACE_EMBEDDING_KEY && !kekAvailable()) {
  throw new Error(
    'Neither MEDIA_KEK nor FACE_EMBEDDING_KEY is set. Face embeddings cannot be stored encrypted. Generate one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
  )
}

let legacyKeyCache = null

function legacyKey() {
  if (legacyKeyCache) return legacyKeyCache

  const raw = process.env.FACE_EMBEDDING_KEY
  if (!raw) {
    throw new Error(
      'FACE_EMBEDDING_KEY is not set but a legacy-format embedding was encountered. Keep the key until scripts/migrate-media-encrypt.js has re-sealed every enrollment.',
    )
  }
  const buffer = Buffer.from(raw, 'base64')
  if (buffer.length !== 32) {
    throw new Error(
      `FACE_EMBEDDING_KEY must decode to exactly 32 bytes (got ${buffer.length}). It is a base64 AES-256 key.`,
    )
  }
  legacyKeyCache = buffer
  return legacyKeyCache
}

function packVector(vector) {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('encryptEmbedding expects a non-empty number[]')
  }
  const plaintext = Buffer.alloc(vector.length * 4)
  for (let i = 0; i < vector.length; i += 1) {
    plaintext.writeFloatLE(vector[i], i * 4)
  }
  return plaintext
}

function unpackVector(plaintext) {
  const vector = new Array(plaintext.length / 4)
  for (let i = 0; i < vector.length; i += 1) {
    vector[i] = plaintext.readFloatLE(i * 4)
  }
  return vector
}

/**
 * @param {number[]} vector
 * @param {{key?: Buffer, keyId?: string}} [options] per-subject DEK from lib/keyring.
 *        Omit to write the legacy global-key format.
 * @returns {Buffer}
 */
export function encryptEmbedding(vector, options) {
  const plaintext = packVector(vector)

  if (options?.key && options?.keyId) {
    return sealBlob(plaintext, options.key, options.keyId)
  }

  // A fresh nonce per record: reusing one under the same key breaks GCM outright.
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv(ALGORITHM, legacyKey(), nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])

  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext])
}

/**
 * @param {Buffer} buffer
 * @param {{key?: Buffer, keyId?: string}} [options] required when the buffer is
 *        in the sealed per-subject format.
 * @returns {number[]}
 */
export function decryptEmbedding(buffer, options) {
  if (!Buffer.isBuffer(buffer)) throw new Error('decryptEmbedding: malformed ciphertext')

  if (isSealed(buffer)) {
    if (!options?.key) {
      throw new Error(
        'decryptEmbedding: this row is sealed with a per-subject DEK — use decryptEmbeddingForSubject(buffer, subjectId) or pass {key, keyId}',
      )
    }
    return unpackVector(openBlob(buffer, options.key, options.keyId))
  }

  if (buffer.length <= NONCE_BYTES + TAG_BYTES) {
    throw new Error('decryptEmbedding: malformed ciphertext')
  }

  const nonce = buffer.subarray(0, NONCE_BYTES)
  const tag = buffer.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES)
  const ciphertext = buffer.subarray(NONCE_BYTES + TAG_BYTES)

  const decipher = createDecipheriv(ALGORITHM, legacyKey(), nonce)
  decipher.setAuthTag(tag)
  return unpackVector(Buffer.concat([decipher.update(ciphertext), decipher.final()]))
}

/**
 * Preferred write path. Returns the keyId alongside the ciphertext so the caller
 * stamps `SubjectFaceEnrollment.encKeyId` — without that column a key rotation
 * has no way to tell which rows it still has to touch.
 */
export async function encryptEmbeddingForSubject(vector, subjectId) {
  const { key, keyId } = await getSubjectKey(subjectId)
  try {
    return { buffer: encryptEmbedding(vector, { key, keyId }), keyId }
  } finally {
    zeroKey(key)
  }
}

/**
 * Throws KeyDestroyedError when the subject's DEK was shredded by a purge. That
 * is the correct outcome and must not be swallowed: the biometric is gone, and
 * a matcher that treats it as "no result" would be lying about why.
 */
export async function decryptEmbeddingForSubject(buffer, subjectId) {
  if (!isSealed(buffer)) return decryptEmbedding(buffer)

  const resolved = await getSubjectKey(subjectId, { create: false })
  if (!resolved) throw new Error(`No subject key on record for ${subjectId}`)

  try {
    return decryptEmbedding(buffer, { key: resolved.key, keyId: resolved.keyId })
  } finally {
    zeroKey(resolved.key)
  }
}

/** null for legacy rows. */
export function readEmbeddingKeyId(buffer) {
  return Buffer.isBuffer(buffer) && isSealed(buffer) ? readHeader(buffer).keyId : null
}
