import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import { logAccess } from '../../middleware/logAccess.js'
import { requireBreakGlass } from '../../middleware/requireBreakGlass.js'
import * as sessionService from './session.service.js'

export const sessionRoutes = Router()

sessionRoutes.use(requireAdminAuth)
// Deliberately unchanged and deliberately narrow. dataAdmin's break-glass path to
// a raw original lives in sessionBreakGlassRoutes below, mounted as its own
// router — widening this floor would have quietly opened every session route in
// the file to a role the matrix admits to exactly one of them.
sessionRoutes.use(requireRole('collectionAgent', 'super_admin'))

// Serving helper. Media leaves this process as a decrypted buffer and never as a
// path handed to res.sendFile — sendFile would stream the sealed bytes straight
// off disk, bypassing both decryption and every check in session.service.
function sendMedia(res, { buffer, mimeType }) {
  res.set('Cache-Control', 'private, no-store')
  res.type(mimeType).send(buffer)
}

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
  type: z.enum(['IMAGE', 'AUDIO', 'TEXT']).default('IMAGE'),
})

const listQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'PROCESSING', 'TAGGING', 'ARCHIVED', 'FAILED']).optional(),
  type: z.enum(['IMAGE', 'AUDIO', 'TEXT']).optional(),
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

// logAccess sits between the guard and the handler on every media route: the
// AccessEvent is written before session.service is ever asked to decrypt, and if
// that write fails the handler never runs (invariant 6).
//
// Caching also changed here. These responses used to be `max-age=86400,
// immutable`, which meant a browser could re-display a face for a day with no
// second AccessEvent — and could still display it after the subject erased.
// no-store is the only setting consistent with logging every read.
sessionRoutes.get(
  '/:sessionId/photos/:photoId/file',
  logAccess('PHOTO', (req) => req.params.photoId, { purpose: 'COLLECTION' }),
  async (req, res, next) => {
    try {
      sendMedia(
        res,
        await sessionService.readPhotoFile(
          uuid.parse(req.params.sessionId),
          uuid.parse(req.params.photoId),
          req.admin,
        ),
      )
    } catch (err) {
      next(err)
    }
  },
)

sessionRoutes.get(
  '/:sessionId/photos/:photoId/redacted',
  logAccess('REDACTED_PHOTO', (req) => req.params.photoId, { purpose: 'COLLECTION' }),
  async (req, res, next) => {
    try {
      sendMedia(
        res,
        await sessionService.readRedactedPhoto(
          uuid.parse(req.params.sessionId),
          uuid.parse(req.params.photoId),
          req.admin,
        ),
      )
    } catch (err) {
      next(err)
    }
  },
)

sessionRoutes.get(
  '/:sessionId/faces/:faceId/crop',
  logAccess('FACE_CROP', (req) => req.params.faceId, { purpose: 'TAGGING' }),
  async (req, res, next) => {
    try {
      sendMedia(
        res,
        await sessionService.readFaceCrop(
          uuid.parse(req.params.sessionId),
          uuid.parse(req.params.faceId),
          req.admin,
        ),
      )
    } catch (err) {
      next(err)
    }
  },
)

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
  logAccess('REDACTED_PHOTO', (req) => req.params.photoId, { purpose: 'PER_PERSON_VIEW' }),
  async (req, res, next) => {
    try {
      sendMedia(
        res,
        await sessionService.readPersonRedactedPhoto(
          uuid.parse(req.params.sessionId),
          uuid.parse(req.params.photoId),
          uuid.parse(req.params.subjectId),
          req.admin,
        ),
      )
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

// ---------------------------------------------------------------------------
// Break-glass raw media (matrix §C)
// ---------------------------------------------------------------------------
// Its own router, mounted ahead of sessionRoutes, so that admitting dataAdmin
// here cannot leak into the rest of the session surface. The path is distinct
// from the agent's `/file` route on purpose: two different bases for access
// should not share one URL, or the audit trail cannot tell them apart.
export const sessionBreakGlassRoutes = Router()

// Guards are per-route, NOT router-level. `router.use()` here would run for every
// request that enters this router — and because it is mounted at the same
// /api/v1/sessions prefix as sessionRoutes, that is every session request, not
// just the one route below. A router-level requireRole('dataAdmin') therefore
// 403'd collection agents out of their own sessions entirely. The RBAC matrix
// test caught it; nothing else would have until an agent tried to work.
sessionBreakGlassRoutes.get(
  '/:sessionId/photos/:photoId/raw',
  requireAdminAuth,
  requireRole('dataAdmin', 'super_admin'),
  requireBreakGlass('PHOTO', (req) => sessionService.subjectsOnPhoto(req.params.photoId), {
    resolveObjectId: (req) => req.params.photoId,
  }),
  async (req, res, next) => {
    try {
      // requireBreakGlass has already written the AccessEvent{breakGlass:true}
      // and notified the DPO; reaching this handler means all four conditions
      // held. It reads with a service identity because the caller is not the
      // collecting agent and must not inherit that role's session checks.
      sendMedia(
        res,
        await sessionService.readRawForDsar(
          uuid.parse(req.params.sessionId),
          uuid.parse(req.params.photoId),
          req.breakGlass,
        ),
      )
    } catch (err) {
      next(err)
    }
  },
)
