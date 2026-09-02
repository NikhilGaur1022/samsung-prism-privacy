import { Router } from 'express'
import { z } from 'zod'
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js'
import { requireAnyPrincipal } from '../../middleware/requireAnyPrincipal.js'
import { requireRole } from '../../middleware/requireRole.js'
import * as templateService from './consentTemplate.service.js'
import { SUPPORTED_LOCALES } from './consentTemplate.service.js'
import { dataTypeArraySchema } from '../../lib/dataTypeSchema.js'

export const consentTemplateRoutes = Router()

const idSchema = z.string().uuid()
const localeSchema = z.enum(SUPPORTED_LOCALES).default('en')

const createSchema = z.object({
  name: z.string().trim().min(3).max(160),
  purpose: z.string().trim().min(20).max(2000),
  bodyByLocale: z.record(z.string(), z.string()),
  // Was `z.array(z.string().trim().min(1))` — any word at all. A §5 notice's data
  // categories are the part a principal reads to decide, and the subset check
  // that gates project approval compares them by exact string, so free text made
  // "Face" and "face" two different categories.
  dataTypes: dataTypeArraySchema.optional(),
  retention: z.string().trim().min(1).max(120).optional(),
  grievanceContact: z.string().trim().min(3).max(320).optional(),
  supersedesId: idSchema.optional(),
})

const updateSchema = createSchema.partial().omit({ name: true, supersedesId: true })

// Rendering is the one action a data principal performs here, and they must be
// able to do it before signing. Everything else is admin-only.
consentTemplateRoutes.get('/:templateId/render', requireAnyPrincipal, async (req, res, next) => {
  try {
    const templateId = idSchema.parse(req.params.templateId)
    const locale = localeSchema.parse(req.query.locale ?? 'en')
    res.json(await templateService.renderNotice(templateId, locale))
  } catch (err) {
    next(err)
  }
})

consentTemplateRoutes.use(requireAdminAuth)

// Matrix §B Governance: dpo authors, dataOwner and collectionAgent read so they
// can see what they are collecting under. dataAdmin has no business here.
const CAN_READ = ['dpo', 'dataOwner', 'collectionAgent', 'super_admin']
const CAN_WRITE = ['dpo', 'super_admin']

consentTemplateRoutes.get('/', requireRole(...CAN_READ), async (req, res, next) => {
  try {
    const status = z.enum(['DRAFT', 'PUBLISHED', 'SUPERSEDED']).optional().parse(req.query.status)
    res.json({ items: await templateService.listTemplates({ status }) })
  } catch (err) {
    next(err)
  }
})

consentTemplateRoutes.get('/:templateId', requireRole(...CAN_READ), async (req, res, next) => {
  try {
    res.json(await templateService.getTemplate(idSchema.parse(req.params.templateId)))
  } catch (err) {
    next(err)
  }
})

consentTemplateRoutes.post('/', requireRole(...CAN_WRITE), async (req, res, next) => {
  try {
    const input = createSchema.parse(req.body)
    res.status(201).json(await templateService.createTemplate(input, req.admin))
  } catch (err) {
    next(err)
  }
})

consentTemplateRoutes.patch('/:templateId', requireRole(...CAN_WRITE), async (req, res, next) => {
  try {
    const templateId = idSchema.parse(req.params.templateId)
    const input = updateSchema.parse(req.body)
    res.json(await templateService.updateDraft(templateId, input, req.admin))
  } catch (err) {
    next(err)
  }
})

consentTemplateRoutes.post('/:templateId/publish', requireRole(...CAN_WRITE), async (req, res, next) => {
  try {
    const templateId = idSchema.parse(req.params.templateId)
    res.json(await templateService.publishTemplate(templateId, req.admin))
  } catch (err) {
    next(err)
  }
})
