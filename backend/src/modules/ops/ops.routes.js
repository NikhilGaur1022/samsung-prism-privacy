import { Router } from 'express'
import { z } from 'zod'
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import * as opsService from './ops.service.js'

export const opsRoutes = Router()

// Operational, not evidentiary. This returns queue depths, job ages and worker
// reachability — no subject identity, no media, no consent state — so the floor
// is the two roles that operate the platform plus root. The DPO is deliberately
// admitted: "is redaction actually running" is an accountability question, and
// the answer used to be unobtainable by anyone.
opsRoutes.use(requireAdminAuth)
opsRoutes.use(requireRole('dataAdmin', 'dpo', 'super_admin'))

opsRoutes.get('/queue-health', async (req, res, next) => {
  try {
    res.json(await opsService.getQueueHealth())
  } catch (err) {
    next(err)
  }
})

const requeueSchema = z.object({
  queueName: z.string().trim().min(1).max(64).optional(),
  jobId: z.string().trim().min(1).max(128).optional(),
})

// Runs a reaper sweep now. The reaper runs on its own interval regardless; this
// exists so an operator who has just restarted the PII worker does not have to
// wait out the interval to see whether it took.
opsRoutes.post('/requeue', requireRole('dataAdmin', 'super_admin'), async (req, res, next) => {
  try {
    const body = requeueSchema.parse(req.body ?? {})
    res.json(await opsService.requeueStalled(body, req.admin))
  } catch (err) {
    next(err)
  }
})
