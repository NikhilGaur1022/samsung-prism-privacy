import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// A face embedding is biometric data under GDPR Art. 9 — it is stored, so it is
// stored encrypted. Layout: nonce(12) || tag(16) || ciphertext(dim × 4 bytes).
const ALGORITHM = 'aes-256-gcm'
const NONCE_BYTES = 12
const TAG_BYTES = 16

// Read at import time, not per call. A missing or malformed key must stop the
// process at boot — the alternative is a server that quietly writes plaintext
// vectors, or worse, one that "works" until the first enrollment.
const key = (() => {
  const raw = process.env.FACE_EMBEDDING_KEY
  if (!raw) {
    throw new Error(
      'FACE_EMBEDDING_KEY is not set. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    )
  }
  const buffer = Buffer.from(raw, 'base64')
  if (buffer.length !== 32) {
    throw new Error(
      `FACE_EMBEDDING_KEY must decode to exactly 32 bytes (got ${buffer.length}). It is a base64 AES-256 key.`,
    )
  }
  return buffer
})()

export function encryptEmbedding(vector) {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('encryptEmbedding expects a non-empty number[]')
  }

  const plaintext = Buffer.alloc(vector.length * 4)
  for (let i = 0; i < vector.length; i += 1) {
    plaintext.writeFloatLE(vector[i], i * 4)
  }

  // A fresh nonce per record: reusing one under the same key breaks GCM outright.
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])

  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext])
}

export function decryptEmbedding(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length <= NONCE_BYTES + TAG_BYTES) {
    throw new Error('decryptEmbedding: malformed ciphertext')
  }

  const nonce = buffer.subarray(0, NONCE_BYTES)
  const tag = buffer.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES)
  const ciphertext = buffer.subarray(NONCE_BYTES + TAG_BYTES)

  const decipher = createDecipheriv(ALGORITHM, key, nonce)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])

  const vector = new Array(plaintext.length / 4)
  for (let i = 0; i < vector.length; i += 1) {
    vector[i] = plaintext.readFloatLE(i * 4)
  }
  return vector
}
