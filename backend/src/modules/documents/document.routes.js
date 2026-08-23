import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import { logAccess } from '../../middleware/logAccess.js'
import * as documentService from './document.service.js'
import { mimeFilter, withUploadErrors } from '../../middleware/uploads.js'
import { mediaReadLimiter } from '../../middleware/rateLimiter.js'
import { uploadLimiter } from '../../middleware/rateLimiter.js'

export const documentRoutes = Router({ mergeParams: true })

// This route had NO fileFilter and NO file-count limit — the only upload in the
// system that would accept any content type in any quantity under the size cap.
const upload = withUploadErrors(
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 }, // 10MB text, one at a time
    fileFilter: mimeFilter(['text/', 'application/pdf', 'application/json']),
  }).single('file'),
)

const uuid = z.string().uuid()

const createDocumentSchema = z.object({
  name: z.string().trim().min(1).max(200).default('Untitled Document'),
  textContent: z.string().min(1),
})

const spanItemSchema = z.object({
  subjectId: z.string().uuid().nullable().optional(),
  consentId: z.string().uuid().nullable().optional(),
  startChar: z.number().int().min(0),
  endChar: z.number().int().min(0),
  action: z.enum(['KEEP_NON_PII', 'REDACT_ALL', 'REDACT_PII', 'MANUAL_REDACT', 'MANUAL_UNREDACT']),
  reason: z.string().nullable().optional(),
  piiType: z.string().nullable().optional(),
  textSnippet: z.string().nullable().optional(),
})

const updateSpansSchema = z.object({
  spans: z.array(spanItemSchema),
})

documentRoutes.use(requireAdminAuth)

// Per-route, never a bare `documentRoutes.use(requireRole(...))`: this router
// shares the /api/v1/sessions mount with sessionRoutes and is mounted ahead of
// it, so an unpathed router-level guard would run for every request under that
// prefix — including the photo reads that deliberately admit dataOwner and
// dataAdmin — and 403 them before sessionRoutes ever sees them.
//
// Text is a capture surface like audio: the owning agent writes it, and
// super_admin is admitted for break-glass. Unlike the audio reads there is no
// wider oversight floor here, because a document is raw text — there is no
// metadata-only projection of it that withholds the personal data the way a
// recording's duration does. Matrix §B classifies all eight rows the same way.
const textRoles = requireRole('collectionAgent', 'super_admin')

// 1. Upload or paste document
documentRoutes.post('/:sessionId/documents', textRoles, uploadLimiter, upload, async (req, res, next) => {
  try {
    const sessionId = uuid.parse(req.params.sessionId)
    let name = req.body.name || 'Untitled Document'
    let textContent = req.body.textContent || ''

    if (req.file) {
      name = req.file.originalname || name
      textContent = req.file.buffer.toString('utf-8')
    }

    if (!textContent || !textContent.trim()) {
      return res.status(400).json({ error: 'Text content is required' })
    }

    const doc = await documentService.uploadDocument(
      sessionId,
      { name: name.trim(), textContent },
      req.admin,
    )
    res.status(201).json(doc)
  } catch (err) {
    next(err)
  }
})

// 2. List documents
documentRoutes.get('/:sessionId/documents', textRoles, async (req, res, next) => {
  try {
    const sessionId = uuid.parse(req.params.sessionId)
    const result = await documentService.listDocuments(sessionId, req.admin)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// 3. Get single document with spans
documentRoutes.get('/:sessionId/documents/:documentId', textRoles, async (req, res, next) => {
  try {
    const sessionId = uuid.parse(req.params.sessionId)
    const documentId = uuid.parse(req.params.documentId)
    const doc = await documentService.getDocument(sessionId, documentId, req.admin)
    res.json(doc)
  } catch (err) {
    next(err)
  }
})

// 4. Update spans and tags
documentRoutes.put('/:sessionId/documents/:documentId/spans', textRoles, async (req, res, next) => {
  try {
    const sessionId = uuid.parse(req.params.sessionId)
    const documentId = uuid.parse(req.params.documentId)
    const body = updateSpansSchema.parse(req.body)
    const spans = await documentService.saveSpans(sessionId, documentId, body.spans, req.admin)
    res.json({ spans })
  } catch (err) {
    next(err)
  }
})

// 5. Analyze document for PII
documentRoutes.post('/:sessionId/documents/:documentId/analyze', textRoles, async (req, res, next) => {
  try {
    const sessionId = uuid.parse(req.params.sessionId)
    const documentId = uuid.parse(req.params.documentId)
    const analysis = await documentService.analyzeDocument(sessionId, documentId, req.admin)
    res.json(analysis)
  } catch (err) {
    next(err)
  }
})

// 6. Execute redaction
documentRoutes.post('/:sessionId/documents/:documentId/redact', textRoles, async (req, res, next) => {
  try {
    const sessionId = uuid.parse(req.params.sessionId)
    const documentId = uuid.parse(req.params.documentId)
    const result = await documentService.redactDocument(sessionId, documentId, req.admin)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// 7. Stream raw text (with audit access logging)
documentRoutes.get(
  '/:sessionId/documents/:documentId/raw',
  textRoles,
  mediaReadLimiter,
  logAccess('TEXT_DOCUMENT', (req) => req.params.documentId, { purpose: 'COLLECTION' }),
  async (req, res, next) => {
    try {
      const sessionId = uuid.parse(req.params.sessionId)
      const documentId = uuid.parse(req.params.documentId)
      const { buffer, mimeType } = await documentService.readRawDocument(sessionId, documentId, req.admin)
      res.set('Cache-Control', 'private, no-store')
      res.type(mimeType).send(buffer)
    } catch (err) {
      next(err)
    }
  },
)

// 8. Stream redacted text (with audit access logging)
documentRoutes.get(
  '/:sessionId/documents/:documentId/redacted',
  textRoles,
  mediaReadLimiter,
  logAccess('REDACTED_TEXT_DOCUMENT', (req) => req.params.documentId, { purpose: 'COLLECTION' }),
  async (req, res, next) => {
    try {
      const sessionId = uuid.parse(req.params.sessionId)
      const documentId = uuid.parse(req.params.documentId)
      const { buffer, mimeType } = await documentService.readRedactedDocument(sessionId, documentId)
      res.set('Cache-Control', 'private, no-store')
      res.type(mimeType).send(buffer)
    } catch (err) {
      next(err)
    }
  },
)
