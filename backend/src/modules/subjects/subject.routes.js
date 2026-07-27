import { Router } from 'express'
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import { subjectIdParamSchema } from './subject.validation.js'
import * as subjectController from './subject.controller.js'

export const subjectRoutes = Router()

// These handlers return and mutate data-principal identity: names, emails,
// employee references, consent flags. They were previously behind requireAuth,
// a development stub that attached a fake user and called next() — which meant
// GET /api/v1/subjects answered an unauthenticated request with the full subject
// list. The production boot guard did not help: it checks an env var, it does
// not put a real check on this router.
//
// Matrix §B: only a collection agent (in-session) and platform root reach subject
// identity. The DPO and the Data Owner are withheld it outright, and a data
// principal reaches their own record through /api/v1/me, never here.
subjectRoutes.use(requireAdminAuth)
subjectRoutes.use(requireRole('collectionAgent', 'super_admin'))

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
