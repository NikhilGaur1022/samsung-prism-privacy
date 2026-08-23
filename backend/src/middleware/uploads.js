import multer from 'multer'
import { ApiError } from './errorHandler.js'

// One place that decides how an upload is accepted and how a rejected one is
// reported.
//
// Before this, five routers each configured multer their own way and the
// failures came out as 500s:
//
//   wrong mimetype, session photos    500  "Only image files are accepted"
//   26 MB file over the 25 MB limit   500  "File too large"
//   21 files over the 20-file limit   500
//   same mistake on the enrolment route  500
//   import route                      500
//   voice route                       415  (the only correct one)
//
// MulterError carries a `.code` but no `.statusCode`, so errorHandler defaulted
// it to 500. Three fileFilters rejected with a bare Error (also 500) and three
// with ApiError(415). The text-document upload had no fileFilter and no file
// count limit at all.

// ---------------------------------------------------------------------------
// Magic bytes
// ---------------------------------------------------------------------------
// A `Content-Type` header is a claim by the client, not a fact. Non-image bytes
// labelled image/jpeg reached sharp and came back as `Input buffer contains
// unsupported image format` — libvips internals, rendered verbatim to the
// operator. Checking the first bytes is the only way to know what a file
// actually is, and it turns a 500 from deep inside an image library into a 415
// at the door.

