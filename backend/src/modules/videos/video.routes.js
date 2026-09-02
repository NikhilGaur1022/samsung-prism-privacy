import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { readFile as readTmp, rm as rmTmp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import multer from 'multer'
import { z } from 'zod'
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import { logAccess } from '../../middleware/logAccess.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { requireVideoEnabled } from '../../lib/videoFeature.js'
import * as videoService from './video.service.js'
import { mediaReadLimiter, uploadLimiter } from '../../middleware/rateLimiter.js'
import { withUploadErrors } from '../../middleware/uploads.js'

export const videoRoutes = Router()

videoRoutes.use(requireAdminAuth)

// Scoped to this router's OWN subtrees, never bare `.use(requireVideoEnabled)`.
// This router shares the /api/v1/sessions mount with sessionRoutes, and an
// unpathed router-level middleware runs for every request under that prefix
// whether or not a route in here matches — so a bare gate 503s `GET
// /api/v1/sessions` (the agent's session list) the moment VIDEO_CAPTURE_ENABLED
// is unset, which is a route this change has no business touching. The two
// prefixes below cover every route in this file and nothing else.
videoRoutes.use('/:sessionId/videos', requireVideoEnabled)
videoRoutes.use('/:sessionId/video-tracks', requireVideoEnabled)

// Capture is the agent's job — the agent who owns the session, which
// video.service proves per call through loadSessionForMedia(). super_admin is
// admitted for break-glass, consistent with sessionRoutes and recordingRoutes.
const captureRoles = requireRole('collectionAgent', 'super_admin')
// Reads are wider: matrix §D gives dataOwner the redacted derivatives of their
// own project and dataAdmin the lineage. Both are re-scoped inside the service,
// so a wider role floor here is not a wider reach for any individual caller.
const readRoles = requireRole('collectionAgent', 'dataOwner', 'dataAdmin', 'super_admin')

const uuid = z.string().uuid()

// Disk-backed, never memoryStorage. Same reasoning as the audio route, only more
// so: a video buffered in the Node heap and copied again into a FormData blob
// for the worker is twice its size in resident memory per upload.
//
// 200 MB matches the audio cap and is roughly 10-15 minutes of 1080p H.264,
// which is more than a collection session produces. The real ceiling is that
// lib/storage.js seals whole buffers — a streaming write is the fix for larger
// files, and it touches every caller, so it is deliberately not in this change.
// Up to MAX_FILES per request, not one.
//
// An agent coming back from a shoot has a folder of clips, and one-at-a-time
// meant one HTTP request, one rate-limit token and one round of consent checks
// per file — the stills route has taken batches of twenty since it was written,
// and there was no reason beyond history for video not to.
//
// Five, not twenty: at the 200 MB per-file ceiling twenty files is a 4 GB
// request body. Five is a realistic session's worth of clips and a bounded
// amount of disk to spool.
const MAX_FILES = Number(process.env.VIDEO_UPLOAD_MAX_FILES ?? 5)

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(os.tmpdir(), 'prism-video-uploads'),
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname) || ''}`),
  }),
  limits: { fileSize: 200 * 1024 * 1024, files: MAX_FILES },
  fileFilter: (_req, file, cb) => {
    cb(file.mimetype.startsWith('video/') ? null : new ApiError(415, 'Only video files are accepted'), true)
  },
})

async function collect(file) {
  const buffer = await readTmp(file.path)
  return { ...file, buffer }
}

/**
 * Sends a video, honouring HTTP range requests.
 *
 * Without this a `<video>` element is close to unusable. The browser opens a
 * clip by asking for `bytes=0-` and expects a 206 telling it the total size; a
 * flat 200 with the whole body means the seek bar cannot be dragged, currentTime
 * cannot be set, and Chrome in particular will abandon a longer file part-way
 * and render it as a clip that simply stops early — which reads as a truncated
 * or broken encode rather than a server that never implemented ranges.
 *
 * The bytes are already decrypted and in memory by the time we get here, so this
 * slices a buffer rather than streaming from disk. That is a real ceiling on file
 * size, and it is the same ceiling `lib/storage.js` already imposes by sealing
 * whole buffers — worth lifting, but not in this function alone.
 */
function sendVideo(req, res, buffer, mimeType) {
  // Never cached: these are personal data and every read is an AccessEvent. A
  // cached copy would be served again without one being written.
  res.set('Cache-Control', 'private, no-store')
  res.set('Accept-Ranges', 'bytes')
  res.type(mimeType)

  const header = req.headers.range
  if (!header) {
    res.set('Content-Length', String(buffer.length))
    return res.send(buffer)
  }

  const unsatisfiable = () =>
    res.status(416).set('Content-Range', `bytes */${buffer.length}`).end()

  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!match) return unsatisfiable()

  const [, rawStart, rawEnd] = match
  let start
  let end
  if (rawStart === '') {
    // `bytes=-N` — the trailing N bytes. Used by players hunting for the moov
    // atom at the end of a file that was not written with +faststart.
    if (rawEnd === '') return unsatisfiable()
    const count = Number(rawEnd)
    if (!Number.isFinite(count) || count <= 0) return unsatisfiable()
    start = Math.max(0, buffer.length - count)
    end = buffer.length - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? buffer.length - 1 : Number(rawEnd)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return unsatisfiable()
    end = Math.min(end, buffer.length - 1)
  }

  if (start > end || start >= buffer.length || start < 0) return unsatisfiable()

  res.status(206)
  res.set('Content-Range', `bytes ${start}-${end}/${buffer.length}`)
  res.set('Content-Length', String(end - start + 1))
  return res.end(buffer.subarray(start, end + 1))
}

async function cleanup(files) {
  await Promise.all(files.filter(Boolean).map((f) => rmTmp(f.path, { force: true }).catch(() => {})))
}

// `.array`, not `.single`, on the SAME field name — a client sending exactly one
// `video` part keeps working unchanged, and one sending five is no longer a 400.
videoRoutes.post(
  '/:sessionId/videos',
  captureRoles,
  // The stills route has been rate-limited since uploads were bounded; video
  // was not, which left a 200 MB × 5 endpoint with no per-principal ceiling.
  uploadLimiter,
  withUploadErrors(upload.array('video', MAX_FILES)),
  async (req, res, next) => {
    try {
      const files = req.files ?? []
      if (files.length === 0) throw new ApiError(400, 'video file is required')
      const sessionId = uuid.parse(req.params.sessionId)

      // Per-file outcomes, exactly as the photo batch route reports them: a
      // batch that fails on file three must not discard files one and two, and
      // the caller has to be able to tell which is which in order to retry.
      const accepted = []
      const rejected = []

      for (const raw of files) {
        try {
          const file = await collect(raw)
          const { video, duplicate } = await videoService.uploadVideo(sessionId, file, req.admin)
          accepted.push({ filename: raw.originalname, video, duplicate: Boolean(duplicate) })
        } catch (err) {
          const isClientError = err.statusCode >= 400 && err.statusCode < 500
          rejected.push({
            filename: raw.originalname,
            reason: isClientError ? err.message : 'Could not be processed',
            code: isClientError ? (err.code ?? 'REJECTED') : 'INTERNAL_ERROR',
          })
          if (!isClientError) req.log?.error?.({ err, filename: raw.originalname }, 'video upload failed')
        }
      }

      // A single-file request keeps its original response shape — `{video,
      // duplicate}` — so nothing that already calls this route has to change.
      const single = files.length === 1 && accepted.length === 1
      if (single) {
        return res
          .status(accepted[0].duplicate ? 200 : 201)
          .json({ video: accepted[0].video, duplicate: accepted[0].duplicate })
      }

      res.status(rejected.length === 0 ? 201 : 207).json({
        added: accepted.filter((a) => !a.duplicate).length,
        duplicates: accepted.filter((a) => a.duplicate).length,
        failed: rejected.length,
        videos: accepted.map((a) => a.video),
        accepted: accepted.map(({ filename, duplicate, video }) => ({
          filename,
          duplicate,
          videoId: video.id,
        })),
        rejected,
      })
    } catch (err) {
      next(err)
    } finally {
      await cleanup(req.files ?? [])
    }
  },
)

