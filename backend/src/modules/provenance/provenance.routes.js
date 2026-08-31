import { Router } from 'express'
import multer from 'multer'

import { requireAdminAuth } from '../../middleware/requireAdminAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { mimeFilter, withUploadErrors, requireFileKind } from '../../middleware/uploads.js'
import { uploadLimiter } from '../../middleware/rateLimiter.js'
import * as provenanceService from './provenance.service.js'

export const provenanceRoutes = Router()

provenanceRoutes.use(requireAdminAuth)

// DPO and super_admin only, and not because the answer is sensitive to compute —
// because the answer NAMES PEOPLE. The stamp is pseudonymous by construction so
// that an image leaving the platform does not carry identities with it; this
// endpoint undoes that on purpose, for the one role whose job includes "this file
// turned up somewhere it should not have, who do I have to notify".
//
// Every lookup is written as an AccessEvent, and each identity resolved is
// written as a second one against that subject, so using this tool is as
// answerable as the reads it investigates.
provenanceRoutes.use(requireRole('dpo', 'super_admin'))

// 20 MB: a training-set JPEG that has been through a few tools can be well over
// the 10 MB an enrollment selfie is capped at, and being told "too large" on the
// one image someone is trying to trace is a bad failure.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: mimeFilter('image/'),
})

provenanceRoutes.post(
  '/lookup',
  uploadLimiter,
  withUploadErrors(upload.single('image')),
  requireFileKind('image', { field: 'image' }),
  async (req, res, next) => {
    try {
      if (!req.file?.buffer?.length) throw new ApiError(400, 'No image was uploaded')
      res.json(
        await provenanceService.identifyImage(req.file.buffer, { req, admin: req.admin }),
      )
    } catch (err) {
      next(err)
    }
  },
)
