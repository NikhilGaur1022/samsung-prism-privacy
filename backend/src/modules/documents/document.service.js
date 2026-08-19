import { prisma } from '../../config/prisma.js'
import { readFile, writeFile } from '../../lib/storage.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { consentVerdict, isEligible } from '../../lib/consent.js'

const TEXT_SERVICE_URL = process.env.TEXT_SERVICE_URL ?? 'http://localhost:8004'

export class TextUnavailableError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'TextUnavailableError'
    this.cause = cause
  }
}

async function callAnalyze(text) {
  let res
  try {
    res = await fetch(`${TEXT_SERVICE_URL}/api/v1/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, score_threshold: 0.35 }),
    })
  } catch (err) {
    throw new TextUnavailableError('Text worker unreachable while analyzing document', err)
  }
  if (!res.ok) {
    throw new TextUnavailableError(`Text worker returned ${res.status} while analyzing document`)
  }
  return res.json()
}

async function callRedact(text, spans) {
  let res
  try {
    res = await fetch(`${TEXT_SERVICE_URL}/api/v1/redact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, spans, default_action: 'REDACT_ALL' }),
    })
  } catch (err) {
    throw new TextUnavailableError('Text worker unreachable while redacting document', err)
  }
  if (!res.ok) {
    throw new TextUnavailableError(`Text worker returned ${res.status} while redacting document`)
  }
  return res.json()
}

export async function uploadDocument(sessionId, { name, textContent }, admin) {
  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  if (!session) throw Object.assign(new Error('Session not found'), { statusCode: 404 })

  const text = typeof textContent === 'string' ? textContent : textContent.toString('utf-8')
  const charCount = text.length

  const document = await prisma.textDocument.create({
    data: {
      sessionId,
      name: name || 'Untitled Document',
      status: 'PENDING_ANALYSIS',
      storagePath: '',
      charCount,
      mimeType: 'text/plain',
    },
  })

  const relativePath = `sessions/${sessionId}/text/${document.id}.txt`
  await writeFile(relativePath, Buffer.from(text, 'utf-8'))

  const updated = await prisma.textDocument.update({
    where: { id: document.id },
    data: { storagePath: relativePath },
  })

  await writeAuditLog({
    entityType: 'TextDocument',
    entityId: document.id,
    action: 'TEXT_DOCUMENT_UPLOADED',
    actorId: admin.id,
    payload: { sessionId, name: updated.name, charCount },
  })

  return updated
}

