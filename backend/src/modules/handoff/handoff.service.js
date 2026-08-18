import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { writeAuditLog } from '../../lib/auditLog.js'

export async function listHandoffs({ status }) {
  const handoffs = await prisma.sessionHandoff.findMany({
    where: { ...(status && { status }) },
    orderBy: { emittedAt: 'desc' },
    include: {
      session: {
        select: { code: true, location: true, archivedAt: true, project: { select: { id: true, name: true } } },
      },
    },
  })

  return {
    items: handoffs.map((h) => ({
      id: h.id,
      sessionId: h.sessionId,
      sessionCode: h.session.code,
      projectId: h.projectId,
      projectName: h.session.project.name,
      location: h.session.location,
      status: h.status,
      photoCount: h.photoCount,
      subjectCount: h.subjectCount,
      linkCount: h.linkCount,
      emittedAt: h.emittedAt,
      ingestedAt: h.ingestedAt,
    })),
  }
}

// The consent-mapped batch: exactly the view the Consent Mapping Engine consumes.
// Every row is a photo→subject link that already carries the consent permitting it.
export async function getHandoff(handoffId) {
  const handoff = await prisma.sessionHandoff.findUnique({
    where: { id: handoffId },
    include: { session: { select: { code: true, project: { select: { id: true, name: true } } } } },
  })
  if (!handoff) throw new ApiError(404, 'Handoff not found')

  const links = await prisma.photoSubject.findMany({
    where: { photo: { sessionId: handoff.sessionId } },
    include: {
      photo: { select: { id: true, storagePath: true, redactedPath: true, sha256: true } },
      subject: { select: { masterUserId: true, fullName: true, email: true, group: true } },
      consent: { select: { consentId: true, status: true, policyVersion: true, consentedAt: true, projectId: true } },
    },
  })

  return {
    id: handoff.id,
    sessionId: handoff.sessionId,
    sessionCode: handoff.session.code,
    projectId: handoff.projectId,
    projectName: handoff.session.project.name,
    status: handoff.status,
    emittedAt: handoff.emittedAt,
    ingestedAt: handoff.ingestedAt,
    links: links.map((l) => ({
      photoId: l.photoId,
      sha256: l.photo.sha256,
      hasRedacted: Boolean(l.photo.redactedPath),
      subjectId: l.subjectId,
      subjectName: l.subject.fullName,
      subjectEmail: l.subject.email,
      subjectGroup: l.subject.group,
      consentId: l.consentId,
      consentStatus: l.consent.status,
      policyVersion: l.consent.policyVersion,
      consentedAt: l.consent.consentedAt,
      projectId: l.consent.projectId,
    })),
  }
}

export async function ingestHandoff(handoffId, admin) {
  const handoff = await prisma.sessionHandoff.findUnique({ where: { id: handoffId } })
  if (!handoff) throw new ApiError(404, 'Handoff not found')
  if (handoff.status !== 'PENDING_INGEST') {
    throw new ApiError(409, `Handoff is already ${handoff.status}`)
  }

  // Fail closed (invariant 8). A batch containing a photo whose PII masking was
  // never confirmed must not reach the golden store — once ingested it is copied,
  // indexed and exported, and an unmasked Aadhaar in the vault is a §8(5) breach
  // that no later fix can undo. The redaction retry worker clears these.
  const unmasked = await prisma.photo.count({
    where: {
      sessionId: handoff.sessionId,
      OR: [{ piiStatus: 'DEFERRED' }, { piiStatus: 'FAILED' }, { redactedPath: null }],
    },
  })
  if (unmasked > 0) {
    throw new ApiError(
      409,
      `REDACTION_INCOMPLETE — ${unmasked} photo(s) in this batch have no confirmed mask. Ingest is blocked until the redaction queue clears them.`,
    )
  }

  // The same gate for audio, which this check ignored entirely — a Recording
  // still DEFERRED or with no muted derivative did not block a handoff, so an
  // unmasked VOICE could leave the platform inside a dataset while an unmasked
  // face could not. A voice is §2 sensitive personal data on the same footing.
  //
  // Stated as "not confirmably clear" rather than as a list of bad statuses:
  // the clear case is exactly isRecordingRedactedAvailable's (REDACTED with a
  // derivative on disk), and a status added later must default to blocking.
  // DEFERRED specifically means the worker was unreachable, which schema.prisma
  // is explicit is NOT the same as clean.
  const unmuted = await prisma.recording.count({
    where: {
      sessionId: handoff.sessionId,
      NOT: { AND: [{ status: 'REDACTED' }, { redactedPath: { not: null } }] },
    },
  })
  if (unmuted > 0) {
    throw new ApiError(
      409,
      `REDACTION_INCOMPLETE — ${unmuted} recording(s) in this batch have no confirmed muted copy. Ingest is blocked until the audio redaction completes.`,
    )
  }

  const updated = await prisma.sessionHandoff.update({
    where: { id: handoffId },
    data: { status: 'INGESTED', ingestedAt: new Date() },
  })

  await writeAuditLog({
    entityType: 'Session',
    entityId: handoff.sessionId,
    action: 'HANDOFF_INGESTED',
    actorId: admin.id,
    payload: { handoffId, linkCount: handoff.linkCount },
  })

  return updated
}

// Lineage rows for the data-admin view: photo → subject → consent → project.
// This chain is exactly what a DSAR erasure walks, so rendering it is the evidence.
export async function getLineage({ projectId, subjectId, limit = 200 }) {
  const links = await prisma.photoSubject.findMany({
    where: {
      ...(subjectId && { subjectId }),
      ...(projectId && { consent: { projectId } }),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      photo: { select: { id: true, sha256: true, redactedPath: true, session: { select: { id: true, code: true } } } },
      subject: { select: { masterUserId: true, fullName: true, email: true } },
      consent: { select: { consentId: true, status: true, policyVersion: true, project: { select: { id: true, name: true } } } },
    },
  })

  return {
    items: links.map((l) => ({
      id: l.id,
      photoId: l.photoId,
      sha256: l.photo.sha256,
      hasRedacted: Boolean(l.photo.redactedPath),
      sessionId: l.photo.session.id,
      sessionCode: l.photo.session.code,
      subjectId: l.subjectId,
      subjectName: l.subject.fullName,
      subjectEmail: l.subject.email,
      consentId: l.consentId,
      consentStatus: l.consent.status,
      policyVersion: l.consent.policyVersion,
      projectId: l.consent.project.id,
      projectName: l.consent.project.name,
      createdAt: l.createdAt,
    })),
  }
}