// Metadata only, no bytes — same reason the photo index route carries no
// logAccess: an AccessEvent records a read of personal data, and a list of ids
// and timings is not that.
videoRoutes.get('/:sessionId/videos', readRoles, async (req, res, next) => {
  try {
    const sessionId = uuid.parse(req.params.sessionId)
    res.json({ videos: await videoService.listVideos(sessionId, req.admin) })
  } catch (err) {
    next(err)
  }
})

videoRoutes.get('/:sessionId/videos/:videoId', readRoles, async (req, res, next) => {
  try {
    const sessionId = uuid.parse(req.params.sessionId)
    const videoId = uuid.parse(req.params.videoId)
    res.json(await videoService.getVideo(sessionId, videoId, req.admin))
  } catch (err) {
    next(err)
  }
})

// Serves bytes, so it gets the same treatment as the redacted photo and
// recording routes — an AccessEvent is written before the blob is ever
// decrypted (invariant 6), and the response is never cached.
videoRoutes.get(
  '/:sessionId/videos/:videoId/redacted',
  readRoles,
  mediaReadLimiter,
  logAccess('REDACTED_VIDEO', (req) => req.params.videoId, { purpose: 'COLLECTION' }),
  async (req, res, next) => {
    try {
      const sessionId = uuid.parse(req.params.sessionId)
      const videoId = uuid.parse(req.params.videoId)
      const { buffer, mimeType } = await videoService.readRedactedVideo(sessionId, videoId, req.admin)
      return sendVideo(req, res, buffer, mimeType)
    } catch (err) {
      next(err)
    }
  },
)

