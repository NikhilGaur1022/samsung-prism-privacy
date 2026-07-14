import { Router } from 'express'
import { z } from 'zod'
import { requireSubjectAuth } from '../../middleware/requireSubjectAuth.js'
import * as consentService from './consent.service.js'

export const consentRoutes = Router()

consentRoutes.use(requireSubjectAuth)

const projectIdSchema = z.string().uuid()

consentRoutes.get('/projects', async (req, res, next) => {
  try {
    res.json({ items: await consentService.listProjectsForSubject(req.subject.masterUserId) })
  } catch (err) {
    next(err)
  }
})

consentRoutes.post('/projects/:projectId/grant', async (req, res, next) => {
  try {
    const projectId = projectIdSchema.parse(req.params.projectId)
    res.json(await consentService.grantConsent(req.subject.masterUserId, projectId))
  } catch (err) {
    next(err)
  }
})

consentRoutes.post('/projects/:projectId/revoke', async (req, res, next) => {
  try {
    const projectId = projectIdSchema.parse(req.params.projectId)
    res.json(await consentService.revokeConsent(req.subject.masterUserId, projectId))
  } catch (err) {
    next(err)
  }
})
