import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { buildThumbnail, thumbPathFor } from '../../src/lib/thumbnails.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(HERE, '../fixtures/bulk/group-01.jpg')

// Grid thumbnails cut a 12-tile gallery from 3.2 MB to 113 KB. The risk that
// buys is entirely about WHICH image gets shrunk: a thumbnail built from the
// original rather than the redacted derivative would be an unmasked miniature
// of a frame the platform has decided must be masked.
//
// The read path for that is enforced in session.service.js — readRedactedPhotoThumb
// refuses a photo with no derivative and hands readOrCreateThumbnail the row it
// already loaded — so what is left to pin down here is the resizing itself and
// the cache-path contract that purge relies on.

test('a thumbnail is dramatically smaller than the image it came from', async () => {
  const source = readFileSync(FIXTURE)
  const thumb = await buildThumbnail(source)

  assert.ok(
    thumb.length < source.length / 2,
    `expected a large reduction, got ${source.length} -> ${thumb.length} bytes`,
  )

  const meta = await sharp(thumb).metadata()
  assert.equal(meta.format, 'jpeg')
  assert.ok(meta.width <= 480, `expected width <= 480, got ${meta.width}`)
})

test('an image already smaller than the target is not upscaled', async () => {
  // Without withoutEnlargement this produces a file LARGER than the source,
  // which is the exact opposite of the point of the feature.
  const small = await sharp({
    create: { width: 120, height: 90, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .jpeg()
    .toBuffer()

  const thumb = await buildThumbnail(small)
  const meta = await sharp(thumb).metadata()

  assert.equal(meta.width, 120, 'a 120px image must stay 120px, not be blown up to 480')
})

test('the thumbnail path is derived, stable, and sits beside the derivative', async () => {
  // purge.service.js shreds this cache by computing the same path rather than
  // reading a column, so the shape of it is a contract between the two files.
  const sessionId = '11111111-1111-1111-1111-111111111111'
  const photoId = '22222222-2222-2222-2222-222222222222'
  const p = thumbPathFor(sessionId, photoId)

  assert.equal(p, `sessions/${sessionId}/redacted/${photoId}.thumb.jpg`)
  assert.equal(thumbPathFor(sessionId, photoId), p, 'must be deterministic')
  assert.ok(p.includes('/redacted/'), 'lives with the redacted derivative it is built from')
})

test('the thumbnail source is the redacted derivative, never the original', async () => {
  // A grep-level guard, deliberately. The safety argument for this feature is
  // "the thumbnail is built from redactedPath", and the cheapest way for that to
  // stop being true is someone adding a fallback to storagePath when the
  // derivative is missing — which would look like a helpful bug fix.
  const raw = readFileSync(path.resolve(HERE, '../../src/lib/thumbnails.js'), 'utf8')

  // Comments are stripped first. The file explains at length WHY it must never
  // touch the original, and a naive substring check trips on that explanation —
  // which would leave the guard fixable only by deleting the reasoning.
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')

  assert.ok(code.includes('photo.redactedPath'), 'must read the redacted derivative')
  assert.ok(
    !code.includes('storagePath'),
    'thumbnails.js must never reference storagePath in code — that is the unmasked original',
  )
})
