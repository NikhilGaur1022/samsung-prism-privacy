import { Router } from 'express'
import multer from 'multer'
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import { requireSubjectAuth } from '../../middleware/requireSubjectAuth.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { requireAudioEnabled } from '../../lib/audioFeature.js'
import * as enrollmentService from './enrollment.service.js'
import * as voiceService from './voiceEnrollment.service.js'
import { uuid, parsePose } from './enrollment.validation.js'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    cb(file.mimetype.startsWith('image/') ? null : new Error('Only image files are accepted'), true)
  },
})

// Separate from `upload`: an enrollment clip is a few seconds of speech, not a
// session recording, so 25 MB is generous and the 200 MB ceiling the recording
// routes need has no business on a route the subject's own phone posts to.
// memoryStorage is fine at this size — the disk-backed store on the recording
// routes exists because 200 MB in the heap twice took the API down.
const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    cb(file.mimetype.startsWith('audio/') ? null : new ApiError(415, 'Only audio files are accepted'), true)
  },
})

// Serving helper. The bytes arrive here already decrypted by the service and are
// sent as a buffer — never as a path handed to res.sendFile, which would stream
// the sealed 'PRSM' envelope straight off disk and label it image/jpeg.
function sendImage(res, { buffer, mimeType }) {
  // Biometric data: private cache only, never a shared/proxy cache. Immutable
  // content, so a short private max-age is fine — the thumbnail deck re-requests
  // every one of these on each reload.
  res.set('Cache-Control', 'private, max-age=3600')
  res.type(mimeType).send(buffer)
}

// --- Agent-facing --------------------------------------------------------------
export const agentEnrollmentRoutes = Router()

// Guards are per-route, NOT router-level. This router shares the /api/v1/subjects
// mount with subjectRoutes, and a router-level .use() runs for every request that
// enters the router — including ones it has no route for. That would 401 subject
// registration (POST /api/v1/subjects) before it ever reached its own handler.
const agentOnly = [requireAdminAuth, requireRole('collectionAgent', 'super_admin')]

agentEnrollmentRoutes.post(
  '/:subjectId/enrollments',
  ...agentOnly,
  upload.single('selfie'),
  async (req, res, next) => {
    try {
      if (!req.file) throw new ApiError(400, 'No selfie uploaded')
      const result = await enrollmentService.createEnrollment({
        subjectId: uuid.parse(req.params.subjectId),
        file: req.file,
        source: 'AGENT',
        capturedBy: req.admin.id,
        pose: parsePose(req.body?.pose),
      })
      res.status(result.duplicate ? 200 : 201).json(result)
    } catch (err) {
      next(err)
    }
  },
)

agentEnrollmentRoutes.get('/:subjectId/enrollments', ...agentOnly, async (req, res, next) => {
  try {
    res.json(await enrollmentService.listEnrollments(uuid.parse(req.params.subjectId)))
  } catch (err) {
    next(err)
  }
})

agentEnrollmentRoutes.get('/:subjectId/enrollments/:id/image', ...agentOnly, async (req, res, next) => {
  try {
    const file = await enrollmentService.readEnrollmentImage(
      uuid.parse(req.params.subjectId),
      uuid.parse(req.params.id),
    )
    sendImage(res, file)
  } catch (err) {
    next(err)
  }
})

