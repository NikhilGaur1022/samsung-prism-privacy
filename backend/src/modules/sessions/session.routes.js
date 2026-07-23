import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import { resolvePath } from '../../lib/storage.js'
import * as sessionService from './session.service.js'

export const sessionRoutes = Router()

sessionRoutes.use(requireAdminAuth)
sessionRoutes.use(requireRole('collectionAgent', 'super_admin'))

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    cb(file.mimetype.startsWith('image/') ? null : new Error('Only image files are accepted'), true)
  },
})

const uuid = z.string().uuid()

const createSessionSchema = z.object({
  projectId: uuid,
  location: z.string().trim().max(200).optional(),
})

const listQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'PROCESSING', 'TAGGING', 'ARCHIVED', 'FAILED']).optional(),
})

const photoMetaSchema = z.object({
  cameraSource: z.enum(['IPHONE_LIVE', 'IPHONE_UPLOAD', 'DSLR', 'XR']).default('IPHONE_UPLOAD'),
  takenAt: z.coerce.date().optional(),
})

const tagSchema = z.object({
  tagStatus: z.enum(['TAGGED', 'UNKNOWN', 'SKIPPED', 'NOT_A_FACE']),
  subjectId: uuid.optional(),
})

const clusterIdsSchema = z.object({ clusterIds: z.array(uuid).min(1) })
const faceIdsSchema = z.object({ faceIds: z.array(uuid).min(1) })

sessionRoutes.post('/', async (req, res, next) => {
  try {
    const body = createSessionSchema.parse(req.body)
    res.status(201).json(await sessionService.createSession(body, req.admin))
  } catch (err) {
    next(err)
  }
})

sessionRoutes.get('/', async (req, res, next) => {
  try {
    const query = listQuerySchema.parse(req.query)
    res.json({ items: await sessionService.listSessions(req.admin, query) })
  } catch (err) {
    next(err)
  }
})

sessionRoutes.get('/:sessionId', async (req, res, next) => {
  try {
    res.json(await sessionService.getSession(uuid.parse(req.params.sessionId), req.admin))
  } catch (err) {
    next(err)
  }
})

sessionRoutes.post('/:sessionId/participants', async (req, res, next) => {
  try {
    const sessionId = uuid.parse(req.params.sessionId)
    const { subjectId } = z.object({ subjectId: uuid }).parse(req.body)
    res.status(201).json(await sessionService.addParticipant(sessionId, subjectId, req.admin))
  } catch (err) {
    next(err)
  }
})

