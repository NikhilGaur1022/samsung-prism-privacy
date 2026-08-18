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
import { requireAudioEnabled } from '../../lib/audioFeature.js'
import * as recordingService from './recording.service.js'

export const recordingRoutes = Router()

// Off by default.
//
// Audio shipped ahead of its erasure path: a recording was invisible to DSAR
// discovery, so an erasure completed and signed a certificate while the voice
// data survived. That is fixed (DataItemType.AUDIO, discovery L14/L15, purge
// SEGMENT/L14/L15), and so is the second gap that kept this flag off — speaker
// identity now comes from persisted voice enrollments with their own erasure
// path (L16/L17) rather than from clips uploaded per request.
//
// It stays off by default anyway, because enabling it is an operational
// decision, not a code one: the audio worker needs a real HF_TOKEN
// (pyannote/speaker-diarization-3.1 is a gated model) and enough hardware to
// diarise, and a half-provisioned deployment would DEFER every recording. Turn
// it on per environment once the worker answers /health.
//
// The gate itself now lives in lib/audioFeature.js, because the voice-enrollment
// routes are behind the same switch and must not be able to drift from it.

recordingRoutes.use(requireAdminAuth)
recordingRoutes.use(requireAudioEnabled)

// Capture is the agent's job — the agent who owns the session, which
// recording.service proves per call through loadSessionForMedia(). super_admin
// is admitted for break-glass operation, consistent with sessionRoutes.
const captureRoles = requireRole('collectionAgent', 'super_admin')
// Reads are wider: matrix §D gives dataOwner the redacted derivatives of their
// own project and dataAdmin the lineage. Both are re-scoped inside the service —
// dataOwner to owned projects, agent to own sessions — so widening the role
// floor here does not widen what any individual caller can reach.
const readRoles = requireRole('collectionAgent', 'dataOwner', 'dataAdmin', 'super_admin')

const uuid = z.string().uuid()

// Disk-backed, not memoryStorage. A 200 MB file buffered in the Node heap and
// then copied again into a FormData blob for the worker is ~400 MB of heap per
// upload; two concurrent uploads was enough to take the API down.
const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(os.tmpdir(), 'prism-audio-uploads'),
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname) || ''}`),
  }),
  // One file: the session recording. Was 11 to allow ten reference snippets
  // alongside it; those are gone, and leaving the allowance would let a caller
  // push ten extra 200 MB bodies through a route that reads exactly one.
  limits: { fileSize: 200 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    cb(file.mimetype.startsWith('audio/') ? null : new ApiError(415, 'Only audio files are accepted'), true)
  },
})

/**
 * Reads a multer disk file into a buffer and removes the temp file.
 *
 * The service layer still works in buffers because that is what the worker
 * contract and the sealing API take; what changed is that the bytes are not
 * resident for the whole request, and the temp file is removed even when the
 * handler throws.
 */
async function collect(file) {
  const buffer = await readTmp(file.path)
  return { ...file, buffer }
}

async function cleanup(files) {
  await Promise.all(
    files.filter(Boolean).map((f) => rmTmp(f.path, { force: true }).catch(() => {})),
  )
}

recordingRoutes.post(
  '/:sessionId/recordings',
  captureRoles,
  upload.single('main_audio'),
  async (req, res, next) => {
    try {
      if (!req.file) throw new ApiError(400, 'main_audio file is required')
      const sessionId = uuid.parse(req.params.sessionId)
      const file = await collect(req.file)
      const { recording, duplicate } = await recordingService.uploadRecording(sessionId, file, req.admin)
      res.status(duplicate ? 200 : 201).json({ recording, duplicate })
    } catch (err) {
      next(err)
    } finally {
      await cleanup([req.file])
    }
  },
)

// No file upload any more. Reference clips used to ride along with every analyze
// request as `voice_snippets` + `snippet_muids`, which made speaker identity
// depend on whoever remembered to attach the right WAVs and meant the same voice
// was re-embedded on every call. Identity now comes from persisted
// SubjectVoiceEnrollment rows, loaded into a per-recording Qdrant gallery inside
// the service. An agent with an unenrolled roster gets everyone muted and a
// `gallery` block in the response saying so — which is the honest answer, not a
// reason to let them hand-feed reference audio at analyze time.
recordingRoutes.post(
  '/:sessionId/recordings/:recordingId/analyze',
  captureRoles,
  async (req, res, next) => {
    try {
      const sessionId = uuid.parse(req.params.sessionId)
      const recordingId = uuid.parse(req.params.recordingId)
      const { segments, gallery } = await recordingService.analyzeRecording(
        sessionId,
        recordingId,
        req.admin,
      )
      res.json({ segments, gallery })
    } catch (err) {
      next(err)
    }
  },
)

recordingRoutes.post(
  '/:sessionId/recordings/:recordingId/redact',
  captureRoles,
  async (req, res, next) => {
    try {
      const sessionId = uuid.parse(req.params.sessionId)
      const recordingId = uuid.parse(req.params.recordingId)
      res.json(await recordingService.redactRecording(sessionId, recordingId, req.admin))
    } catch (err) {
      next(err)
    }
  },
)

// Metadata only, no bytes — same reason the photo index route carries no
// logAccess: an AccessEvent records a read of personal data, and a list of ids
// and timings is not that.
recordingRoutes.get('/:sessionId/recordings', readRoles, async (req, res, next) => {
  try {
    const sessionId = uuid.parse(req.params.sessionId)
    res.json({ recordings: await recordingService.listRecordings(sessionId, req.admin) })
  } catch (err) {
    next(err)
  }
})

recordingRoutes.get('/:sessionId/recordings/:recordingId', readRoles, async (req, res, next) => {
  try {
    const sessionId = uuid.parse(req.params.sessionId)
    const recordingId = uuid.parse(req.params.recordingId)
    res.json(await recordingService.getRecording(sessionId, recordingId, req.admin))
  } catch (err) {
    next(err)
  }
})

// This one DOES serve audio bytes, so it gets the same treatment as
// GET .../photos/:photoId/redacted — an AccessEvent is written before the blob
// is ever decrypted (invariant 6), and the response is never cached.
recordingRoutes.get(
  '/:sessionId/recordings/:recordingId/redacted',
  readRoles,
  logAccess('REDACTED_RECORDING', (req) => req.params.recordingId, { purpose: 'COLLECTION' }),
  async (req, res, next) => {
    try {
      const sessionId = uuid.parse(req.params.sessionId)
      const recordingId = uuid.parse(req.params.recordingId)
      const { buffer, mimeType } = await recordingService.readRedactedRecording(
        sessionId,
        recordingId,
        req.admin,
      )
      res.set('Cache-Control', 'private, no-store')
      res.type(mimeType).send(buffer)
    } catch (err) {
      next(err)
    }
  },
)
