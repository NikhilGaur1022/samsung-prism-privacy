import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { consentVerdict } from '../../lib/consent.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { getTemplate } from '../consentTemplates/consentTemplate.service.js'
import { countBlockedFrames } from '../../lib/photoState.js'

// A project is the unit of purpose limitation (DPDP §6(1)): nothing may be
// collected until a DPO has read the purpose, the data types and the retention
// and approved that specific combination. The status machine is the enforcement:
//
//   DRAFT ──submit──> SUBMITTED ──approve──> APPROVED ──close──> CLOSED
//     ^                    │
//     └──── reject ────────┘  (REJECTED, editable again)
//
// ACTIVE is legacy — projects created before the approval workflow existed. It is
// deliberately NOT treated as approved anywhere; those rows must go through the
// DPO like everything else.
const EDITABLE_STATUSES = ['DRAFT', 'REJECTED']

// dataOwner acts only on projects it owns. super_admin is not exempt from the
// check being *written* — it is exempt from failing it, and that is audited.
async function assertOwned(projectId, admin) {
  const project = await prisma.project.findUnique({ where: { id: projectId } })
  if (!project) throw new ApiError(404, 'Project not found')
  if (admin.role === 'super_admin') return project
  if (admin.role !== 'dataOwner') throw new ApiError(403, 'Not authorized for this action')
  if (project.ownerAdminId !== admin.id) throw new ApiError(403, 'You do not own this project')
  return project
}

// Every agent-facing read funnels through this. An agent sees only the projects
// they're assigned to — asking for any other project is a 403, not an empty list,
// so a guessed UUID can't be probed for existence.
export async function assertAssigned(projectId, admin) {
  const project = await prisma.project.findUnique({ where: { id: projectId } })
  if (!project) throw new ApiError(404, 'Project not found')

  if (admin.role === 'collectionAgent') {
    const assignment = await prisma.projectAssignment.findUnique({
      where: { projectId_adminId: { projectId, adminId: admin.id } },
    })
    if (!assignment) throw new ApiError(403, 'You are not assigned to this project')
  }

  // A data owner is scoped to the projects they own here too, not only in
  // assertOwned/assertOversight. Without this line the two routes that reach the
  // project through this helper — GET /projects/:projectId and
  // GET /projects/:projectId/assignments — answered 200 for any owner's project,
  // leaking its purpose, policy version, retention and risk level, and the email,
  // role and status of every collection agent assigned to it. Every OTHER project
  // route already enforced ownership, so this was a horizontal hole in an
  // otherwise consistent surface, and the RBAC matrix could not see it: it tests
  // the role floor with synthetic UUIDs and never asks whether one owner can read
  // another owner's row.
  if (admin.role === 'dataOwner' && project.ownerAdminId !== admin.id) {
    throw new ApiError(403, 'You do not own this project')
  }

  return project
}

export async function listAssignedProjects(admin) {
  // Scope per matrix §B: an agent sees assigned + APPROVED (an unapproved project
  // has no lawful basis to collect under, so showing it invites a session attempt
  // that must fail); an owner sees its own at any status; dpo/dataAdmin see all as
  // metadata for oversight.
  const where =
    admin.role === 'collectionAgent'
      ? { status: 'APPROVED', assignments: { some: { adminId: admin.id } } }
      : admin.role === 'dataOwner'
        ? { ownerAdminId: admin.id }
        : { status: { not: 'CLOSED' } }

  const projects = await prisma.project.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { sessions: true, consents: true } },
    },
  })

  return projects.map(({ _count, ...project }) => ({
    ...project,
    sessionCount: _count.sessions,
    consentCount: _count.consents,
  }))
}

