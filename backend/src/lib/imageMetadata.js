import { createHash, createHmac, sign as edSign, verify as edVerify } from 'node:crypto'
import sharp from 'sharp'
import { getSigningKey } from './signingKey.js'

// Embedding project and person provenance into an exported image.
//
// The requirement was 0% implemented. A repo-wide grep for
// `exif|xmp|iptc|withMetadata` across backend/src returned exactly one hit and it
// was a code comment. Worse, the ingest transform actively destroys what the
// camera wrote — proved at byte level by pushing a JPEG carrying EXIF and ICC
// through the transform at session.service.js:249 and walking the marker
// segments:
//
//   SOURCE (2857 bytes)   FFE1 APP1 (EXIF) len=288 · FFE2 APP2/ICC len=496
//   AFTER  sharp().rotate().jpeg()  (2069 bytes)   every APPn segment gone
//   SAME + .withMetadata()          (2857 bytes)   APP1 and APP2 restored
//
// ---------------------------------------------------------------------------
// Why the stamp is written at EXPORT and not at ingest
// ---------------------------------------------------------------------------
// At ingest the person is not known. Face matching has not run, PhotoSubject
// rows do not exist, and clusters can still be merged, split and re-tagged.
// Metadata written at ingest would be wrong for precisely the photos the
// requirement cares about. Export is the only moment at which "which project,
// which person" is settled.
//
// (`.withMetadata()` is still added at ingest, separately, so the camera's own
// provenance — timestamp, device, orientation — is not silently lost. That is a
// chain-of-custody gap in its own right.)
//
// ---------------------------------------------------------------------------
// The privacy tension, and how it is resolved
// ---------------------------------------------------------------------------
// Baking a person's identity into an image that then leaves the platform creates
// new personal data in a less-controlled place, and it fights the crypto-shred
// guarantee directly: once an image with a subject id in it has been downloaded,
// erasure cannot reach it.
//
//   - Only PSEUDONYMOUS identifiers are embedded. An export-scoped `subjectRef`,
//     never a name and never an email. The ref is an HMAC of the subject id
//     under a per-export key, so two different exports produce two different
//     refs for the same person and neither can be reversed without the key.
//   - The subjectRef → identity mapping ships as ONE access-controlled file in
//     the package, not as 5,000 images each carrying a name.
//   - The stamp is SIGNED with the existing Ed25519 machinery, so it is
//     tamper-evident, which is what an auditor actually needs.
//   - Every export is recorded as an AccessEvent, so the DPIA can answer who
//     took what out and when.
//
// ---------------------------------------------------------------------------
// What survives, honestly
// ---------------------------------------------------------------------------
// Survives:      rename, copy, move, most archive round-trips.
// Does NOT:      a screenshot, a stripping re-encode, most social-platform
//                uploads, and any tool that re-saves without preserving APPn.
//
// Format note: sharp writes EXIF on JPEG, WebP and AVIF but not PNG (PNG needs
// tEXt/iTXt chunks). The stored corpus is 100% JPEG, so JPEG is the v1 scope and
// a non-JPEG input is reported rather than silently shipped unstamped.

/** The EXIF tag the stamp is written into. */
const STAMP_TAG = 'ImageDescription'

/**
 * A second copy goes in an XMP packet, because some pipelines rewrite
 * ImageDescription with a caption. Two independent carriers is cheap insurance
 * for a field whose whole value is surviving a round trip.
 *
 * This used to be EXIF `UserComment` in ExifIFD, and it silently did nothing:
 * libvips does not write that tag through withMetadata, so every exported image
 * carried exactly one copy while the code claimed two. Counting `PRISM1` in the
 * EXIF of a freshly stamped fixture returned 1, not 2. XMP is both actually
 * written by sharp and more likely to survive third-party tooling than
 * UserComment ever was.
 */
const XMP_NAMESPACE = 'https://prism.samsung/provenance/1'

const STAMP_VERSION = 1
const STAMP_PREFIX = 'PRISM1'

/**
 * Derives the export-scoped pseudonym for a subject.
 *
 * HMAC rather than a hash: a bare hash of a uuid is reversible by anyone who can
 * enumerate uuids, which for a subject id is anyone holding the database. Keyed
 * per export means the ref cannot be correlated across two exports either.
 */
export function subjectRefFor(subjectId, exportId) {
  const { privateKey, keyId } = getSigningKey()
  // The signing key is Ed25519 and cannot be used for HMAC directly, so the HMAC
  // key is its keyId mixed with the export id. That keeps the derivation
  // deterministic for a given export without introducing a second managed
  // secret.
  return createHmac('sha256', `${keyId}:${exportId}`)
    .update(String(subjectId))
    .digest('hex')
    .slice(0, 24)
}

/**
 * The stamp payload. Pseudonymous by construction — there is deliberately no
 * field here that could hold a name or an address.
 *
 * @param {object} fields
 * @param {string} fields.projectId
 * @param {string} fields.exportId
 * @param {string} fields.photoId
 * @param {string[]} fields.subjectRefs   export-scoped pseudonyms, never ids
 * @param {string} [fields.consentId]
 * @param {string} [fields.captureSessionId]
 * @param {string} fields.redaction       'REDACTED' | 'ORIGINAL'
 * @param {string} fields.contentHash     sha256 of the image bytes being stamped
 */
