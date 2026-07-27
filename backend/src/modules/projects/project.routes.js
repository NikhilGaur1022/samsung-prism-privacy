import { Router } from 'express'
import { z } from 'zod'
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import * as projectService from './project.service.js'

export const projectRoutes = Router()

projectRoutes.use(requireAdminAuth)
// Router-level floor only. Every mutating route below carries its own
// requireRole, and the service re-asserts ownership — matrix §B is enforced
// twice on purpose, because a router-level allowlist is easy to widen by
// accident when a new route is added underneath it.
projectRoutes.use(requireRole('collectionAgent', 'dataOwner', 'dpo', 'dataAdmin', 'super_admin'))

const projectIdSchema = z.string().uuid()
const adminIdSchema = z.string().uuid()

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

const createSchema = z.object({
  name: z.string().trim().min(3).max(160),
  purpose: z.string().trim().min(20).max(2000),
  retention: z.string().trim().min(1).max(120).optional(),
  dataTypes: z.array(z.string().trim().min(1)).min(1).optional(),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  consentTemplateId: z.string().uuid().optional(),
})

const updateSchema = createSchema.partial()

// A rejection the owner cannot act on is a dead end, so the reason is mandatory
// and long enough to actually say something.
const rejectSchema = z.object({ reason: z.string().trim().min(20).max(2000) })
const assignSchema = z.object({ adminId: adminIdSchema })

projectRoutes.get('/', async (req, res, next) => {
  try {
    res.json({ items: await projectService.listAssignedProjects(req.admin) })
  } catch (err) {
    next(err)
  }
})

projectRoutes.post('/', requireRole('dataOwner', 'super_admin'), async (req, res, next) => {
  try {
    const input = createSchema.parse(req.body)
    res.status(201).json(await projectService.createProject(input, req.admin))
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

projectRoutes.patch('/:projectId', requireRole('dataOwner', 'super_admin'), async (req, res, next) => {
  try {
    const projectId = projectIdSchema.parse(req.params.projectId)
    const input = updateSchema.parse(req.body)
    res.json(await projectService.updateDraft(projectId, input, req.admin))
  } catch (err) {
    next(err)
  }
})

projectRoutes.post('/:projectId/submit', requireRole('dataOwner', 'super_admin'), async (req, res, next) => {
  try {
    const projectId = projectIdSchema.parse(req.params.projectId)
    res.json(await projectService.submitForApproval(projectId, req.admin))
  } catch (err) {
    next(err)
  }
})

projectRoutes.post('/:projectId/approve', requireRole('dpo', 'super_admin'), async (req, res, next) => {
  try {
    const projectId = projectIdSchema.parse(req.params.projectId)
    res.json(await projectService.approveProject(projectId, req.admin))
  } catch (err) {
    next(err)
  }
})

projectRoutes.post('/:projectId/reject', requireRole('dpo', 'super_admin'), async (req, res, next) => {
  try {
    const projectId = projectIdSchema.parse(req.params.projectId)
    const { reason } = rejectSchema.parse(req.body)
    res.json(await projectService.rejectProject(projectId, reason, req.admin))
  } catch (err) {
    next(err)
  }
})

projectRoutes.post('/:projectId/close', requireRole('dataOwner', 'super_admin'), async (req, res, next) => {
  try {
    const projectId = projectIdSchema.parse(req.params.projectId)
    res.json(await projectService.closeProject(projectId, req.admin))
  } catch (err) {
    next(err)
  }
})

projectRoutes.get('/:projectId/assignments', async (req, res, next) => {
  try {
    const projectId = projectIdSchema.parse(req.params.projectId)
    res.json({ items: await projectService.listAssignments(projectId, req.admin) })
  } catch (err) {
    next(err)
  }
})

projectRoutes.post(
  '/:projectId/assignments',
  requireRole('dataOwner', 'super_admin'),
  async (req, res, next) => {
    try {
      const projectId = projectIdSchema.parse(req.params.projectId)
      const { adminId } = assignSchema.parse(req.body)
      res.status(201).json(await projectService.assignAgent(projectId, adminId, req.admin))
    } catch (err) {
      next(err)
    }
  },
)

projectRoutes.delete(
  '/:projectId/assignments/:adminId',
  requireRole('dataOwner', 'super_admin'),
  async (req, res, next) => {
    try {
      const projectId = projectIdSchema.parse(req.params.projectId)
      const adminId = adminIdSchema.parse(req.params.adminId)
      res.json(await projectService.unassignAgent(projectId, adminId, req.admin))
    } catch (err) {
      next(err)
    }
  },
)

// Returns subject names and emails. The service refuses any role but
// collectionAgent and super_admin (matrix §D) — this guard is the outer one.
projectRoutes.get(
  '/:projectId/subjects',
  requireRole('collectionAgent', 'super_admin'),
  async (req, res, next) => {
    try {
      const projectId = projectIdSchema.parse(req.params.projectId)
      const query = searchQuerySchema.parse(req.query)
      res.json({ items: await projectService.searchProjectSubjects(projectId, req.admin, query) })
    } catch (err) {
      next(err)
    }
  },
)

// Project-scoped oversight reads. collectionAgent is deliberately absent: it has
// /sessions, scoped to its own sessions, and a project-wide roll-up of every
// other agent's work is not part of its job. The service re-asserts ownership
// for dataOwner, so this guard is the outer of two.
const oversight = requireRole('dataOwner', 'dpo', 'dataAdmin', 'super_admin')

projectRoutes.get('/:projectId/sessions', oversight, async (req, res, next) => {
  try {
    const projectId = projectIdSchema.parse(req.params.projectId)
    res.json(await projectService.listProjectSessions(projectId, req.admin))
  } catch (err) {
    next(err)
  }
})

projectRoutes.get('/:projectId/handoffs', oversight, async (req, res, next) => {
  try {
    const projectId = projectIdSchema.parse(req.params.projectId)
    res.json(await projectService.listProjectHandoffs(projectId, req.admin))
  } catch (err) {
    next(err)
  }
})

projectRoutes.get('/:projectId/report', oversight, async (req, res, next) => {
  try {
    const projectId = projectIdSchema.parse(req.params.projectId)
    res.json(await projectService.getProjectReport(projectId, req.admin))
  } catch (err) {
    next(err)
  }
})
