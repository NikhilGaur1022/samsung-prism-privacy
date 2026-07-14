import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { subjectIdParamSchema } from './subject.validation.js'
import * as subjectController from './subject.controller.js'

export const subjectRoutes = Router()

subjectRoutes.use(requireAuth)

// Validates :id is a UUID before it ever reaches Prisma — a malformed id would
// otherwise throw a raw Prisma error (500, leaks internals) instead of a clean 400.
function validateIdParam(req, res, next) {
  try {
    subjectIdParamSchema.parse(req.params.id)
    next()
  } catch (err) {
    next(err)
  }
}

subjectRoutes.post('/', subjectController.register)
subjectRoutes.get('/', subjectController.list)
subjectRoutes.get('/:id', validateIdParam, subjectController.getOne)
subjectRoutes.patch('/:id/consent', validateIdParam, subjectController.updateConsent)
subjectRoutes.patch('/:id/status', validateIdParam, subjectController.updateStatus)
subjectRoutes.patch('/:id/group', validateIdParam, subjectController.updateGroup)