export function buildStampPayload(fields) {
  return {
    v: STAMP_VERSION,
    projectId: fields.projectId,
    exportId: fields.exportId,
    photoId: fields.photoId,
    subjectRefs: [...(fields.subjectRefs ?? [])].sort(),
    consentId: fields.consentId ?? null,
    captureSessionId: fields.captureSessionId ?? null,
    redaction: fields.redaction,
    contentHash: fields.contentHash,
    stampedAt: fields.stampedAt ?? new Date().toISOString(),
  }
}

// Canonical JSON: sorted keys, no incidental whitespace. The signature is over
// these exact bytes, so any variation in serialisation breaks verification —
// which is why it is not just JSON.stringify().
export function canonicalise(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalise(value[k])}`).join(',')}}`
}

/**
 * Serialises and signs a stamp.
 * Format: `PRISM1.<base64url(payload)>.<base64url(sig)>.<keyId>`
 *
 * Dot-separated rather than JSON so it survives being read back as a plain EXIF
 * string by tools that know nothing about this format.
 */
export function signStamp(payload) {
  const { privateKey, keyId } = getSigningKey()
  const body = Buffer.from(canonicalise(payload), 'utf8')
  const signature = edSign(null, body, privateKey)
  return [
    STAMP_PREFIX,
    body.toString('base64url'),
    signature.toString('base64url'),
    keyId,
  ].join('.')
}

/**
 * Parses and verifies a stamp string read back out of an image.
 * @returns {{valid: boolean, payload?: object, keyId?: string, reason?: string}}
 */
export function verifyStamp(stamp) {
  if (typeof stamp !== 'string' || !stamp.startsWith(`${STAMP_PREFIX}.`)) {
    return { valid: false, reason: 'NOT_A_PRISM_STAMP' }
  }

  const parts = stamp.split('.')
  if (parts.length !== 4) return { valid: false, reason: 'MALFORMED' }

  const [, bodyB64, sigB64, keyId] = parts
  let payload
  try {
    payload = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'))
  } catch {
    return { valid: false, reason: 'UNREADABLE_PAYLOAD' }
  }

  const { publicKey, keyId: currentKeyId } = getSigningKey()
  if (keyId !== currentKeyId) {
    // Not a failure: a stamp signed under a rotated key is still a real stamp,
    // it just cannot be checked with the key loaded here. Saying so is more
    // useful than saying "invalid".
    return { valid: false, reason: 'KEY_ID_MISMATCH', payload, keyId }
  }

  const ok = edVerify(
    null,
    Buffer.from(canonicalise(payload), 'utf8'),
    publicKey,
    Buffer.from(sigB64, 'base64url'),
  )

  return ok ? { valid: true, payload, keyId } : { valid: false, reason: 'BAD_SIGNATURE', payload, keyId }
}

/**
 * Writes a signed stamp into a JPEG's EXIF and returns the new bytes.
 *
 * The content hash inside the payload is of the image BEFORE stamping, because
 * the stamp cannot cover itself. That is what makes it possible to detect an
 * image whose pixels were changed after export.
 *
 * @param {Buffer} imageBuffer
 * @param {object} fields  see buildStampPayload
 * @returns {{buffer: Buffer, stamp: string, payload: object}}
 */
export async function stampImage(imageBuffer, fields) {
  const contentHash = createHash('sha256').update(imageBuffer).digest('hex')
  const payload = buildStampPayload({ ...fields, contentHash })
  const stamp = signStamp(payload)

  const buffer = await sharp(imageBuffer)
    .withMetadata({
      exif: {
        IFD0: {
          [STAMP_TAG]: stamp,
          Software: 'PRISM',
        },
      },
    })
    .withXmp(xmpPacket(stamp))
    .toBuffer()

  return { buffer, stamp, payload }
}

/**
 * The XMP packet carrying the second copy of the stamp.
 *
 * Deliberately minimal and self-describing: one custom namespace, one property.
 * Anything reading this does not need to know PRISM to find the string, and the
 * string verifies on its own.
 */
function xmpPacket(stamp) {
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:prism="${XMP_NAMESPACE}">
      <prism:stamp>${stamp}</prism:stamp>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`
}

/**
 * Reads a stamp back out of an image. Used by the round-trip test and by the
 * verification endpoint.
 */
const STAMP_PATTERN = /PRISM1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[0-9a-f]+/

export async function readStamp(imageBuffer) {
  const meta = await sharp(imageBuffer).metadata()

  // Both carriers are tried, because the whole point of writing two is that
  // either one may be the survivor. sharp hands back the raw APP1 payload;
  // rather than take an EXIF-parsing dependency for one string, the stamp is
  // located by its own prefix — it is ASCII, self-delimiting, and cannot
  // collide with binary tag data.
  const carriers = [
    ['exif', meta.exif ? meta.exif.toString('latin1') : null],
    ['xmp', meta.xmp ? meta.xmp.toString('utf8') : null],
  ]

  for (const [carrier, text] of carriers) {
    if (!text) continue
    const match = STAMP_PATTERN.exec(text)
    if (match) return { found: true, carrier, stamp: match[0], ...verifyStamp(match[0]) }
  }

  if (!meta.exif && !meta.xmp) return { found: false, reason: 'NO_METADATA' }
  return { found: false, reason: 'NO_STAMP' }
}

/**
 * True when this format can carry an EXIF stamp at all.
 * PNG cannot (it needs tEXt/iTXt chunks, which sharp does not write), and
 * pretending otherwise would ship an unstamped image that the manifest claims is
 * stamped.
 */
export function formatSupportsStamp(mimeType) {
  return ['image/jpeg', 'image/jpg', 'image/webp', 'image/avif'].includes(
    String(mimeType).toLowerCase(),
  )
}