// Search returns non-consented people too, with a verdict — the UI shows them
// greyed out with the reason rather than hiding them, so the agent knows the
// person exists and why they can't be added.
export async function searchProjectSubjects(projectId, admin, { q, limit }) {
  // This returns names and emails. Matrix §D withholds subject identity from dpo
  // and dataOwner outright, so the scope assertion lives here rather than only in
  // requireRole — a future route reusing this function inherits the restriction.
  if (!['collectionAgent', 'super_admin'].includes(admin.role)) {
    throw new ApiError(403, 'This role may not read subject identity')
  }
  await assertAssigned(projectId, admin)

  const subjects = await prisma.subject.findMany({
    where: q
      ? {
          OR: [
            { fullName: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
            { employeeRef: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {},
    orderBy: { fullName: 'asc' },
    take: limit,
    include: { projectConsents: { where: { projectId } } },
  })

  return subjects.map(({ projectConsents, ...subject }) => {
    const consent = projectConsents[0] ?? null
    return {
      masterUserId: subject.masterUserId,
      fullName: subject.fullName,
      email: subject.email,
      group: subject.group,
      status: subject.status,
      employeeRef: subject.employeeRef,
      consentId: consent?.consentId ?? null,
      consentedAt: consent?.consentedAt ?? null,
      verdict: consentVerdict(subject, consent),
    }
  })
}

// ---------------------------------------------------------------------------
// Governance lifecycle
// ---------------------------------------------------------------------------

export async function createProject(input, admin) {
  const project = await prisma.project.create({
    data: {
      name: input.name,
      purpose: input.purpose,
      retention: input.retention ?? null,
      dataTypes: input.dataTypes ?? null,
      riskLevel: input.riskLevel ?? null,
      consentTemplateId: input.consentTemplateId ?? null,
      ownerAdminId: admin.role === 'dataOwner' ? admin.id : (input.ownerAdminId ?? admin.id),
      status: 'DRAFT',
    },
  })

  await writeAuditLog({
    entityType: 'Project',
    entityId: project.id,
    action: 'PROJECT_CREATED',
    actorId: admin.id,
    payload: { name: project.name, ownerAdminId: project.ownerAdminId },
  })

  return project
}

export async function updateDraft(projectId, input, admin) {
  const existing = await assertOwned(projectId, admin)
  if (!EDITABLE_STATUSES.includes(existing.status)) {
    throw new ApiError(409, `Project is ${existing.status} — only a DRAFT or REJECTED project can be edited`)
  }

  const project = await prisma.project.update({
    where: { id: projectId },
    data: {
      name: input.name ?? undefined,
      purpose: input.purpose ?? undefined,
      retention: input.retention ?? undefined,
      dataTypes: input.dataTypes ?? undefined,
      riskLevel: input.riskLevel ?? undefined,
      consentTemplateId: input.consentTemplateId ?? undefined,
      // Editing after a rejection returns the project to DRAFT: the rejection
      // reason stays on the row as history, but the project is no longer "the
      // thing the DPO rejected".
      status: existing.status === 'REJECTED' ? 'DRAFT' : undefined,
    },
  })

  await writeAuditLog({
    entityType: 'Project',
    entityId: projectId,
    action: 'PROJECT_UPDATED',
    actorId: admin.id,
    payload: { fields: Object.keys(input) },
  })

  return project
}

// The completeness gate. Everything checked here is something the DPO would
// otherwise have to chase by email, and something §5 requires the notice to state.
export async function submitForApproval(projectId, admin) {
  const existing = await assertOwned(projectId, admin)
  if (!EDITABLE_STATUSES.includes(existing.status)) {
    throw new ApiError(409, `Project is ${existing.status} — nothing to submit`)
  }

  const missing = []
  if (!existing.purpose || existing.purpose.trim().length < 20) missing.push('purpose')
  if (!existing.retention) missing.push('retention')
  if (!Array.isArray(existing.dataTypes) || existing.dataTypes.length === 0) missing.push('dataTypes')
  if (!existing.consentTemplateId) missing.push('consentTemplateId')
  if (missing.length) {
    throw new ApiError(400, `Cannot submit — missing or incomplete: ${missing.join(', ')}`)
  }

  const template = await getTemplate(existing.consentTemplateId)
  if (template.status !== 'PUBLISHED') {
    throw new ApiError(400, `Consent template "${template.name}" is ${template.status} — bind a PUBLISHED notice`)
  }

  // Purpose limitation, checked mechanically: a project may not collect a data
  // type its own notice does not disclose. Without this the notice and the
  // collection drift apart and §5 is satisfied only on paper.
  const declared = Array.isArray(template.dataTypes) ? template.dataTypes : null
  if (declared) {
    const undisclosed = existing.dataTypes.filter((t) => !declared.includes(t))
    if (undisclosed.length) {
      throw new ApiError(400, `Data types not disclosed by the bound notice: ${undisclosed.join(', ')}`)
    }
  }

  const project = await prisma.project.update({
    where: { id: projectId },
    data: { status: 'SUBMITTED', submittedAt: new Date(), rejectionReason: null },
  })

  await writeAuditLog({
    entityType: 'Project',
    entityId: projectId,
    action: 'PROJECT_SUBMITTED',
    actorId: admin.id,
    payload: { consentTemplateId: existing.consentTemplateId, dataTypes: existing.dataTypes },
  })

  return project
}

export async function approveProject(projectId, admin) {
  const existing = await prisma.project.findUnique({ where: { id: projectId } })
  if (!existing) throw new ApiError(404, 'Project not found')
  if (existing.status !== 'SUBMITTED') {
    throw new ApiError(409, `Project is ${existing.status} — only a SUBMITTED project can be approved`)
  }
  if (!['dpo', 'super_admin'].includes(admin.role)) {
    throw new ApiError(403, 'Only the DPO may approve a collection purpose')
  }
  // Self-approval would make the gate ornamental.
  if (existing.ownerAdminId === admin.id) {
    throw new ApiError(403, 'A project may not be approved by its own owner')
  }

  const template = await getTemplate(existing.consentTemplateId)

  // Freezing policyVersion is what makes every ProjectConsent row afterwards
  // point at a specific, immutable notice text. It is set once, at approval, and
  // never edited — a later notice revision is a new template and a new approval.
  const policyVersion = `${template.name} v${template.version}`

  const project = await prisma.project.update({
    where: { id: projectId },
    data: {
      status: 'APPROVED',
      approvedAt: new Date(),
      approvedByAdminId: admin.id,
      rejectionReason: null,
      policyVersion,
    },
  })

  await writeAuditLog({
    entityType: 'Project',
    entityId: projectId,
    action: 'PROJECT_APPROVED',
    actorId: admin.id,
    payload: { policyVersion, consentTemplateId: existing.consentTemplateId },
  })

  return project
}

export async function rejectProject(projectId, reason, admin) {
  const existing = await prisma.project.findUnique({ where: { id: projectId } })
  if (!existing) throw new ApiError(404, 'Project not found')
  if (existing.status !== 'SUBMITTED') {
    throw new ApiError(409, `Project is ${existing.status} — only a SUBMITTED project can be rejected`)
  }
  if (!['dpo', 'super_admin'].includes(admin.role)) {
    throw new ApiError(403, 'Only the DPO may reject a collection purpose')
  }

  const project = await prisma.project.update({
    where: { id: projectId },
    data: { status: 'REJECTED', rejectionReason: reason },
  })

  await writeAuditLog({
    entityType: 'Project',
    entityId: projectId,
    action: 'PROJECT_REJECTED',
    actorId: admin.id,
    payload: { reason },
  })

  return project
}

export async function closeProject(projectId, admin) {
  const existing = await assertOwned(projectId, admin)
  if (existing.status === 'CLOSED') return existing

  const project = await prisma.project.update({
    where: { id: projectId },
    data: { status: 'CLOSED' },
  })

  await writeAuditLog({
    entityType: 'Project',
    entityId: projectId,
    action: 'PROJECT_CLOSED',
    actorId: admin.id,
    payload: { previousStatus: existing.status },
  })

  return project
}

export async function listAssignments(projectId, admin) {
  await assertAssigned(projectId, admin)
  return prisma.projectAssignment.findMany({
    where: { projectId },
    orderBy: { assignedAt: 'desc' },
    select: {
      id: true,
      assignedAt: true,
      admin: { select: { id: true, email: true, role: true, status: true } },
    },
  })
}

export async function assignAgent(projectId, adminId, admin) {
  const project = await assertOwned(projectId, admin)
  if (project.status !== 'APPROVED') {
    throw new ApiError(409, 'Agents may only be assigned to an APPROVED project')
  }

  const agent = await prisma.adminUser.findUnique({ where: { id: adminId } })
  if (!agent) throw new ApiError(404, 'Admin user not found')
  if (agent.role !== 'collectionAgent') {
    throw new ApiError(400, `Only a collectionAgent can be assigned to collect; that admin is ${agent.role}`)
  }
  if (agent.status !== 'ACTIVE') {
    throw new ApiError(400, `That admin is ${agent.status} — only an ACTIVE admin can be assigned`)
  }

  const assignment = await prisma.projectAssignment.upsert({
    where: { projectId_adminId: { projectId, adminId } },
    create: { projectId, adminId },
    update: {},
  })

  await writeAuditLog({
    entityType: 'Project',
    entityId: projectId,
    action: 'AGENT_ASSIGNED',
    actorId: admin.id,
    payload: { adminId },
  })

  return assignment
}

export async function unassignAgent(projectId, adminId, admin) {
  await assertOwned(projectId, admin)

  // Sessions the agent already ran stay theirs — unassigning revokes future
  // access, it does not rewrite who collected what.
  const { count } = await prisma.projectAssignment.deleteMany({ where: { projectId, adminId } })
  if (count === 0) throw new ApiError(404, 'That admin is not assigned to this project')

  await writeAuditLog({
    entityType: 'Project',
    entityId: projectId,
    action: 'AGENT_UNASSIGNED',
    actorId: admin.id,
    payload: { adminId },
  })

  return { unassigned: true }
}

// Session creation calls this instead of re-deriving the rule, so "may we collect
// under this project" has exactly one answer in the codebase.
export async function assertCollectable(projectId, admin) {
  const project = await assertAssigned(projectId, admin)
  if (project.status !== 'APPROVED') {
    throw new ApiError(403, 'PROJECT_NOT_APPROVED')
  }
  if (!project.consentTemplateId) {
    throw new ApiError(403, 'PROJECT_HAS_NO_NOTICE')
  }
  return project
}

// ---------------------------------------------------------------------------
// Project-scoped oversight reads (matrix §D)
// ---------------------------------------------------------------------------
// A data owner is accountable for what their project collected but had no route
// that could tell them: /sessions and /handoffs are collectionAgent- and
// dataAdmin-only, so ProcessedData and ProjectReports had nothing to render.
// These three reads close that without widening either of those surfaces —
// they are project-scoped, aggregate, and return no subject identity at all.

export async function assertOversight(projectId, admin) {
  const project = await prisma.project.findUnique({ where: { id: projectId } })
  if (!project) throw new ApiError(404, 'Project not found')
  if (admin.role === 'dataOwner' && project.ownerAdminId !== admin.id) {
    throw new ApiError(403, 'You do not own this project')
  }
  if (!['dataOwner', 'dpo', 'dataAdmin', 'super_admin'].includes(admin.role)) {
    throw new ApiError(403, 'Not authorized to read this project')
  }
  return project
}

export async function listProjectSessions(projectId, admin) {
  await assertOversight(projectId, admin)

  const sessions = await prisma.session.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      code: true,
      // Without the type these screens describe every session as a pile of
      // photos, so an audio, video or text session reads as an empty one.
      type: true,
      status: true,
      location: true,
      createdAt: true,
      endedAt: true,
      archivedAt: true,
      handoff: { select: { id: true, status: true, ingestedAt: true } },
      // Counts only. Naming a participant here would hand subject identity to
      // dpo and dataOwner through the back door matrix §D closes at
      // /projects/:id/subjects.
      _count: {
        select: {
          photos: true,
          recordings: true,
          videos: true,
          documents: true,
          participants: true,
        },
      },
    },
  })

  // Redaction/PII state is what a data owner actually needs from this screen:
  // a DEFERRED frame is one that cannot be handed off, and it is invisible from
  // a session status alone.
  const pii = await prisma.photo.groupBy({
    by: ['sessionId', 'piiStatus'],
    where: { session: { projectId } },
    _count: { _all: true },
  })

  const piiBySession = new Map()
  for (const row of pii) {
    const bucket = piiBySession.get(row.sessionId) ?? {}
    bucket[row.piiStatus] = row._count._all
    piiBySession.set(row.sessionId, bucket)
  }

  return {
    items: sessions.map(({ _count, handoff, ...s }) => ({
      ...s,
      photoCount: _count.photos,
      recordingCount: _count.recordings,
      videoCount: _count.videos,
      documentCount: _count.documents,
      // What this session actually collected, so a caller can say "1 recording"
      // without re-deriving it from the type. A video session holds its clips
      // in videos, not photos, which is why IMAGE and VIDEO differ here.
      itemCount: itemCountFor(s.type, _count),
      participantCount: _count.participants,
      handoff,
      piiStatusCounts: piiBySession.get(s.id) ?? {},
    })),
  }
}

// The count that means something for a given session type. Falls back to the
// sum rather than to zero: an unknown future type showing every item it holds
// is a better failure than one reporting itself empty.
function itemCountFor(type, counts) {
  switch (type) {
    case 'IMAGE':
      // An IMAGE session is the visual-capture session: there is no VIDEO
      // member of SessionType, so clips hang off this type too and a
      // video-only session would otherwise report itself as holding nothing.
      return counts.photos + counts.videos
    case 'VIDEO':
      return counts.videos
    case 'AUDIO':
      return counts.recordings
    case 'TEXT':
      return counts.documents
    default:
      return counts.photos + counts.videos + counts.recordings + counts.documents
  }
}

export async function listProjectHandoffs(projectId, admin) {
  await assertOversight(projectId, admin)

  const handoffs = await prisma.sessionHandoff.findMany({
    where: { projectId },
    orderBy: { emittedAt: 'desc' },
    select: {
      id: true,
      sessionId: true,
      status: true,
      photoCount: true,
      subjectCount: true,
      linkCount: true,
      emittedAt: true,
      ingestedAt: true,
      session: { select: { code: true, location: true } },
    },
  })

  return {
    items: handoffs.map(({ session, ...h }) => ({
      ...h,
      sessionCode: session.code,
      location: session.location,
    })),
  }
}

// The report behind ProjectReports.jsx and the DPO's per-project view. Every
// figure is counted here rather than assembled in the browser, so the number on
// the screen is the number in the database.
export async function getProjectReport(projectId, admin) {
  const project = await assertOversight(projectId, admin)

  const [
    consentsActive,
    consentsRevoked,
    sessionsByStatus,
    photoTotal,
    photoByPii,
    linkTotal,
    handoffsByStatus,
    dsarByStatus,
    erasedLinks,
  ] = await Promise.all([
    prisma.projectConsent.count({ where: { projectId, status: 'ACTIVE' } }),
    prisma.projectConsent.count({ where: { projectId, status: { not: 'ACTIVE' } } }),
    prisma.session.groupBy({ by: ['status'], where: { projectId }, _count: { _all: true } }),
    prisma.photo.count({ where: { session: { projectId } } }),
    prisma.photo.groupBy({
      by: ['piiStatus'],
      where: { session: { projectId } },
      _count: { _all: true },
    }),
    prisma.photoSubject.count({ where: { photo: { session: { projectId } } } }),
    prisma.sessionHandoff.groupBy({ by: ['status'], where: { projectId }, _count: { _all: true } }),
    prisma.dsarRequest.groupBy({ by: ['status'], where: { projectId }, _count: { _all: true } }),
    // Links destroyed by an erasure are not recoverable from PhotoSubject — the
    // row is gone by design. The certificate count is the honest proxy.
    prisma.deletionCertificate.count({ where: { request: { projectId } } }),
  ])

  const tally = (rows, key) =>
    Object.fromEntries(rows.map((r) => [r[key], r._count._all]))

  const piiCounts = tally(photoByPii, 'piiStatus')

  return {
    project: {
      id: project.id,
      name: project.name,
      purpose: project.purpose,
      status: project.status,
      retention: project.retention,
      dataTypes: project.dataTypes,
      riskLevel: project.riskLevel,
      approvedAt: project.approvedAt,
      consentTemplateId: project.consentTemplateId,
    },
    consent: { active: consentsActive, withdrawn: consentsRevoked },
    collection: {
      sessions: tally(sessionsByStatus, 'status'),
      photos: photoTotal,
      photoSubjectLinks: linkTotal,
      piiStatus: piiCounts,
      // The single number that decides whether this project can hand anything
      // off. Non-zero means redaction did not confirm on that many frames.
      // Every non-terminal state, not just the two loudest. PENDING is the
      // schema default and the state an un-run redaction leaves behind, so
      // omitting it reported zero blocked frames on a project that could not
      // hand off a single one of them. Counted by inversion for that reason.
      blockedFrames: countBlockedFrames(piiCounts),
    },
    handoffs: tally(handoffsByStatus, 'status'),
    dsar: { byStatus: tally(dsarByStatus, 'status'), certificatesIssued: erasedLinks },
    generatedAt: new Date().toISOString(),
  }
}
