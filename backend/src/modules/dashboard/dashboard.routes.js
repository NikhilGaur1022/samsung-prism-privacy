import { Router } from 'express'
import { z } from 'zod'
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import * as dashboardService from './dashboard.service.js'

export const dashboardRoutes = Router()

dashboardRoutes.use(requireAdminAuth)
dashboardRoutes.use(requireRole('dpo', 'dataOwner', 'collectionAgent', 'dataAdmin', 'super_admin'))

// Deliberately has no role parameter. The role comes from the verified token, so
// there is no request a dpo can make that returns the dataAdmin payload.
dashboardRoutes.get('/summary', async (req, res, next) => {
  try {
    res.json(await dashboardService.getSummary(req.admin))
  } catch (err) {
    next(err)
  }
})

const reportQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})

// The accountability report. collectionAgent is excluded by this guard — the
// router-level floor admits it for /summary, and an agent has no oversight role.
dashboardRoutes.get(
  '/compliance-report',
  requireRole('dpo', 'dataOwner', 'dataAdmin', 'super_admin'),
  async (req, res, next) => {
    try {
      const query = reportQuerySchema.parse(req.query)
      res.json(await dashboardService.getComplianceReport(req.admin, query))
    } catch (err) {
      next(err)
    }
  },
)
