import { createHash, createPrivateKey, createPublicKey, hkdfSync } from 'node:crypto'

// Ed25519 signing identity for deletion certificates.
//
// A certificate is the principal's proof that their data was destroyed, and it is
// worthless if it cannot still be verified years later by someone who does not
// trust us. So the key must be stable across restarts and deployments — an
// ephemeral per-process key would produce signatures nobody can ever check again.
//
// Two ways to supply it, in priority order:
//   1. DSAR_SIGNING_SEED — 32 bytes, base64 or hex. The real answer for
//      production; rotate by issuing under a new keyId, never by re-signing old
//      certificates.
//   2. Derived from MEDIA_KEK via HKDF with a distinct info string. Keeps dev and
//      test deterministic without inventing a second secret to manage, and the
//      domain separation means a DSAR signature can never be confused with, or
//      substituted for, a media DEK.
//
// scripts/preflight.js refuses to boot production when neither is a real value.

const SEED_INFO = 'dsar-certificate-signing-v1'

// PKCS#8 and SPKI wrappers for Ed25519 are fixed-length constants — Node will
// import raw DER but has no "from seed" constructor, so the 16-byte prefix is
// prepended by hand. RFC 8410 §7.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

let cached = null

function readSeed() {
  const raw = process.env.DSAR_SIGNING_SEED
  if (raw) {
    const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
    if (buf.length !== 32) {
      throw new Error('DSAR_SIGNING_SEED must decode to exactly 32 bytes')
    }
    return { seed: buf, source: 'DSAR_SIGNING_SEED' }
  }

  const kek = process.env.MEDIA_KEK
  if (!kek) {
    throw new Error(
      'No DSAR signing key: set DSAR_SIGNING_SEED (32 bytes) or MEDIA_KEK. ' +
        'Deletion certificates cannot be issued without one.',
    )
  }

  const kekBuf = /^[0-9a-fA-F]{64}$/.test(kek) ? Buffer.from(kek, 'hex') : Buffer.from(kek, 'base64')
  const derived = Buffer.from(hkdfSync('sha256', kekBuf, Buffer.alloc(0), Buffer.from(SEED_INFO), 32))
  return { seed: derived, source: 'derived:MEDIA_KEK' }
}

export function getSigningKey() {
  if (cached) return cached

  const { seed, source } = readSeed()
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  })
  const publicKey = createPublicKey(privateKey)
  const publicRaw = publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_ED25519_PREFIX.length)

  // keyId is derived from the public key, so it identifies the key without
  // revealing it and changes automatically on rotation.
  const keyId = createHash('sha256').update(publicRaw).digest('hex').slice(0, 16)

  cached = {
    privateKey,
    publicKey,
    keyId,
    source,
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  }
  seed.fill(0)
  return cached
}

export function resetSigningKeyCache() {
  cached = null
}
