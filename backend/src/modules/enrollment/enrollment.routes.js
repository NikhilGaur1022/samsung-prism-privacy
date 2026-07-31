import { Router } from 'express'
import multer from 'multer'
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import { requireSubjectAuth } from '../../middleware/requireSubjectAuth.js'
import { ApiError } from '../../middleware/errorHandler.js'
import * as enrollmentService from './enrollment.service.js'
import { uuid, parsePose } from './enrollment.validation.js'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    cb(file.mimetype.startsWith('image/') ? null : new Error('Only image files are accepted'), true)
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
