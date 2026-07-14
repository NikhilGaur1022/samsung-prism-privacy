import { Router } from 'express'
import { z } from 'zod'
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import * as projectService from './project.service.js'

export const projectRoutes = Router()

projectRoutes.use(requireAdminAuth)
projectRoutes.use(requireRole('collectionAgent', 'dataOwner', 'dpo', 'super_admin'))

const projectIdSchema = z.string().uuid()
const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

projectRoutes.get('/', async (req, res, next) => {
  try {
    res.json({ items: await projectService.listAssignedProjects(req.admin) })
  } catch (err) {
    next(err)
  }
})

projectRoutes.get('/:projectId', async (req, res, next) => {
  try {
    const projectId = projectIdSchema.parse(req.params.projectId)
    res.json(await projectService.assertAssigned(projectId, req.admin))
  } catch (err) {
    next(err)
  }
})

projectRoutes.get('/:projectId/subjects', async (req, res, next) => {
  try {
    const projectId = projectIdSchema.parse(req.params.projectId)
    const query = searchQuerySchema.parse(req.query)
    res.json({ items: await projectService.searchProjectSubjects(projectId, req.admin, query) })
  } catch (err) {
    next(err)
  }
})