const SIGNATURES = [
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/png',
    test: (b) =>
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    mime: 'image/webp',
    test: (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  {
    // HEIC/AVIF and MP4/MOV all use the ISO base media container; the brand at
    // offset 8 is what separates them.
    mime: 'iso-bmff',
    test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
    brand: (b) => b.subarray(8, 12).toString('latin1'),
  },
  { mime: 'audio/wav', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE' },
  { mime: 'audio/ogg', test: (b) => b.subarray(0, 4).toString('latin1') === 'OggS' },
  { mime: 'audio/flac', test: (b) => b.subarray(0, 4).toString('latin1') === 'fLaC' },
  { mime: 'audio/mpeg', test: (b) => (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) || b.subarray(0, 3).toString('latin1') === 'ID3' },
  { mime: 'video/x-matroska', test: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  { mime: 'application/pdf', test: (b) => b.subarray(0, 4).toString('latin1') === '%PDF' },
]

const ISO_IMAGE_BRANDS = new Set(['heic', 'heix', 'hevc', 'mif1', 'msf1', 'avif', 'avis'])
const ISO_VIDEO_BRANDS = new Set(['isom', 'iso2', 'mp41', 'mp42', 'qt  ', 'M4V ', 'avc1'])

/**
 * What a buffer actually is, from its first bytes.
 * @returns {'image'|'audio'|'video'|'pdf'|'unknown'}
 */
export function sniffKind(buffer) {
  if (!buffer || buffer.length < 12) return 'unknown'
  const head = buffer.subarray(0, 32)

  for (const sig of SIGNATURES) {
    if (!sig.test(head)) continue
    if (sig.mime === 'iso-bmff') {
      const brand = sig.brand(head)
      if (ISO_IMAGE_BRANDS.has(brand)) return 'image'
      if (ISO_VIDEO_BRANDS.has(brand)) return 'video'
      return 'video'
    }
    if (sig.mime.startsWith('image/')) return 'image'
    if (sig.mime.startsWith('audio/')) return 'audio'
    if (sig.mime.startsWith('video/')) return 'video'
    if (sig.mime === 'application/pdf') return 'pdf'
  }
  return 'unknown'
}

/**
 * Rejects a buffer whose real content does not match what was claimed.
 * Throws ApiError(415) — never a bare Error, which is what produced the 500s.
 */
export function assertKind(buffer, expected, filename = 'file') {
  const actual = sniffKind(buffer)
  if (actual !== expected) {
    throw new ApiError(
      415,
      `${filename} is not a valid ${expected} file`,
      // The claimed type is deliberately not echoed: it is attacker-controlled
      // and there is no reason to reflect it.
      { reason: actual === 'unknown' ? 'UNRECOGNISED_CONTENT' : `CONTENT_IS_${actual.toUpperCase()}` },
    )
  }
}

/** Express middleware form, for routes using memoryStorage. */
export function requireFileKind(expected, { field = 'file', optional = false } = {}) {
  return (req, _res, next) => {
    const files = req.files ?? (req.file ? [req.file] : [])
    if (files.length === 0) {
      return optional ? next() : next(new ApiError(400, `No ${field} was uploaded`))
    }
    try {
      for (const file of files) {
        if (file.buffer) assertKind(file.buffer, expected, file.originalname)
      }
      next()
    } catch (err) {
      next(err)
    }
  }
}

// ---------------------------------------------------------------------------
// Filters and limits
// ---------------------------------------------------------------------------

/**
 * A fileFilter that rejects with ApiError(415).
 *
 * The header check is the cheap first pass — it rejects the obvious case before
 * a byte is buffered. requireFileKind is the one that actually decides, because
 * the header is a claim and the bytes are not.
 */
export function mimeFilter(prefixes) {
  const list = Array.isArray(prefixes) ? prefixes : [prefixes]
  return (_req, file, cb) => {
    const ok = list.some((p) => (p.endsWith('/') ? file.mimetype?.startsWith(p) : file.mimetype === p))
    if (ok) return cb(null, true)
    cb(new ApiError(415, `Unsupported file type: ${list.join(', ')} expected`))
  }
}

/**
 * Maps multer's own failures onto the statuses they should always have had.
 * Mount it immediately after the multer middleware on every upload route.
 */
export function multerErrorMapper(err, _req, _res, next) {
  if (!(err instanceof multer.MulterError)) return next(err)

  switch (err.code) {
    case 'LIMIT_FILE_SIZE':
      return next(new ApiError(413, 'That file is larger than this endpoint accepts', {
        limitBytes: err.limitBytes ?? null,
      }))
    case 'LIMIT_FILE_COUNT':
      return next(new ApiError(413, 'Too many files in one request', {
        limitCount: err.limitCount ?? null,
      }))
    case 'LIMIT_PART_COUNT':
    case 'LIMIT_FIELD_COUNT':
    case 'LIMIT_FIELD_KEY':
    case 'LIMIT_FIELD_VALUE':
      return next(new ApiError(413, 'The request had too many or too large parts'))
    case 'LIMIT_UNEXPECTED_FILE':
      return next(new ApiError(400, `Unexpected file field "${err.field}"`, { field: err.field }))
    default:
      return next(new ApiError(400, 'Upload rejected'))
  }
}

/**
 * Wraps a multer middleware so its errors are mapped without every route having
 * to remember to mount the mapper.
 */
export function withUploadErrors(uploadMiddleware) {
  return (req, res, next) => {
    uploadMiddleware(req, res, (err) => {
      if (!err) return next()
      multerErrorMapper(err, req, res, next)
    })
  }
}

/**
 * Disk-backed storage for the high-volume paths.
 *
 * memoryStorage on a 20-file × 25 MB endpoint means up to 500 MB resident per
 * request, with nothing releasing it until the handler finishes — one POST was
 * measured at that. Spooling to disk trades a temp file for the ability to
 * survive concurrent uploads at the target rate.
 */
export function diskStorage(destination) {
  return multer.diskStorage({
    destination,
    filename: (_req, file, cb) => {
      // Never the client's filename: it is attacker-controlled and reaches the
      // filesystem. A random name plus the original extension is enough for the
      // handler, which reads the bytes and hashes them anyway.
      const ext = /\.[A-Za-z0-9]{1,8}$/.exec(file.originalname ?? '')?.[0] ?? ''
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`)
    },
  })
}

import os from 'node:os'
import path from 'node:path'
import fsSync from 'node:fs'

// Where disk-backed uploads spool. Under the OS temp dir by default rather than
// the media root: these are pre-validation bytes that have not been sealed and
// must never be mistaken for stored media by the orphan sweep.
let cachedTmpDir = null

export function uploadTmpDir() {
  if (cachedTmpDir) return cachedTmpDir
  cachedTmpDir = process.env.UPLOAD_TMP_DIR ?? path.join(os.tmpdir(), 'prism-uploads')
  fsSync.mkdirSync(cachedTmpDir, { recursive: true })
  return cachedTmpDir
}
