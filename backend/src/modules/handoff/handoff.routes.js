import { Router } from 'express'
import { z } from 'zod'
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import * as handoffService from './handoff.service.js'

export const handoffRoutes = Router()

handoffRoutes.use(requireAdminAuth)
handoffRoutes.use(requireRole('dataAdmin', 'super_admin'))

const uuid = z.string().uuid()

const listQuerySchema = z.object({
  status: z.enum(['PENDING_INGEST', 'INGESTED', 'REJECTED']).optional(),
})

const lineageQuerySchema = z.object({
  projectId: uuid.optional(),
  subjectId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

handoffRoutes.get('/', async (req, res, next) => {
  try {
    res.json(await handoffService.listHandoffs(listQuerySchema.parse(req.query)))
  } catch (err) {
    next(err)
  }
})

// Declared before /:id so "lineage" is never parsed as a handoff id.
handoffRoutes.get('/lineage', async (req, res, next) => {
  try {
    res.json(await handoffService.getLineage(lineageQuerySchema.parse(req.query)))
  } catch (err) {
    next(err)
  }
})

handoffRoutes.get('/:id', async (req, res, next) => {
  try {
    res.json(await handoffService.getHandoff(uuid.parse(req.params.id)))
  } catch (err) {
    next(err)
  }
})

handoffRoutes.post('/:id/ingest', async (req, res, next) => {
  try {
    res.json(await handoffService.ingestHandoff(uuid.parse(req.params.id), req.admin))
  } catch (err) {
    next(err)
  }
})
