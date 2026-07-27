import { Router } from 'express'
import { z } from 'zod'
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import { ApiError } from '../../middleware/errorHandler.js'
import * as dsarService from './dsar.service.js'
import * as certificateService from './certificate.service.js'
import { getPurgeJob } from './purge.service.js'

export const dsarRoutes = Router()

dsarRoutes.use(requireAdminAuth)
dsarRoutes.use(requireRole('dpo', 'dataOwner', 'dataAdmin', 'super_admin'))

const uuid = z.string().uuid()

const queueQuerySchema = z.object({
  status: z.enum(['RECEIVED', 'TRIAGE', 'DISCOVERY', 'EXECUTING', 'REVIEW', 'CLOSED', 'REJECTED']).optional(),
  type: z.enum(['ACCESS', 'CORRECT', 'ERASE', 'WITHDRAWAL_ERASURE', 'GRIEVANCE', 'NOMINATION']).optional(),
  overdue: z.coerce.boolean().optional(),
})

const assignSchema = z.object({ assignedAdminId: uuid })
const evidenceSchema = z.object({
  kind: z.enum(['DISCOVERY_RESULT', 'IDENTITY_PROOF', 'EXPORT_PACKAGE', 'PURGE_REPORT', 'CORRESPONDENCE', 'APPROVAL']),
  label: z.string().trim().min(3).max(200),
  payload: z.record(z.string(), z.unknown()).optional(),
})
const evidenceQuerySchema = z.object({
  kind: z.enum(['DISCOVERY_RESULT', 'IDENTITY_PROOF', 'EXPORT_PACKAGE', 'PURGE_REPORT', 'CORRESPONDENCE', 'APPROVAL']).optional(),
  dsarRequestId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})
const approveSchema = z.object({ note: z.string().trim().max(2000).optional() })
const rejectSchema = z.object({ reason: z.string().trim().min(20).max(2000) })

function actorOf(req) {
  return { admin: req.admin ?? null, subject: req.subject ?? null }
}

dsarRoutes.get('/', async (req, res, next) => {
  try {
    const query = queueQuerySchema.parse(req.query)
    res.json({ items: await dsarService.listQueue(actorOf(req), query) })
  } catch (err) {
    next(err)
  }
})

// Mounted before /:requestId so "sla" is not parsed as a request id.
dsarRoutes.get('/sla', requireRole('dpo', 'dataAdmin', 'super_admin'), async (_req, res, next) => {
  try {
    res.json(await dsarService.slaSummary())
  } catch (err) {
    next(err)
  }
})

// Vault-wide, also before /:requestId so "evidence" is not parsed as an id.
dsarRoutes.get('/evidence', async (req, res, next) => {
  try {
    const query = evidenceQuerySchema.parse(req.query)
    res.json({ items: await dsarService.listEvidenceVault(actorOf(req), query) })
  } catch (err) {
    next(err)
  }
})

// The public half of the certificate signing key, so a principal or an auditor
// can verify a certificate without asking us to verify it for them.
dsarRoutes.get('/signing-key', async (_req, res, next) => {
  try {
    res.json(certificateService.publicKeyInfo())
  } catch (err) {
    next(err)
  }
})

dsarRoutes.get('/:requestId', async (req, res, next) => {
  try {
    res.json(await dsarService.getRequest(uuid.parse(req.params.requestId), actorOf(req)))
  } catch (err) {
    next(err)
  }
})

dsarRoutes.post('/:requestId/assign', requireRole('dpo', 'super_admin'), async (req, res, next) => {
  try {
    const body = assignSchema.parse(req.body)
    res.json(await dsarService.assign(uuid.parse(req.params.requestId), body, req.admin))
  } catch (err) {
    next(err)
  }
})

dsarRoutes.post(
  '/:requestId/discovery',
  requireRole('dataOwner', 'dataAdmin', 'super_admin'),
  async (req, res, next) => {
    try {
      res.json(await dsarService.runDiscoveryForRequest(uuid.parse(req.params.requestId), req.admin))
    } catch (err) {
      next(err)
    }
  },
)

dsarRoutes.post(
  '/:requestId/evidence',
  requireRole('dataOwner', 'dataAdmin', 'super_admin'),
  async (req, res, next) => {
    try {
      const body = evidenceSchema.parse(req.body)
      res.status(201).json(await dsarService.attachEvidence(uuid.parse(req.params.requestId), body, req.admin))
    } catch (err) {
      next(err)
    }
  },
)

// Execution is dataAdmin/root only. A data owner can search and evidence their
// own project, but destroying a principal's data across projects is not theirs.
dsarRoutes.post('/:requestId/execute', requireRole('dataAdmin', 'super_admin'), async (req, res, next) => {
  try {
    const inline = req.body?.inline !== false
    res.json(await dsarService.execute(uuid.parse(req.params.requestId), req.admin, { inline }))
  } catch (err) {
    next(err)
  }
})

dsarRoutes.post(
  '/:requestId/approve',
  requireRole('dpo', 'dataOwner', 'super_admin'),
  async (req, res, next) => {
    try {
      const body = approveSchema.parse(req.body)
      res.json(await dsarService.approveResolution(uuid.parse(req.params.requestId), body, req.admin))
    } catch (err) {
      next(err)
    }
  },
)

dsarRoutes.post('/:requestId/reject', requireRole('dpo', 'super_admin'), async (req, res, next) => {
  try {
    const body = rejectSchema.parse(req.body)
    res.json(await dsarService.rejectRequest(uuid.parse(req.params.requestId), body, req.admin))
  } catch (err) {
    next(err)
  }
})

// Metadata only — ids an operator needs to name a frame in a break-glass
// justification. No media, no path, no other principal's identity.
dsarRoutes.get(
  '/:requestId/media',
  requireRole('dataAdmin', 'dpo', 'super_admin'),
  async (req, res, next) => {
    try {
      res.json(await dsarService.listSubjectMedia(uuid.parse(req.params.requestId), req.admin))
    } catch (err) {
      next(err)
    }
  },
)

dsarRoutes.get('/:requestId/certificate', async (req, res, next) => {
  try {
    const requestId = uuid.parse(req.params.requestId)
    const certificate = await certificateService.getCertificateForRequest(requestId)
    if (!certificate) throw new ApiError(404, 'No certificate has been issued for this request')
    const verification = await certificateService.verifyCertificate(certificate.id)
    res.json({ certificate, verification })
  } catch (err) {
    next(err)
  }
})

dsarRoutes.get(
  '/:requestId/purge-jobs/:purgeJobId',
  requireRole('dataAdmin', 'dpo', 'super_admin'),
  async (req, res, next) => {
    try {
      res.json(await getPurgeJob(uuid.parse(req.params.purgeJobId)))
    } catch (err) {
      next(err)
    }
  },
)
