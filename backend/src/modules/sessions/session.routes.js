import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import { logAccess } from '../../middleware/logAccess.js'
import { requireBreakGlass } from '../../middleware/requireBreakGlass.js'
import * as sessionService from './session.service.js'
import { mimeFilter, withUploadErrors, diskStorage, uploadTmpDir } from '../../middleware/uploads.js'
import { rm as fsRm } from 'node:fs/promises'
import { ApiError } from '../../middleware/errorHandler.js'
import { mediaReadLimiter } from '../../middleware/rateLimiter.js'
import { uploadLimiter } from '../../middleware/rateLimiter.js'

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

// 20 files x 25 MB in memoryStorage is up to 500 MB resident per request with
// nothing releasing it until the handler returns — one POST was measured at
// exactly that. Spooled to disk instead: a temp file per upload is the price of
// surviving concurrent uploads at 5,000 images/day.
//
// The filter rejects with ApiError(415) rather than a bare Error, which
// errorHandler had no choice but to render as a 500 — as it did for a wrong
// mimetype, a 26 MB file and a 21-file batch alike.
const upload = withUploadErrors(
  multer({
    storage: diskStorage(uploadTmpDir()),
    limits: { fileSize: 25 * 1024 * 1024, files: 20 },
    fileFilter: mimeFilter('image/'),
  }).array('photos', 20),
)

const uuid = z.string().uuid()

const createSessionSchema = z.object({
  projectId: uuid,
  location: z.string().trim().max(200).optional(),
  type: z.enum(['IMAGE', 'AUDIO', 'TEXT', 'VIDEO']).default('IMAGE'),
})

const listQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'PROCESSING', 'TAGGING', 'ARCHIVED', 'FAILED']).optional(),
  type: z.enum(['IMAGE', 'AUDIO', 'TEXT', 'VIDEO']).optional(),
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
const trackIdsSchema = z.object({ trackIds: z.array(uuid).min(1) })
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
sessionRoutes.post('/:sessionId/photos', uploadLimiter, upload, async (req, res, next) => {
  try {
    const sessionId = uuid.parse(req.params.sessionId)
    const meta = photoMetaSchema.parse(req.body)
    if (!req.files?.length) throw new ApiError(400, 'No files uploaded')

    // A per-file result array, not an all-or-nothing throw.
    //
    // A 20-file batch that failed on file 12 used to leave 11 photos committed
    // and return an error naming none of them. The client could not tell what to
    // retry, and a naive retry re-uploaded all 20 — sha256 dedup absorbed the
    // duplicates, so the damage was bounded, but the operator had no way to know
    // that. Now every file reports its own outcome and the request succeeds as a
    // whole; a partial batch is a normal result, not an exception.
    const accepted = []
    const rejected = []

    for (const file of req.files) {
      try {
        const result = await sessionService.addPhoto(sessionId, file, meta, req.admin)
        accepted.push({
          filename: file.originalname,
          photoId: result.photo.id,
          duplicate: Boolean(result.duplicate),
        })
      } catch (err) {
        // A 4xx is about this file and is safe to name. Anything else is an
        // internal failure whose message must not cross the boundary — the same
        // rule errorHandler applies, applied per file.
        const isClientError = err.statusCode >= 400 && err.statusCode < 500
        rejected.push({
          filename: file.originalname,
          reason: isClientError ? err.message : 'Could not be processed',
          code: isClientError ? (err.code ?? 'REJECTED') : 'INTERNAL_ERROR',
        })
        if (!isClientError) {
          req.log?.error?.({ err, filename: file.originalname }, 'photo upload failed')
        }
      }
    }

    res.status(rejected.length === 0 ? 201 : 207).json({
      added: accepted.filter((a) => !a.duplicate).length,
      duplicates: accepted.filter((a) => a.duplicate).length,
      failed: rejected.length,
      accepted,
      rejected,
      photos: accepted.map((a) => a.photoId),
    })
  } catch (err) {
    next(err)
  } finally {
    // Disk-backed uploads leave a temp file behind whatever happens.
    for (const file of req.files ?? []) {
      if (file.path) await fsRm(file.path, { force: true }).catch(() => {})
    }
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
  mediaReadLimiter,
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

// The agent's grid, at grid size. Same guards, same limiter, same access row as
// /file above — it resolves through readPhotoFile, so there is no second
// authorisation path to keep in step with the first.
sessionRoutes.get(
  '/:sessionId/photos/:photoId/file/thumb',
  mediaReadLimiter,
  logAccess('PHOTO', (req) => req.params.photoId, { purpose: 'COLLECTION' }),
  async (req, res, next) => {
    try {
      sendMedia(
        res,
        await sessionService.readPhotoFileThumb(
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
  mediaReadLimiter,
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

// The video counterpart of /split. Same shape, same guard, different medium —
// a person who appears only in a clip has no face ids to split on.
sessionRoutes.post('/:sessionId/clusters/:clusterId/split-tracks', async (req, res, next) => {
  try {
    const body = trackIdsSchema.parse(req.body)
    res.json(
      await sessionService.splitTracks(
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
  mediaReadLimiter,
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
// Redacted media (matrix §B)
// ---------------------------------------------------------------------------
// Its own router for the same reason break-glass has one: these two routes admit
// dataOwner and dataAdmin, and sessionRoutes' router-level floor is
// collectionAgent-only. Widening that floor would have opened tagging, finalize
// and the raw-original route to them at the same time.
//
// Matrix §B grants `/sessions/:id/photos/:pid/redacted` to "dataOwner ✓ own
// project" and "dataAdmin ✓", but the route only ever existed behind the agent
// floor — so once an agent finalized, the redacted set that is the whole point of
// the pipeline was reachable by nobody. That is what this closes.
//
// dpo is deliberately absent: §A says the role "cannot see any personal data",
// and a blurred bystander is still a photograph of the consented subject.
export const sessionMediaRoutes = Router()

const mediaReaders = [
  requireAdminAuth,
  requireRole('collectionAgent', 'dataOwner', 'dataAdmin', 'super_admin'),
]

// The frame index. Oversight roles cannot call GET /:sessionId (matrix §B denies
// them the session record and its roster), so without this they had ids for
// nothing and no way to enumerate what to render.
sessionMediaRoutes.get('/:sessionId/photos', ...mediaReaders, async (req, res, next) => {
  try {
    res.json(
      await sessionService.listSessionPhotosForOversight(
        uuid.parse(req.params.sessionId),
        req.admin,
      ),
    )
  } catch (err) {
    next(err)
  }
})

sessionMediaRoutes.get(
  '/:sessionId/photos/:photoId/redacted',
  ...mediaReaders,
  mediaReadLimiter,
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

// The grid-sized version of the same object, behind exactly the same readers,
// the same limiter and the same access log entry. Identical authorisation is the
// point: a thumbnail of a face is the same personal data at a smaller size, and
// a cheaper-to-serve variant must not become a cheaper-to-reach one.
sessionMediaRoutes.get(
  '/:sessionId/photos/:photoId/redacted/thumb',
  ...mediaReaders,
  mediaReadLimiter,
  // Logged as REDACTED_PHOTO, not as a new object type. It is the same object
  // at a smaller size, and inventing a second value would split one person's
  // views of one frame across two rows in the access ledger for no gain — and
  // would need a migration to a DB enum besides.
  logAccess('REDACTED_PHOTO', (req) => req.params.photoId, { purpose: 'COLLECTION' }),
  async (req, res, next) => {
    try {
      sendMedia(
        res,
        await sessionService.readRedactedPhotoThumb(
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
