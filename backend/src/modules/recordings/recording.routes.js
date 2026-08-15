import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import { logAccess } from '../../middleware/logAccess.js'
import * as recordingService from './recording.service.js'

export const recordingRoutes = Router()

// Same guard pair session.routes.js uses: the agent who ran the session is
// the one uploading its audio. super_admin included so you can drive these
// endpoints end-to-end with the bootstrap admin while testing, without
// needing a collectionAgent account provisioned yet.
recordingRoutes.use(requireAdminAuth)
recordingRoutes.use(requireRole('collectionAgent', 'super_admin'))

const uuid = z.string().uuid()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // audio files run larger than photos
  fileFilter: (_req, file, cb) => {
    cb(file.mimetype.startsWith('audio/') ? null : new Error('Only audio files are accepted'), true)
  },
})

// Accepts up to 10 reference voice clips alongside the main recording. This
// is a testing convenience, not the long-term shape: there is no voice
// enrollment flow yet (Subject only has face enrollments — see
// SubjectFaceEnrollment in schema.prisma), so for now the snippets and their
// matching subject ids are supplied per-request by whoever is testing this
// endpoint. Once voice enrollment exists, this becomes "look up the
// project's registered subjects" instead of an upload field — that's a
// follow-up change, not part of this first pass.
recordingRoutes.post(
  '/:sessionId/recordings',
  upload.single('main_audio'),
  async (req, res, next) => {
    try {
      if (!req.file) throw Object.assign(new Error('main_audio file is required'), { statusCode: 400 })
      const sessionId = uuid.parse(req.params.sessionId)
      res.status(201).json(await recordingService.uploadRecording(sessionId, req.file, req.admin))
    } catch (err) {
      next(err)
    }
  },
)

const snippetMuidsField = z.string().transform((s, ctx) => {
  try {
    const parsed = JSON.parse(s)
    if (!Array.isArray(parsed)) throw new Error()
    return parsed.map((m) => uuid.parse(m))
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'snippet_muids must be a JSON array of uuids' })
    return z.NEVER
  }
})

recordingRoutes.post(
  '/:sessionId/recordings/:recordingId/analyze',
  upload.array('voice_snippets', 10),
  async (req, res, next) => {
    try {
      const sessionId = uuid.parse(req.params.sessionId)
      const recordingId = uuid.parse(req.params.recordingId)
      const muids = snippetMuidsField.parse(req.body.snippet_muids ?? '[]')
      const files = req.files ?? []

      if (muids.length !== files.length) {
        throw Object.assign(
          new Error('snippet_muids length must match the number of voice_snippets files'),
          { statusCode: 400 },
        )
      }

      const voiceSnippets = files.map((f, i) => ({
        muid: muids[i],
        filename: f.originalname,
        buffer: f.buffer,
      }))

      const segments = await recordingService.analyzeRecording(
        sessionId,
        recordingId,
        voiceSnippets,
        req.admin,
      )
      res.json({ segments })
    } catch (err) {
      next(err)
    }
  },
)

recordingRoutes.post('/:sessionId/recordings/:recordingId/redact', async (req, res, next) => {
  try {
    const sessionId = uuid.parse(req.params.sessionId)
    const recordingId = uuid.parse(req.params.recordingId)
    res.json(await recordingService.redactRecording(sessionId, recordingId, req.admin))
  } catch (err) {
    next(err)
  }
})

// List, for the session detail page's "Audio" section. Same no-logAccess
// reasoning as the single-recording read below — metadata only, no bytes.
recordingRoutes.get('/:sessionId/recordings', async (req, res, next) => {
  try {
    const sessionId = uuid.parse(req.params.sessionId)
    res.json({ recordings: await recordingService.listRecordings(sessionId) })
  } catch (err) {
    next(err)
  }
})

recordingRoutes.get('/:sessionId/recordings/:recordingId', async (req, res, next) => {
  try {
    const sessionId = uuid.parse(req.params.sessionId)
    const recordingId = uuid.parse(req.params.recordingId)
    res.json(await recordingService.getRecording(sessionId, recordingId))
  } catch (err) {
    next(err)
  }
})

// This one DOES serve audio bytes, so it gets the same logAccess treatment as
// GET .../photos/:photoId/redacted — an AccessEvent is written before the
// blob is ever decrypted (invariant 6), and the response is never cached.
recordingRoutes.get(
  '/:sessionId/recordings/:recordingId/redacted',
  logAccess('REDACTED_RECORDING', (req) => req.params.recordingId, { purpose: 'COLLECTION' }),
  async (req, res, next) => {
    try {
      const sessionId = uuid.parse(req.params.sessionId)
      const recordingId = uuid.parse(req.params.recordingId)
      const { buffer, mimeType } = await recordingService.readRedactedRecording(sessionId, recordingId)
      res.set('Cache-Control', 'private, no-store')
      res.type(mimeType).send(buffer)
    } catch (err) {
      next(err)
    }
  },
)