agentEnrollmentRoutes.delete('/:subjectId/enrollments/:id', ...agentOnly, async (req, res, next) => {
  try {
    await enrollmentService.deleteEnrollment(
      uuid.parse(req.params.subjectId),
      uuid.parse(req.params.id),
      req.admin.id,
    )
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

// --- Agent-facing: voice -------------------------------------------------------
// Same role floor and the same per-route guard style as the selfie routes above,
// plus the audio kill switch. The service re-checks subject status and biometric
// consent on every capture, so these guards decide who may operate the flow, not
// whether the flow is lawful for this person.
const agentVoiceOnly = [...agentOnly, requireAudioEnabled]

agentEnrollmentRoutes.post(
  '/:subjectId/voice-enrollments',
  ...agentVoiceOnly,
  uploadAudio.single('audio'),
  async (req, res, next) => {
    try {
      if (!req.file) throw new ApiError(400, 'No audio uploaded')
      const result = await voiceService.createVoiceEnrollment({
        subjectId: uuid.parse(req.params.subjectId),
        file: req.file,
        source: 'AGENT',
        capturedBy: req.admin.id,
      })
      res.status(result.duplicate ? 200 : 201).json(result)
    } catch (err) {
      next(err)
    }
  },
)

agentEnrollmentRoutes.get('/:subjectId/voice-enrollments', ...agentVoiceOnly, async (req, res, next) => {
  try {
    res.json(await voiceService.listVoiceEnrollments(uuid.parse(req.params.subjectId)))
  } catch (err) {
    next(err)
  }
})

agentEnrollmentRoutes.delete(
  '/:subjectId/voice-enrollments/:id',
  ...agentVoiceOnly,
  async (req, res, next) => {
    try {
      await voiceService.deleteVoiceEnrollment(
        uuid.parse(req.params.subjectId),
        uuid.parse(req.params.id),
        req.admin.id,
      )
      res.status(204).end()
    } catch (err) {
      next(err)
    }
  },
)

// Deliberately NOT mirrored from the selfie routes: there is no agent-facing
// playback endpoint for an enrollment clip. A selfie can be shown back so an
// agent can confirm they captured the right person's face; playing a voice clip
// tells the operator nothing they cannot get from the duration, and turns every
// enrolled subject's recorded voice into something any agent can listen to. The
// subject can play back their own (below), which is the access right; nobody
// else needs to.

// --- Subject-facing ------------------------------------------------------------
// subjectId is ALWAYS taken from the verified token, never from the path — reading
// it from the URL would let one subject enroll their face as another identity.
export const selfEnrollmentRoutes = Router()

selfEnrollmentRoutes.use(requireSubjectAuth)

selfEnrollmentRoutes.post('/enrollments', upload.single('selfie'), async (req, res, next) => {
  try {
    if (!req.file) throw new ApiError(400, 'No selfie uploaded')
    const result = await enrollmentService.createEnrollment({
      subjectId: req.subject.masterUserId,
      file: req.file,
      source: 'SELF',
      capturedBy: null,
      pose: parsePose(req.body?.pose),
    })
    res.status(result.duplicate ? 200 : 201).json(result)
  } catch (err) {
    next(err)
  }
})

selfEnrollmentRoutes.get('/enrollments', async (req, res, next) => {
  try {
    res.json(await enrollmentService.listEnrollments(req.subject.masterUserId))
  } catch (err) {
    next(err)
  }
})

selfEnrollmentRoutes.get('/enrollments/:id/image', async (req, res, next) => {
  try {
    const file = await enrollmentService.readEnrollmentImage(
      req.subject.masterUserId,
      uuid.parse(req.params.id),
    )
    sendImage(res, file)
  } catch (err) {
    next(err)
  }
})

selfEnrollmentRoutes.delete('/enrollments/:id', async (req, res, next) => {
  try {
    await enrollmentService.deleteEnrollment(
      req.subject.masterUserId,
      uuid.parse(req.params.id),
      req.subject.masterUserId,
    )
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

// --- Subject-facing: voice -----------------------------------------------------
// subjectId comes from the verified token here too. Taking it from a path
// parameter would let one subject enroll their voice as another identity, which
// on this side of the system means being kept unmuted in that person's sessions.
selfEnrollmentRoutes.post(
  '/voice-enrollments',
  requireAudioEnabled,
  uploadAudio.single('audio'),
  async (req, res, next) => {
    try {
      if (!req.file) throw new ApiError(400, 'No audio uploaded')
      const result = await voiceService.createVoiceEnrollment({
        subjectId: req.subject.masterUserId,
        file: req.file,
        source: 'SELF',
        capturedBy: null,
      })
      res.status(result.duplicate ? 200 : 201).json(result)
    } catch (err) {
      next(err)
    }
  },
)

selfEnrollmentRoutes.get('/voice-enrollments', requireAudioEnabled, async (req, res, next) => {
  try {
    res.json(await voiceService.listVoiceEnrollments(req.subject.masterUserId))
  } catch (err) {
    next(err)
  }
})

selfEnrollmentRoutes.get('/voice-enrollments/status', requireAudioEnabled, async (req, res, next) => {
  try {
    res.json(await voiceService.getVoiceEnrollmentStatus(req.subject.masterUserId))
  } catch (err) {
    next(err)
  }
})

// The subject's own clip, played back to the subject. This is the §11 access
// right in its most direct form, and it is the only playback route that exists.
selfEnrollmentRoutes.get('/voice-enrollments/:id/audio', requireAudioEnabled, async (req, res, next) => {
  try {
    const { buffer, mimeType } = await voiceService.readVoiceEnrollmentAudio(
      req.subject.masterUserId,
      uuid.parse(req.params.id),
    )
    // no-store, unlike the selfie route's private max-age. A cached copy of a
    // voice print sitting in a browser disk cache would outlive the erasure
    // that destroyed the server-side one, and nothing here can reach it.
    res.set('Cache-Control', 'private, no-store')
    res.type(mimeType).send(buffer)
  } catch (err) {
    next(err)
  }
})

selfEnrollmentRoutes.delete('/voice-enrollments/:id', requireAudioEnabled, async (req, res, next) => {
  try {
    await voiceService.deleteVoiceEnrollment(
      req.subject.masterUserId,
      uuid.parse(req.params.id),
      req.subject.masterUserId,
    )
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})
