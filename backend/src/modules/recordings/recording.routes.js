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
import { mediaReadLimiter, uploadLimiter } from '../../middleware/rateLimiter.js'
import { withUploadErrors } from '../../middleware/uploads.js'

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

const MAX_FILES = Number(process.env.AUDIO_UPLOAD_MAX_FILES ?? 10)

// Disk-backed, not memoryStorage. A 200 MB file buffered in the Node heap and
// then copied again into a FormData blob for the worker is ~400 MB of heap per
// upload; two concurrent uploads was enough to take the API down.
const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(os.tmpdir(), 'prism-audio-uploads'),
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname) || ''}`),
  }),
  // Up to MAX_FILES session recordings per request.
  //
  // This was 1. Before that it was 11, to carry ten reference snippets that no
  // longer exist — so the cap came down to exactly one and stayed there, which
  // meant an agent with a morning's worth of interviews made one request per
  // file. The stills route has taken batches since it was written. These are
  // genuine session recordings, each of which becomes its own Recording row and
  // its own analyse/redact cycle, not snippets riding along with one.
  limits: { fileSize: 200 * 1024 * 1024, files: MAX_FILES },
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

// `.array` on the SAME field name, so a client sending one `main_audio` part is
// unaffected and one sending ten now works.
recordingRoutes.post(
  '/:sessionId/recordings',
  captureRoles,
  uploadLimiter,
  withUploadErrors(upload.array('main_audio', MAX_FILES)),
  async (req, res, next) => {
    try {
      const files = req.files ?? []
      if (files.length === 0) throw new ApiError(400, 'main_audio file is required')
      const sessionId = uuid.parse(req.params.sessionId)

      // Per-file outcomes, as the photo batch route reports them. One bad file
      // in a batch of eight must not discard the seven that were fine.
      const accepted = []
      const rejected = []

      for (const raw of files) {
        try {
          const file = await collect(raw)
          const { recording, duplicate } = await recordingService.uploadRecording(
            sessionId,
            file,
            req.admin,
          )
          accepted.push({ filename: raw.originalname, recording, duplicate: Boolean(duplicate) })
        } catch (err) {
          const isClientError = err.statusCode >= 400 && err.statusCode < 500
          rejected.push({
            filename: raw.originalname,
            reason: isClientError ? err.message : 'Could not be processed',
            code: isClientError ? (err.code ?? 'REJECTED') : 'INTERNAL_ERROR',
          })
          if (!isClientError) {
            req.log?.error?.({ err, filename: raw.originalname }, 'recording upload failed')
          }
        }
      }

      // A single-file request keeps its original `{recording, duplicate}` shape.
      if (files.length === 1 && accepted.length === 1) {
        return res
          .status(accepted[0].duplicate ? 200 : 201)
          .json({ recording: accepted[0].recording, duplicate: accepted[0].duplicate })
      }

      res.status(rejected.length === 0 ? 201 : 207).json({
        added: accepted.filter((a) => !a.duplicate).length,
        duplicates: accepted.filter((a) => a.duplicate).length,
        failed: rejected.length,
        recordings: accepted.map((a) => a.recording),
        accepted: accepted.map(({ filename, duplicate, recording }) => ({
          filename,
          duplicate,
          recordingId: recording.id,
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

const segmentItemSchema = z.object({
  id: z.string().uuid().optional(),
  speakerId: z.string().default('MANUAL'),
  subjectId: z.string().uuid().nullable().optional(),
  consentId: z.string().uuid().nullable().optional(),
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  action: z.enum(['KEEP', 'REDACT_VOICE', 'REDACT_PII']),
  reason: z.string().nullable().optional(),
  piiType: z.string().nullable().optional(),
  matchScore: z.number().nullable().optional(),
})

const updateSegmentsSchema = z.object({
  segments: z.array(segmentItemSchema),
})

// The agent's manual corrections from the timeline. captureRoles, not readRoles:
// this rewrites what gets muted, and dataOwner/dataAdmin are admitted to the
// derivatives of a session, never to deciding what goes into them.
recordingRoutes.put(
  '/:sessionId/recordings/:recordingId/segments',
  captureRoles,
  async (req, res, next) => {
    try {
      const sessionId = uuid.parse(req.params.sessionId)
      const recordingId = uuid.parse(req.params.recordingId)
      const body = updateSegmentsSchema.parse(req.body)
      const segments = await recordingService.saveSegments(
        sessionId,
        recordingId,
        body.segments,
        req.admin,
      )
      res.json({ segments })
    } catch (err) {
      next(err)
    }
  },
)

// Byte-range aware, because the timeline seeks. Without a 206 the browser
// re-fetches the whole file for every scrub and <audio>.currentTime on a long
// recording simply refuses to move.
function sendAudioWithRange(req, res, buffer, mimeType = 'audio/wav') {
  const totalSize = buffer.length
  res.set('Accept-Ranges', 'bytes')
  res.set('Cache-Control', 'private, no-store')

  const range = req.headers.range
  if (!range) {
    res.set('Content-Length', totalSize)
    res.type(mimeType).status(200).send(buffer)
    return
  }

  const parts = range.replace(/bytes=/, '').split('-')
  const start = parseInt(parts[0], 10)
  const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1

  if (Number.isNaN(start) || start >= totalSize || (parts[1] && end < start)) {
    res.set('Content-Range', `bytes */${totalSize}`)
    res.status(416).send('Requested Range Not Satisfiable')
    return
  }

  const chunkEnd = Math.min(end, totalSize - 1)
  const chunk = buffer.subarray(start, chunkEnd + 1)

  res.status(206)
  res.set({
    'Content-Range': `bytes ${start}-${chunkEnd}/${totalSize}`,
    'Content-Length': chunk.length,
    'Content-Type': mimeType,
  })
  res.send(chunk)
}

// Unredacted audio, for the agent working the timeline before archive. This is
// the rawest read in the audio path, so it is captureRoles — the same floor as
// upload and analyze — and it carries logAccess for the same reason the
// break-glass photo route does: an AccessEvent is written before the blob is
// ever decrypted (invariant 6).
recordingRoutes.get(
  '/:sessionId/recordings/:recordingId/raw',
  captureRoles,
  mediaReadLimiter,
  logAccess('RECORDING', (req) => req.params.recordingId, { purpose: 'COLLECTION' }),
  async (req, res, next) => {
    try {
      const sessionId = uuid.parse(req.params.sessionId)
      const recordingId = uuid.parse(req.params.recordingId)
      const { buffer, mimeType } = await recordingService.readRawRecording(
        sessionId,
        recordingId,
        req.admin,
      )
      sendAudioWithRange(req, res, buffer, mimeType)
    } catch (err) {
      next(err)
    }
  },
)

// This one DOES serve audio bytes, so it gets the same treatment as
// GET .../photos/:photoId/redacted — an AccessEvent is written before the blob
// is ever decrypted (invariant 6), and the response is never cached.
recordingRoutes.get(
  '/:sessionId/recordings/:recordingId/redacted',
  readRoles,
  mediaReadLimiter,
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
      sendAudioWithRange(req, res, buffer, mimeType)
    } catch (err) {
      next(err)
    }
  },
)
