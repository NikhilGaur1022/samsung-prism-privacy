import { Router } from 'express'
import multer from 'multer'

import { requireAdminAuth } from '../../middleware/requireAdminAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import { ApiError } from '../../middleware/errorHandler.js'
import * as importService from './import.service.js'
import { mimeFilter, withUploadErrors, requireFileKind } from '../../middleware/uploads.js'
import { uploadLimiter } from '../../middleware/rateLimiter.js'
import {
  MAX_FILE_BYTES,
  MAX_FILES_PER_REQUEST,
  closeBatchSchema,
  createBatchSchema,
  ingestMetaSchema,
  listBatchesSchema,
  uuid,
} from './import.validators.js'

export const importRoutes = Router()

importRoutes.use(requireAdminAuth)
// dataAdmin and super_admin only. Importing is writing a person's data into the
// system on their behalf, which is the data-administration authority — a dpo
// approves purposes and a dataOwner runs a project, and neither of those is the
// authority to assert "this photograph is of this named person".
importRoutes.use(requireRole('dataAdmin', 'super_admin'))

// Same limits as the capture path. An import that accepted larger or stranger
// files than a collection session would simply be the softer way in.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_REQUEST },
  fileFilter: mimeFilter('image/'),
})

importRoutes.post('/', async (req, res, next) => {
  try {
    const body = createBatchSchema.parse(req.body)
    res.status(201).json(await importService.createBatch(body, req.admin))
  } catch (err) {
    next(err)
  }
})

importRoutes.get('/', async (req, res, next) => {
  try {
    const query = listBatchesSchema.parse(req.query)
    res.json(await importService.listBatches(query))
  } catch (err) {
    next(err)
  }
})

// Mounted before /:batchId so the literal segment is never parsed as an id.
importRoutes.post(
  '/:batchId/items',
  uploadLimiter,
  withUploadErrors(upload.array('photos', MAX_FILES_PER_REQUEST)),
  // The header said image/jpeg; these bytes decide whether it was true. Without
  // it, non-image content reached sharp and came back as a 500 carrying libvips
  // internals.
  requireFileKind('image', { field: 'photos' }),
  async (req, res, next) => {
    try {
      const batchId = uuid.parse(req.params.batchId)
      const meta = ingestMetaSchema.parse(req.body)
      if (!req.files?.length) throw new ApiError(400, 'No files uploaded')

      // Sequential, not Promise.all: each file seals a blob and opens a
      // transaction, and PgBouncer caps this service at 20 connections. Twenty
      // parallel ingests would exhaust the pool for every other request in the
      // process.
      const results = []
      for (const file of req.files) {
        results.push(
          await importService.ingestItem(
            { batchId, file, takenAt: meta.takenAt ?? null },
            req.admin,
          ),
        )
      }

      res.status(201).json({
        ingested: results.filter((r) => !r.duplicate).length,
        duplicates: results.filter((r) => r.duplicate).length,
        items: results,
      })
    } catch (err) {
      next(err)
    }
  },
)

importRoutes.post('/:batchId/close', async (req, res, next) => {
  try {
    const body = closeBatchSchema.parse(req.body ?? {})
    res.json(await importService.closeBatch(uuid.parse(req.params.batchId), body, req.admin))
  } catch (err) {
    next(err)
  }
})

importRoutes.get('/:batchId', async (req, res, next) => {
  try {
    res.json(await importService.getBatch(uuid.parse(req.params.batchId)))
  } catch (err) {
    next(err)
  }
})
