import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// The single envelope primitive for media at rest (01_PRIVACY_DATAFLOW §3.2).
//
//   magic(4) | version(1) | keyId(8) | nonce(12) | tag(16) | ciphertext
//   'PRSM'     0x01         hex→bytes  random      GCM
//
// The header is authenticated as AAD, so flipping a bit in the keyId or the
// version breaks the open just as loudly as flipping a bit in the ciphertext —
// otherwise an attacker could relabel a blob and get a confusing failure instead
// of an integrity failure.
//
// magic exists so `readFile` can tell a sealed blob from a legacy plaintext JPEG
// without a database lookup, which is what makes the backfill in
// scripts/migrate-media-encrypt.js resumable and re-runnable.

export const MAGIC = Buffer.from('PRSM', 'ascii')
export const VERSION = 1

const MAGIC_BYTES = 4
const VERSION_BYTES = 1
const KEY_ID_BYTES = 8
const NONCE_BYTES = 12
const TAG_BYTES = 16
export const HEADER_BYTES = MAGIC_BYTES + VERSION_BYTES + KEY_ID_BYTES + NONCE_BYTES + TAG_BYTES

const OFF_VERSION = MAGIC_BYTES
const OFF_KEY_ID = OFF_VERSION + VERSION_BYTES
const OFF_NONCE = OFF_KEY_ID + KEY_ID_BYTES
const OFF_TAG = OFF_NONCE + NONCE_BYTES

export class BlobIntegrityError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BlobIntegrityError'
    this.code = 'BLOB_INTEGRITY'
  }
}

export class BlobKeyMismatchError extends Error {
  constructor(expected, actual) {
    super(`Blob was sealed with keyId ${expected} but key ${actual} was supplied`)
    this.name = 'BlobKeyMismatchError'
    this.code = 'BLOB_KEY_MISMATCH'
    this.expected = expected
    this.actual = actual
  }
}

function keyIdToBytes(keyId) {
  const buffer = Buffer.from(String(keyId), 'hex')
  if (buffer.length !== KEY_ID_BYTES) {
    throw new Error(`keyId must be ${KEY_ID_BYTES * 2} hex chars (got "${keyId}")`)
  }
  return buffer
}

export function isSealed(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= HEADER_BYTES &&
    buffer.subarray(0, MAGIC_BYTES).equals(MAGIC)
  )
}

// Reads the header without needing the key — used by the storage layer to decide
// whether a blob needs sealing, and by shredFile to destroy the header first.
export function readHeader(buffer) {
  if (!isSealed(buffer)) return null
  return {
    version: buffer[OFF_VERSION],
    keyId: buffer.subarray(OFF_KEY_ID, OFF_KEY_ID + KEY_ID_BYTES).toString('hex'),
    nonce: buffer.subarray(OFF_NONCE, OFF_NONCE + NONCE_BYTES),
    tag: buffer.subarray(OFF_TAG, OFF_TAG + TAG_BYTES),
    ciphertextLength: buffer.length - HEADER_BYTES,
  }
}

export function sealBlob(plaintext, dek, keyId, { version = VERSION } = {}) {
  if (!Buffer.isBuffer(plaintext)) throw new Error('sealBlob expects a Buffer')
  if (!Buffer.isBuffer(dek) || dek.length !== 32) throw new Error('sealBlob expects a 32-byte DEK')

  const keyIdBytes = keyIdToBytes(keyId)
  // Fresh nonce per blob. Nonce reuse under one key is total GCM failure, and a
  // per-project DEK seals a lot of blobs, so this is not a theoretical concern.
  const nonce = randomBytes(NONCE_BYTES)

  const header = Buffer.alloc(HEADER_BYTES)
  MAGIC.copy(header, 0)
  header[OFF_VERSION] = version
  keyIdBytes.copy(header, OFF_KEY_ID)
  nonce.copy(header, OFF_NONCE)

  const cipher = createCipheriv('aes-256-gcm', dek, nonce)
  // AAD covers everything before the tag slot: magic, version, keyId, nonce.
  cipher.setAAD(header.subarray(0, OFF_TAG))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  cipher.getAuthTag().copy(header, OFF_TAG)

  return Buffer.concat([header, ciphertext])
}

export function openBlob(buffer, dek, keyId) {
  if (!Buffer.isBuffer(buffer)) throw new Error('openBlob expects a Buffer')
  if (!isSealed(buffer)) throw new BlobIntegrityError('openBlob: not a sealed blob (bad magic)')
  if (!Buffer.isBuffer(dek) || dek.length !== 32) throw new Error('openBlob expects a 32-byte DEK')

  const header = readHeader(buffer)
  if (header.version !== VERSION) {
    throw new BlobIntegrityError(`openBlob: unsupported envelope version ${header.version}`)
  }
  if (keyId && header.keyId !== String(keyId)) {
    // Fail before touching the cipher: "you handed me the wrong key" is a
    // different operational problem from "this file has been tampered with", and
    // a purge that confuses the two deletes the wrong thing.
    throw new BlobKeyMismatchError(header.keyId, String(keyId))
  }

  const decipher = createDecipheriv('aes-256-gcm', dek, header.nonce)
  decipher.setAAD(buffer.subarray(0, OFF_TAG))
  decipher.setAuthTag(header.tag)

  try {
    return Buffer.concat([decipher.update(buffer.subarray(HEADER_BYTES)), decipher.final()])
  } catch (error) {
    // GCM's final() is the integrity check. Anything that gets here — a flipped
    // byte, a truncated file, a swapped key — is a failure to authenticate, and
    // callers must treat it as such and never fall back to serving the input.
    throw new BlobIntegrityError(`openBlob: authentication failed (${error.message})`)
  }
}
