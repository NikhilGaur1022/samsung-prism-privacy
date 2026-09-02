import { Router } from 'express'
import { z } from 'zod'
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import * as projectService from './project.service.js'
import * as projectExportService from './projectExport.service.js'
import { exportLimiter, mediaReadLimiter } from '../../middleware/rateLimiter.js'
import { dataTypeArraySchema } from '../../lib/dataTypeSchema.js'

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
  // Same schema the consent-template router uses. assertPurposeLimitation
  // compares these two lists by exact string, so they have to be normalised by
  // the same rules or a project is refused against a notice that discloses
  // exactly what it asked for, spelled differently.
  dataTypes: dataTypeArraySchema.optional(),
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

// ---------------------------------------------------------------------------
// Project export
// ---------------------------------------------------------------------------
// The requirement that did not exist. Before these four routes, no endpoint in
// the application returned project-scoped media or an archive — the project
// surface ended at /report, which is 765 bytes of JSON counts.
//
// The role floor here is narrower than `oversight`: dpo and dataAdmin may READ a
// project for oversight, but taking a copy of its media out is the data owner's
// own act on their own project. The service re-asserts both, so this is the
// outer of two checks rather than the only one.
const exportRole = requireRole('dataOwner', 'super_admin')

projectRoutes.post('/:projectId/exports', exportRole, exportLimiter, async (req, res, next) => {
  try {
    const projectId = projectIdSchema.parse(req.params.projectId)
    const job = await projectExportService.requestProjectExport(projectId, req.admin)
    res.status(202).json({
      id: job.id,
      status: job.status,
      // 202 with a poll target, not 200 with an archive. A project export takes
      // minutes and can run to gigabytes; a synchronous response cannot survive
      // either.
      poll: `/api/v1/projects/${projectId}/exports/${job.id}`,
    })
  } catch (err) {
    next(err)
  }
})

projectRoutes.get('/:projectId/exports', oversight, async (req, res, next) => {
  try {
    const projectId = projectIdSchema.parse(req.params.projectId)
    res.json({ items: await projectExportService.listProjectExports(projectId, req.admin) })
  } catch (err) {
    next(err)
  }
})

projectRoutes.get('/:projectId/exports/:id', oversight, async (req, res, next) => {
  try {
    const projectId = projectIdSchema.parse(req.params.projectId)
    res.json(await projectExportService.getProjectExport(projectId, req.params.id, req.admin))
  } catch (err) {
    next(err)
  }
})

// The download. Range-capable, because these archives are large enough that a
// dropped connection on a non-resumable download means starting over.
//
// The AccessEvent is written inside openProjectExport() BEFORE a byte is read,
// and on every request including a resumed one. That record is what replaces the
// approval gate the scope decision removed, which is why it is not optional.
projectRoutes.get('/:projectId/exports/:id/download', exportRole, mediaReadLimiter, async (req, res, next) => {
  try {
    const projectId = projectIdSchema.parse(req.params.projectId)
    const opened = await projectExportService.openProjectExport(
      projectId,
      req.params.id,
      req.admin,
      { range: req.headers.range, req },
    )

    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="${opened.filename}"`)
    res.setHeader('Accept-Ranges', 'bytes')
    // The whole-archive hash, so a client can verify what it received. Quoted
    // and weak-prefixed is wrong for a strong hash, so it is sent as its own
    // header alongside a strong ETag.
    if (opened.contentHash) {
      res.setHeader('ETag', `"${opened.contentHash}"`)
      res.setHeader('X-Content-SHA256', opened.contentHash)
    }

    if (opened.partial) {
      res.status(206)
      res.setHeader('Content-Range', `bytes ${opened.start}-${opened.end}/${opened.total}`)
      res.setHeader('Content-Length', String(opened.end - opened.start + 1))
    } else {
      res.setHeader('Content-Length', String(opened.total))
    }

    opened.stream.on('error', (err) => {
      // Past the headers there is no way to turn this into a clean error
      // response, so the connection is destroyed rather than left to look like a
      // successful truncated download.
      req.log?.error?.({ err }, 'export stream failed mid-response')
      res.destroy(err)
    })
    opened.stream.pipe(res)
  } catch (err) {
    next(err)
  }
})
