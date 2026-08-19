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
const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(os.tmpdir(), 'prism-video-uploads'),
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname) || ''}`),
  }),
  limits: { fileSize: 200 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    cb(file.mimetype.startsWith('video/') ? null : new ApiError(415, 'Only video files are accepted'), true)
  },
})

async function collect(file) {
  const buffer = await readTmp(file.path)
  return { ...file, buffer }
}

async function cleanup(files) {
  await Promise.all(files.filter(Boolean).map((f) => rmTmp(f.path, { force: true }).catch(() => {})))
}

videoRoutes.post(
  '/:sessionId/videos',
  captureRoles,
  upload.single('video'),
  async (req, res, next) => {
    try {
      if (!req.file) throw new ApiError(400, 'video file is required')
      const sessionId = uuid.parse(req.params.sessionId)
      const file = await collect(req.file)
      const { video, duplicate } = await videoService.uploadVideo(sessionId, file, req.admin)
      res.status(duplicate ? 200 : 201).json({ video, duplicate })
    } catch (err) {
      next(err)
    } finally {
      await cleanup([req.file])
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
  logAccess('REDACTED_VIDEO', (req) => req.params.videoId, { purpose: 'COLLECTION' }),
  async (req, res, next) => {
    try {
      const sessionId = uuid.parse(req.params.sessionId)
      const videoId = uuid.parse(req.params.videoId)
      const { buffer, mimeType } = await videoService.readRedactedVideo(sessionId, videoId, req.admin)
      res.set('Cache-Control', 'private, no-store')
      res.type(mimeType).send(buffer)
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