// The detection overlay: boxes and track labels drawn over UNMASKED frames.
//
// captureRoles, not readRoles. Every other video read route is wider because it
// serves the blurred derivative, and a data owner is entitled to that. This one
// serves legible faces, so it is held to the same floor as capture itself — the
// agent who owns the session, plus super_admin for break-glass. Widening it to
// readRoles would hand a data owner the unredacted footage of their own project
// through a route whose name suggests otherwise.
videoRoutes.get(
  '/:sessionId/videos/:videoId/detected',
  captureRoles,
  mediaReadLimiter,
  // Its own object type, not REDACTED_VIDEO and not the original's. A DPO
  // auditing "who saw an unmasked face" needs these reads to be filterable as
  // exactly what they are: a distinct derivative in which nobody is blurred.
  logAccess('DETECTED_VIDEO', (req) => req.params.videoId, { purpose: 'COLLECTION' }),
  async (req, res, next) => {
    try {
      const sessionId = uuid.parse(req.params.sessionId)
      const videoId = uuid.parse(req.params.videoId)
      const { buffer, mimeType } = await videoService.readDetectedVideo(sessionId, videoId, req.admin)
      return sendVideo(req, res, buffer, mimeType)
    } catch (err) {
      next(err)
    }
  },
)

// The tagging card's thumbnail. A crop of a face is personal data, so it is
// logged like one — the still pipeline's face-crop route does the same.
videoRoutes.get(
  '/:sessionId/video-tracks/:trackId/crop',
  readRoles,
  mediaReadLimiter,
  logAccess('FACE_CROP', (req) => req.params.trackId, { purpose: 'COLLECTION' }),
  async (req, res, next) => {
    try {
      const sessionId = uuid.parse(req.params.sessionId)
      const trackId = uuid.parse(req.params.trackId)
      const { buffer, mimeType } = await videoService.readTrackCrop(sessionId, trackId, req.admin)
      res.set('Cache-Control', 'private, no-store')
      res.type(mimeType).send(buffer)
    } catch (err) {
      next(err)
    }
  },
)
