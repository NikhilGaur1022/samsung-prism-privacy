import { Router } from 'express'
import { z } from 'zod'
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import { queryBoolean, itemQuerySchema } from './query.schema.js'
import { ApiError } from '../../middleware/errorHandler.js'
import * as dsarService from './dsar.service.js'
import * as itemSearchService from './itemSearch.service.js'
import * as itemActionService from './itemAction.service.js'
import * as certificateService from './certificate.service.js'
import * as timelineService from './timeline.service.js'
import { buildAccessPackage } from './export.service.js'
import { getPurgeJob } from './purge.service.js'

export const dsarRoutes = Router()

dsarRoutes.use(requireAdminAuth)
dsarRoutes.use(requireRole('dpo', 'dataOwner', 'dataAdmin', 'super_admin'))

const uuid = z.string().uuid()

const queueQuerySchema = z.object({
  status: z.enum(['RECEIVED', 'TRIAGE', 'DISCOVERY', 'EXECUTING', 'REVIEW', 'CLOSED', 'REJECTED']).optional(),
  // The dashboard's three tabs. Projected from `status` by lifecycle.js, never
  // stored — see the note there on why the 7-state enum stays.
  coarse: z.enum(['OPEN', 'IN_PROGRESS', 'CLOSED']).optional(),
  type: z.enum(['ACCESS', 'CORRECT', 'ERASE', 'WITHDRAWAL_ERASURE', 'GRIEVANCE', 'NOMINATION']).optional(),
  overdue: queryBoolean.optional(),
  assignedAdminId: uuid.optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
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
const subjectSearchSchema = z.object({
  q: z.string().trim().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(500).optional(),
})

// Selection is `itemIds` OR `filter`, never both — an operator who ticked rows
// and an operator who said "everything matching" are making different claims,
// and merging them silently would widen a delete past what was on screen. The
// filter mirrors the item grid's own query so "select all matching" resolves to
// the same set the operator is looking at.
const itemActionSchema = z
  .object({
    kind: z.enum(['REDACT', 'DELETE', 'EXPORT']),
    itemIds: z.array(uuid).min(1).max(1000).optional(),
    filter: z
      .object({
        // See query.schema.js — the same DataItemType mirror. Omitting VIDEO here
        // meant "select all matching" could not reach a subject's clips at all.
        type: z.enum(['PHOTO', 'AUDIO', 'VIDEO']).optional(),
        origin: z.enum(['COLLECTION_SESSION', 'IMPORT', 'ENROLLMENT']).optional(),
        projectId: uuid.optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
      })
      .optional(),
    reason: z.string().trim().max(2000).optional(),
  })
  .refine((v) => Boolean(v.itemIds) !== Boolean(v.filter), {
    message: 'Provide exactly one of itemIds or filter',
  })

const itemActionQuerySchema = z.object({
  batchId: uuid.optional(),
  status: z.enum(['REQUESTED', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
})

// 'ALL' preserves the whole-subject package. 'SELECTED' packages whatever the
// operator marked with a Phase 5 EXPORT action. The object forms are the ad-hoc
// paths and are resolved server-side against the request's own subject.
const packageSchema = z.object({
  selection: z
    .union([
      z.literal('ALL'),
      z.literal('SELECTED'),
      z.object({ itemIds: z.array(uuid).min(1).max(2000) }),
      z.object({
        filter: z.object({
          type: z.enum(['PHOTO', 'AUDIO', 'VIDEO']).optional(),
          origin: z.enum(['COLLECTION_SESSION', 'IMPORT', 'ENROLLMENT']).optional(),
          projectId: uuid.optional(),
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
        }),
      }),
    ])
    .default('ALL'),
})

const approveSchema = z.object({ note: z.string().trim().max(2000).optional() })
const closeSchema = z.object({ note: z.string().trim().max(2000).optional() })
const rejectSchema = z.object({ reason: z.string().trim().min(20).max(2000) })

function actorOf(req) {
  return { admin: req.admin ?? null, subject: req.subject ?? null }
}

dsarRoutes.get('/', async (req, res, next) => {
  try {
    const query = queueQuerySchema.parse(req.query)
    // listQueue returns { items, nextCursor, counts }; `items` keeps its old key
    // so the existing dashboard reads unchanged while gaining the paging cursor.
    res.json(await dsarService.listQueue(actorOf(req), query))
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

// Identity search. dataAdmin/super_admin only: it returns names and emails, and
// matrix §D withholds subject identity from dpo and dataOwner outright. Two
// segments, so it cannot collide with /:requestId — mounted here anyway so the
// ordering rule stays obvious to the next person adding a route.
dsarRoutes.get('/subjects/search', requireRole('dataAdmin', 'super_admin'), async (req, res, next) => {
  try {
    const query = subjectSearchSchema.parse(req.query)
    res.json(await itemSearchService.searchSubjects(query, { admin: req.admin, req }))
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

// Explicit close from the request workspace. Blocked while any item action is
// still in flight — see closeRequest().
dsarRoutes.post(
  '/:requestId/close',
  requireRole('dpo', 'dataAdmin', 'super_admin'),
  async (req, res, next) => {
    try {
      const body = closeSchema.parse(req.body)
      res.json(await dsarService.closeRequest(uuid.parse(req.params.requestId), body, req.admin))
    } catch (err) {
      next(err)
    }
  },
)

// Builds a package with a selection. The existing token/download flow is
// unchanged — this only decides what goes into the archive it serves.
dsarRoutes.post(
  '/:requestId/package',
  requireRole('dataAdmin', 'super_admin'),
  async (req, res, next) => {
    try {
      const body = packageSchema.parse(req.body ?? {})
      res.status(201).json(
        await buildAccessPackage(uuid.parse(req.params.requestId), req.admin, {
          selection: body.selection,
        }),
      )
    } catch (err) {
      next(err)
    }
  },
)

// The merged history. Same role floor as the item grid: pseudonymous throughout,
// so oversight does not cost the dpo the identity separation §D guarantees.
dsarRoutes.get(
  '/:requestId/timeline',
  requireRole('dpo', 'dataAdmin', 'super_admin'),
  async (req, res, next) => {
    try {
      res.json(await timelineService.getRequestTimeline(uuid.parse(req.params.requestId), req.admin))
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

// The completeness surface. Same role floor as /media (pseudonymous, names no
// principal), but paged, filterable and counted: `totals.all` is a count() over
// the index, so "this is everything" is asserted from the database, not from the
// length of the page that happened to be returned.
dsarRoutes.get(
  '/:requestId/items',
  requireRole('dataAdmin', 'dpo', 'super_admin'),
  async (req, res, next) => {
    try {
      const query = itemQuerySchema.parse(req.query)
      res.json(
        await itemSearchService.listItemsForRequest(uuid.parse(req.params.requestId), req.admin, query, {
          req,
        }),
      )
    } catch (err) {
      next(err)
    }
  },
)

// The action surface. dataAdmin/super_admin only: dpo can see the item grid and
// the action log, but approving a purpose is not the same authority as
// destroying a frame, and dataOwner has no business either way.
dsarRoutes.post(
  '/:requestId/items/actions',
  requireRole('dataAdmin', 'super_admin'),
  async (req, res, next) => {
    try {
      const body = itemActionSchema.parse(req.body)
      res.status(202).json(
        await itemActionService.requestActions(
          { dsarRequestId: uuid.parse(req.params.requestId), ...body },
          req.admin,
        ),
      )
    } catch (err) {
      next(err)
    }
  },
)

// Batch progress. Same role floor as the item grid — reading what was done to a
// principal's data is oversight, and withholding it from the dpo would defeat
// the point of having one.
dsarRoutes.get(
  '/:requestId/items/actions',
  requireRole('dataAdmin', 'dpo', 'super_admin'),
  async (req, res, next) => {
    try {
      const query = itemActionQuerySchema.parse(req.query)
      res.json(
        await itemActionService.listActions(uuid.parse(req.params.requestId), query, req.admin),
      )
    } catch (err) {
      next(err)
    }
  },
)

dsarRoutes.get('/:requestId/certificate', async (req, res, next) => {
  try {
    const requestId = uuid.parse(req.params.requestId)
    const certificate = await certificateService.getCertificateForRequest(requestId)
    if (!certificate) {
      const why = await certificateService.explainMissingCertificate(requestId)
      throw new ApiError(404, why?.explanation ?? 'No certificate has been issued for this request', {
        reason: why?.reason,
        certificateUnavailable: why ?? undefined,
      })
    }
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
      res.json(
        await getPurgeJob(uuid.parse(req.params.purgeJobId), {
          dsarRequestId: uuid.parse(req.params.requestId),
        }),
      )
    } catch (err) {
      next(err)
    }
  },
)