export async function listDocuments(sessionId, _admin) {
  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  if (!session) throw Object.assign(new Error('Session not found'), { statusCode: 404 })

  const documents = await prisma.textDocument.findMany({
    where: { sessionId },
    include: {
      _count: { select: { spans: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  return { documents }
}

export async function getDocument(sessionId, documentId, _admin) {
  const document = await prisma.textDocument.findFirst({
    where: { id: documentId, sessionId },
    include: {
      spans: { orderBy: { startChar: 'asc' } },
    },
  })
  if (!document) throw Object.assign(new Error('Document not found'), { statusCode: 404 })
  return document
}

export async function saveSpans(sessionId, documentId, rawSpans, admin) {
  const document = await prisma.textDocument.findFirst({ where: { id: documentId, sessionId } })
  if (!document) throw Object.assign(new Error('Document not found'), { statusCode: 404 })

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { projectId: true },
  })

  const validatedSpans = []
  for (const span of rawSpans) {
    let action = span.action || 'KEEP_NON_PII'
    let reason = span.reason || 'CONSENTED_SUBJECT'
    let consentId = span.consentId || null

    if (span.subjectId) {
      const [subject, consent] = await Promise.all([
        prisma.subject.findUnique({ where: { masterUserId: span.subjectId } }),
        prisma.projectConsent.findUnique({
          where: {
            subjectId_projectId: { subjectId: span.subjectId, projectId: session.projectId },
          },
        }),
      ])

      if (subject && isEligible(consentVerdict(subject, consent))) {
        action = span.action === 'MANUAL_REDACT' ? 'MANUAL_REDACT' : 'KEEP_NON_PII'
        reason = span.reason || 'CONSENTED_SUBJECT'
        consentId = consent?.consentId ?? null
      } else {
        action = 'REDACT_ALL'
        reason = 'UNCONSENTED_SUBJECT'
        consentId = consent?.consentId ?? null
      }
    } else if (span.action === 'MANUAL_REDACT') {
      action = 'MANUAL_REDACT'
      reason = span.reason || 'AGENT_MANUAL_REDACTION'
    } else if (span.action === 'MANUAL_UNREDACT') {
      action = 'MANUAL_UNREDACT'
      reason = 'AGENT_MANUAL_UNREDACT'
    } else {
      action = 'REDACT_ALL'
      reason = 'UNTAGGED_TEXT'
    }

    validatedSpans.push({
      documentId,
      subjectId: span.subjectId || null,
      consentId,
      startChar: Math.max(0, span.startChar),
      endChar: Math.max(span.startChar, span.endChar),
      action,
      reason,
      piiType: span.piiType || null,
      textSnippet: span.textSnippet || null,
    })
  }

  await prisma.$transaction([
    prisma.textSpan.deleteMany({ where: { documentId } }),
    prisma.textSpan.createMany({ data: validatedSpans }),
    prisma.textDocument.update({ where: { id: documentId }, data: { status: 'TAGGED' } }),
  ])

  await writeAuditLog({
    entityType: 'TextDocument',
    entityId: documentId,
    action: 'TEXT_SPANS_UPDATED',
    actorId: admin.id,
    payload: { spanCount: validatedSpans.length },
  })

  return prisma.textSpan.findMany({
    where: { documentId },
    orderBy: { startChar: 'asc' },
  })
}

export async function analyzeDocument(sessionId, documentId, admin) {
  const document = await prisma.textDocument.findFirst({ where: { id: documentId, sessionId } })
  if (!document) throw Object.assign(new Error('Document not found'), { statusCode: 404 })

  const rawBuffer = await readFile(document.storagePath)
  const text = rawBuffer.toString('utf-8')

  let analysis
  try {
    analysis = await callAnalyze(text)
  } catch (err) {
    await prisma.textDocument.update({ where: { id: documentId }, data: { status: 'DEFERRED' } })
    await writeAuditLog({
      entityType: 'TextDocument',
      entityId: documentId,
      action: 'TEXT_ANALYSIS_FAILED',
      actorId: admin.id,
      payload: { error: err.message },
    })
    throw err
  }

  await writeAuditLog({
    entityType: 'TextDocument',
    entityId: documentId,
    action: 'TEXT_DOCUMENT_ANALYZED',
    actorId: admin.id,
    payload: { entityCount: analysis.entities.length, charCount: analysis.charCount },
  })

  return analysis
}

export async function redactDocument(sessionId, documentId, admin) {
  const document = await prisma.textDocument.findFirst({
    where: { id: documentId, sessionId },
    include: { spans: true },
  })
  if (!document) throw Object.assign(new Error('Document not found'), { statusCode: 404 })

  const rawBuffer = await readFile(document.storagePath)
  const text = rawBuffer.toString('utf-8')

  const spanPayload = document.spans.map((s) => ({
    start: s.startChar,
    end: s.endChar,
    action: s.action,
    reason: s.reason,
    subject_id: s.subjectId,
    consent_id: s.consentId,
    pii_type: s.piiType,
  }))

  const redactResult = await callRedact(text, spanPayload)
  const redactedRelativePath = `sessions/${sessionId}/text/${documentId}.redacted.txt`
  await writeFile(redactedRelativePath, Buffer.from(redactResult.redacted_text, 'utf-8'))

  const updated = await prisma.textDocument.update({
    where: { id: documentId },
    data: {
      status: 'REDACTED',
      redactedPath: redactedRelativePath,
    },
    include: { spans: true },
  })

  await writeAuditLog({
    entityType: 'TextDocument',
    entityId: documentId,
    action: 'TEXT_DOCUMENT_REDACTED',
    actorId: admin.id,
    payload: {
      redactedIntervalsCount: redactResult.redacted_intervals.length,
      redactedCharCount: redactResult.redacted_text.length,
    },
  })

  return {
    document: updated,
    redactedText: redactResult.redacted_text,
    redactedIntervals: redactResult.redacted_intervals,
  }
}

export async function readRawDocument(sessionId, documentId, admin) {
  const document = await prisma.textDocument.findFirst({ where: { id: documentId, sessionId } })
  if (!document) throw Object.assign(new Error('Document not found'), { statusCode: 404 })

  const buffer = await readFile(document.storagePath)
  return {
    buffer,
    text: buffer.toString('utf-8'),
    mimeType: document.mimeType || 'text/plain',
  }
}

export async function readRedactedDocument(sessionId, documentId) {
  const document = await prisma.textDocument.findFirst({ where: { id: documentId, sessionId } })
  if (!document || !document.redactedPath) {
    throw Object.assign(new Error('Redacted document not found'), { statusCode: 404 })
  }

  const buffer = await readFile(document.redactedPath)
  return {
    buffer,
    text: buffer.toString('utf-8'),
    mimeType: document.mimeType || 'text/plain',
  }
}