sessionRoutes.delete('/:sessionId/participants/:subjectId', async (req, res, next) => {
  try {
    await sessionService.removeParticipant(
      uuid.parse(req.params.sessionId),
      uuid.parse(req.params.subjectId),
      req.admin,
    )
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

// One endpoint for both capture paths — a live iPhone frame and a batch of files
// picked off the agent's PC differ only by the cameraSource field.
sessionRoutes.post('/:sessionId/photos', upload.array('photos', 20), async (req, res, next) => {
  try {
    const sessionId = uuid.parse(req.params.sessionId)
    const meta = photoMetaSchema.parse(req.body)
    if (!req.files?.length) throw Object.assign(new Error('No files uploaded'), { statusCode: 400 })

    const results = []
    for (const file of req.files) {
      results.push(await sessionService.addPhoto(sessionId, file, meta, req.admin))
    }

    res.status(201).json({
      added: results.filter((r) => !r.duplicate).length,
      duplicates: results.filter((r) => r.duplicate).length,
      photos: results.map((r) => r.photo),
    })
  } catch (err) {
    next(err)
  }
})

sessionRoutes.delete('/:sessionId/photos/:photoId', async (req, res, next) => {
  try {
    await sessionService.deletePhoto(
      uuid.parse(req.params.sessionId),
      uuid.parse(req.params.photoId),
      req.admin,
    )
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

sessionRoutes.get('/:sessionId/photos/:photoId/file', async (req, res, next) => {
  try {
    const { path, mimeType } = await sessionService.readPhotoFile(
      uuid.parse(req.params.sessionId),
      uuid.parse(req.params.photoId),
      req.admin,
    )
    // Photos are content-addressed by sha256 — they never change, so cache hard.
    res.set('Cache-Control', 'private, max-age=86400, immutable')
    res.type(mimeType).sendFile(resolvePath(path), { root: process.cwd(), maxAge: 86400000 })
  } catch (err) {
    next(err)
  }
})

sessionRoutes.get('/:sessionId/photos/:photoId/redacted', async (req, res, next) => {
  try {
    const { path, mimeType } = await sessionService.readRedactedPhoto(
      uuid.parse(req.params.sessionId),
      uuid.parse(req.params.photoId),
      req.admin,
    )
    res.set('Cache-Control', 'private, max-age=86400, immutable')
    res.type(mimeType).sendFile(resolvePath(path), { root: process.cwd(), maxAge: 86400000 })
  } catch (err) {
    next(err)
  }
})

sessionRoutes.get('/:sessionId/faces/:faceId/crop', async (req, res, next) => {
  try {
    const { path, mimeType } = await sessionService.readFaceCrop(
      uuid.parse(req.params.sessionId),
      uuid.parse(req.params.faceId),
      req.admin,
    )
    // Crops are deterministic from the source photo — cache hard.
    res.set('Cache-Control', 'private, max-age=86400, immutable')
    res.type(mimeType).sendFile(resolvePath(path), { root: process.cwd(), maxAge: 86400000 })
  } catch (err) {
    next(err)
  }
})

sessionRoutes.post('/:sessionId/end', async (req, res, next) => {
  try {
    res.json(await sessionService.endSession(uuid.parse(req.params.sessionId), req.admin))
  } catch (err) {
    next(err)
  }
})

sessionRoutes.get('/:sessionId/clusters', async (req, res, next) => {
  try {
    res.json(await sessionService.getClusters(uuid.parse(req.params.sessionId), req.admin))
  } catch (err) {
    next(err)
  }
})

// Declared before /:sessionId/clusters/:clusterId so the literal segments are
// never parsed as a cluster id.
sessionRoutes.post('/:sessionId/clusters/merge', async (req, res, next) => {
  try {
    const body = clusterIdsSchema.parse(req.body)
    res.json(
      await sessionService.mergeClusters(uuid.parse(req.params.sessionId), body, req.admin),
    )
  } catch (err) {
    next(err)
  }
})

sessionRoutes.post('/:sessionId/clusters/accept-suggestions', async (req, res, next) => {
  try {
    const body = clusterIdsSchema.parse(req.body)
    res.json(
      await sessionService.acceptSuggestions(uuid.parse(req.params.sessionId), body, req.admin),
    )
  } catch (err) {
    next(err)
  }
})

sessionRoutes.post('/:sessionId/clusters/:clusterId/split', async (req, res, next) => {
  try {
    const body = faceIdsSchema.parse(req.body)
    res.json(
      await sessionService.splitFaces(
        uuid.parse(req.params.sessionId),
        uuid.parse(req.params.clusterId),
        body,
        req.admin,
      ),
    )
  } catch (err) {
    next(err)
  }
})

sessionRoutes.get('/:sessionId/people', async (req, res, next) => {
  try {
    res.json(await sessionService.getPeople(uuid.parse(req.params.sessionId), req.admin))
  } catch (err) {
    next(err)
  }
})

sessionRoutes.get(
  '/:sessionId/people/:subjectId/photos/:photoId/redacted',
  async (req, res, next) => {
    try {
      const { path, mimeType } = await sessionService.readPersonRedactedPhoto(
        uuid.parse(req.params.sessionId),
        uuid.parse(req.params.photoId),
        uuid.parse(req.params.subjectId),
        req.admin,
      )
      res.set('Cache-Control', 'private, max-age=86400, immutable')
      res.type(mimeType).sendFile(resolvePath(path), { root: process.cwd(), maxAge: 86400000 })
    } catch (err) {
      next(err)
    }
  },
)

sessionRoutes.get('/:sessionId/people/:subjectId/photos', async (req, res, next) => {
  try {
    res.json(
      await sessionService.getPersonPhotos(
        uuid.parse(req.params.sessionId),
        uuid.parse(req.params.subjectId),
        req.admin,
      ),
    )
  } catch (err) {
    next(err)
  }
})

sessionRoutes.patch('/:sessionId/clusters/:clusterId', async (req, res, next) => {
  try {
    const body = tagSchema.parse(req.body)
    res.json(
      await sessionService.tagCluster(
        uuid.parse(req.params.sessionId),
        uuid.parse(req.params.clusterId),
        body,
        req.admin,
      ),
    )
  } catch (err) {
    next(err)
  }
})

sessionRoutes.get('/:sessionId/photos/review', async (req, res, next) => {
  try {
    res.json(
      await sessionService.getPhotosForReview(uuid.parse(req.params.sessionId), req.admin),
    )
  } catch (err) {
    next(err)
  }
})

sessionRoutes.post('/:sessionId/finalize', async (req, res, next) => {
  try {
    res.json(await sessionService.finalizeSession(uuid.parse(req.params.sessionId), req.admin))
  } catch (err) {
    next(err)
  }
})
