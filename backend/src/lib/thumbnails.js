import sharp from 'sharp'
import { readFile, writeFile, fileExists, shredFile } from './storage.js'

// Grid thumbnails for the redacted photo galleries.
//
// The galleries were painting full-resolution derivatives into tiles a few
// hundred pixels wide — measured at 2816x1584 and 300-550 KB per frame for a
// tile that renders at about 250 CSS pixels. Twelve of those is roughly 4 MB
// over the wire to draw something that needs about 300 KB, and it is the first
// thing anyone notices on a slower link.
//
// ---------------------------------------------------------------------------
// Derived from the REDACTED copy, never the original
// ---------------------------------------------------------------------------
// This is the whole safety argument. A thumbnail built from `storagePath` would
// be an unmasked miniature of a frame the platform has decided must be masked —
// a new, smaller hole in exactly the guarantee the redaction pipeline exists to
// provide. Every path in this file reads `redactedPath` and there is no branch
// that reaches for the original.
//
// ---------------------------------------------------------------------------
// Why a derived path and not a database column
// ---------------------------------------------------------------------------
// A thumbnail is a cache, not a record: it can be deleted at any time and
// rebuilt from the derivative it came from. Giving it a column would mean a
// migration, a backfill for every existing photo, and a second place for
// "which file is current" to be wrong. A deterministic path next to the
// derivative means existence on disk IS the cache state, purge can shred it by
// name the way it already shreds the per-person cache at L7, and a stale one is
// removed rather than reconciled.
//
// ---------------------------------------------------------------------------
// Invalidation is not optional
// ---------------------------------------------------------------------------
// When a subject erases, `rebuildRedactedForRemaining` re-blurs the derivative.
// A thumbnail left behind from before that rebuild would keep showing the face
// that was just erased, at the exact moment the platform is claiming it is
// gone. Both redaction write sites call `invalidateThumbnail` for that reason.

/** Long edge of a grid thumbnail, in pixels. */
const THUMB_WIDTH = 480

/** Quality is chosen for a tile, not for inspection — the full frame is one click away. */
const THUMB_QUALITY = 70

/**
 * Where a photo's thumbnail lives. Deterministic, and alongside the derivative
 * it is built from so a session's media stays in one place.
 */
export function thumbPathFor(sessionId, photoId) {
  return `sessions/${sessionId}/redacted/${photoId}.thumb.jpg`
}

/**
 * Builds a thumbnail from redacted bytes.
 *
 * `withoutEnlargement` matters: a frame already smaller than the target would
 * otherwise be upscaled into a file LARGER than the source, which is the exact
 * opposite of the point.
 */
export async function buildThumbnail(redactedBuffer) {
  return sharp(redactedBuffer)
    .rotate()
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
    .toBuffer()
}

/**
 * Returns thumbnail bytes for a photo, building and caching them on first ask.
 *
 * Takes the already-loaded photo row rather than an id: every caller has one,
 * and the authorisation decision belongs to the caller, not here. A photo with
 * no redacted derivative is not a case this function guesses about — the caller
 * has already refused it.
 */
export async function readOrCreateThumbnail(photo) {
  const thumbPath = thumbPathFor(photo.sessionId, photo.id)

  if (await fileExists(thumbPath)) {
    return { buffer: await readFile(thumbPath), cached: true }
  }

  const redacted = await readFile(photo.redactedPath)
  const buffer = await buildThumbnail(redacted)

  // Sealed on the same terms as every other object in the store — a thumbnail
  // of a face is personal data and gets no exemption for being small.
  await writeFile(thumbPath, buffer)

  return { buffer, cached: false }
}

/**
 * Drops a photo's cached thumbnail.
 *
 * Shredded rather than unlinked, for the same reason the derivative it came
 * from is: it is a picture of a person, and on the erasure path "we removed the
 * directory entry" is not the claim being made.
 *
 * Never throws. Invalidation runs inside redaction and erasure, and failing to
 * remove a cache entry must not fail the operation that made it stale — the
 * next read rebuilds from whatever the derivative now says regardless.
 */
export async function invalidateThumbnail(sessionId, photoId) {
  const thumbPath = thumbPathFor(sessionId, photoId)
  try {
    if (await fileExists(thumbPath)) await shredFile(thumbPath)
  } catch {
    /* a stale cache entry is not worth failing a redaction or a purge over */
  }
}
