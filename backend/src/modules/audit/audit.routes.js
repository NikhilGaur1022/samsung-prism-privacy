import { Router } from 'express'
import { z } from 'zod'
import { requireAnyPrincipal } from '../../middleware/requireAnyPrincipal.js'
import { ApiError } from '../../middleware/errorHandler.js'
import * as auditService from './audit.service.js'

export const auditRoutes = Router()

// Both a data principal and several admin tiers read here, with different scopes.
// The scope decision lives in the service (see scopeFilter) — these routes only
// authenticate and pass the actor through, so there is exactly one place where
// "which rows may this actor see" is decided.
auditRoutes.use(requireAnyPrincipal)

const listQuerySchema = z.object({
  entityType: z.string().trim().min(1).max(64).optional(),
  entityId: z.string().uuid().optional(),
  action: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().uuid().optional(),
})

const verifyQuerySchema = z.object({
  entityType: z.string().trim().min(1).max(64),
  entityId: z.string().uuid(),
})

const accessQuerySchema = z.object({
  actorId: z.string().uuid().optional(),
  objectType: z
    .enum([
      'PHOTO', 'REDACTED_PHOTO', 'FACE_CROP', 'ENROLLMENT', 'EMBEDDING',
      'SUBJECT_PII', 'EXPORT', 'DSAR_PACKAGE', 'VAULT_OBJECT', 'AUDIT_LOG',
    ])
    .optional(),
  objectId: z.string().optional(),
  dsarRequestId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().uuid().optional(),
})

function actorOf(req) {
  return { admin: req.admin ?? null, subject: req.subject ?? null }
}

auditRoutes.get('/', async (req, res, next) => {
  try {
    const query = listQuerySchema.parse(req.query)
    const items = await auditService.listAudit(actorOf(req), query)
    // Same "one extra row" contract as the access ledger, so both endpoints page
    // the same way and the portal has one helper rather than two.
    res.json({
      items,
      nextCursor: items.length === query.limit ? items[items.length - 1].id : null,
    })
  } catch (err) {
    next(err)
  }
})

// Verification is an oversight function, not a subject-facing one: the answer is
// about the integrity of the ledger as a whole, and a principal has no way to act
// on it. They get their own entries; the DPO gets the proof.
auditRoutes.get('/verify', async (req, res, next) => {
  try {
    if (!req.admin || !['dpo', 'dataAdmin', 'super_admin'].includes(req.admin.role)) {
      throw new ApiError(403, 'Not authorized to verify the audit chain')
    }
    const { entityType, entityId } = verifyQuerySchema.parse(req.query)
    res.json(await auditService.verifyChain(entityType, entityId))
  } catch (err) {
    next(err)
  }
})

export const accessEventRoutes = Router()

accessEventRoutes.use(requireAnyPrincipal)

accessEventRoutes.get('/', async (req, res, next) => {
  try {
    const query = accessQuerySchema.parse(req.query)
    const { items, nextCursor } = await auditService.getAccessEvents(actorOf(req), query)
    res.json({ items, nextCursor })
  } catch (err) {
    next(err)
  }
})
