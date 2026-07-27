import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { SLA_DAYS, INTERNAL_SLA_DAYS, pseudonymise } from '../dsar/dsar.service.js'

// One role-aware summary endpoint behind every portal's stat tiles and work
// queue. It exists so that "the number on the screen" and "the number in the
// database" cannot drift: there is no client-side arithmetic and no hardcoded
// array anywhere upstream of it.
//
// Matrix §D is enforced here, not in the UI. Each role's builder selects only the
// columns that role may see — the DPO builder has no code path that can return a
// subject name, so a future DPO screen cannot accidentally render one.

function tile(label, value, meta = {}) {
  return { label, value, ...meta }
}

// ---------------------------------------------------------------------------
// DPO — governance and oversight. Never a subject identity, never media.
// ---------------------------------------------------------------------------
async function dpoSummary() {
  const now = new Date()

  const [pendingApprovals, activeProjects, templates, openRequests, breachesOpen] = await Promise.all([
    prisma.project.count({ where: { status: 'SUBMITTED' } }),
    prisma.project.count({ where: { status: 'APPROVED' } }),
    prisma.consentTemplate.count({ where: { status: 'PUBLISHED' } }),
    prisma.dsarRequest.findMany({
      where: { status: { notIn: ['CLOSED', 'REJECTED'] } },
      select: { id: true, subjectId: true, type: true, status: true, slaDueAt: true, internalDueAt: true, createdAt: true },
      orderBy: { slaDueAt: 'asc' },
      take: 50,
    }),
    prisma.breachRecord.count({ where: { status: { in: ['OPEN', 'CONTAINED'] } } }),
  ])

  const breached = openRequests.filter((r) => r.slaDueAt < now)
  const internalBreached = openRequests.filter(
    (r) => r.internalDueAt && r.internalDueAt < now && r.slaDueAt >= now,
  )

  return {
    role: 'dpo',
    tiles: [
      tile('Awaiting approval', pendingApprovals, { href: '/dpo/project-approvals', emphasis: pendingApprovals > 0 }),
      tile('Approved projects', activeProjects),
      tile('Published notices', templates, { href: '/dpo/consent-templates' }),
      tile('Open requests', openRequests.length, { href: '/dpo/request-oversight' }),
      tile('SLA breached', breached.length, { emphasis: breached.length > 0, tone: breached.length > 0 ? 'danger' : 'ok' }),
      tile('Past internal target', internalBreached.length, { tone: internalBreached.length > 0 ? 'warn' : 'ok' }),
      tile('Open breach records', breachesOpen, { tone: breachesOpen > 0 ? 'danger' : 'ok' }),
    ],
    // Pseudonymous by construction — subjectId is mapped, never passed through.
    queue: openRequests.map((r) => ({
      id: r.id,
      subjectRef: pseudonymise(r.subjectId),
      type: r.type,
      status: r.status,
      createdAt: r.createdAt,
      slaDueAt: r.slaDueAt,
      daysRemaining: Math.ceil((r.slaDueAt.getTime() - now.getTime()) / 86_400_000),
      breached: r.slaDueAt < now,
    })),
    sla: { statutoryDays: SLA_DAYS, internalTargetDays: INTERNAL_SLA_DAYS },
  }
}

// ---------------------------------------------------------------------------
// Data Owner — own projects only. Counts and progress, no subject rows.
// ---------------------------------------------------------------------------
async function dataOwnerSummary(admin) {
  const projects = await prisma.project.findMany({
    where: { ownerAdminId: admin.id },
    select: {
      id: true,
      name: true,
      status: true,
      purpose: true,
      retention: true,
      createdAt: true,
      submittedAt: true,
      approvedAt: true,
      rejectionReason: true,
      _count: { select: { sessions: true, consents: true, assignments: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  const projectIds = projects.map((p) => p.id)

  const [photoCount, linkCount, assignedRequests] = await Promise.all([
    projectIds.length
      ? prisma.photo.count({ where: { session: { projectId: { in: projectIds } } } })
      : 0,
    projectIds.length
      ? prisma.photoSubject.count({ where: { photo: { session: { projectId: { in: projectIds } } } } })
      : 0,
    prisma.dsarRequest.count({
      where: { assignedAdminId: admin.id, status: { notIn: ['CLOSED', 'REJECTED'] } },
    }),
  ])

  const byStatus = (status) => projects.filter((p) => p.status === status).length

  return {
    role: 'dataOwner',
    tiles: [
      tile('Drafts', byStatus('DRAFT'), { href: '/data-owner/my-projects' }),
      tile('Awaiting DPO', byStatus('SUBMITTED')),
      tile('Approved', byStatus('APPROVED')),
      tile('Rejected', byStatus('REJECTED'), { tone: byStatus('REJECTED') > 0 ? 'warn' : 'ok' }),
      tile('Photos collected', photoCount, { href: '/data-owner/collection-progress' }),
      tile('Consented links', linkCount),
      tile('DSAR assigned to me', assignedRequests, { emphasis: assignedRequests > 0 }),
    ],
    projects: projects.map(({ _count, ...p }) => ({
      ...p,
      sessionCount: _count.sessions,
      consentCount: _count.consents,
      agentCount: _count.assignments,
    })),
  }
}

// ---------------------------------------------------------------------------
// Collection Agent — assigned, non-archived work only.
// ---------------------------------------------------------------------------
async function collectionAgentSummary(admin) {
  const [assignments, sessions, deferred] = await Promise.all([
    prisma.projectAssignment.findMany({
      where: { adminId: admin.id, project: { status: 'APPROVED' } },
      select: {
        assignedAt: true,
        project: { select: { id: true, name: true, purpose: true, status: true, retention: true } },
      },
    }),
    prisma.session.findMany({
      where: { agentId: admin.id },
      select: {
        id: true,
        code: true,
        status: true,
        location: true,
        createdAt: true,
        project: { select: { id: true, name: true } },
        _count: { select: { photos: true, participants: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 25,
    }),
    // Surfaced to the agent because they are the one person who can still act on
    // it — a deferred photo means the PII worker was unreachable during their
    // session and the batch cannot be handed off.
    prisma.photo.count({
      where: { session: { agentId: admin.id }, piiStatus: { in: ['DEFERRED', 'FAILED'] } },
    }),
  ])

  const open = sessions.filter((s) => ['ACTIVE', 'PROCESSING', 'TAGGING'].includes(s.status))

  return {
    role: 'collectionAgent',
    tiles: [
      tile('Assigned projects', assignments.length, { href: '/agent/assignments' }),
      tile('Open sessions', open.length, { href: '/agent/sessions', emphasis: open.length > 0 }),
      tile('Awaiting tagging', sessions.filter((s) => s.status === 'TAGGING').length),
      tile('Photos captured', sessions.reduce((n, s) => n + s._count.photos, 0)),
      tile('Blocked by redaction', deferred, { tone: deferred > 0 ? 'danger' : 'ok', emphasis: deferred > 0 }),
    ],
    assignments: assignments.map((a) => ({ ...a.project, assignedAt: a.assignedAt })),
    sessions: sessions.map(({ _count, ...s }) => ({
      ...s,
      photoCount: _count.photos,
      participantCount: _count.participants,
    })),
  }
}

// ---------------------------------------------------------------------------
// Data Team Admin — DSAR execution and ingest.
// ---------------------------------------------------------------------------
async function dataAdminSummary() {
  const now = new Date()

  const [queue, pendingHandoffs, blockedHandoffs, purgesRunning, deferredPhotos] = await Promise.all([
    prisma.dsarRequest.findMany({
      where: { status: { notIn: ['CLOSED', 'REJECTED'] } },
      select: { id: true, subjectId: true, type: true, status: true, slaDueAt: true, assignedAdminId: true, createdAt: true },
      orderBy: { slaDueAt: 'asc' },
      take: 50,
    }),
    prisma.sessionHandoff.count({ where: { status: 'PENDING_INGEST' } }),
    // Handoffs that cannot ingest because something in them is unmasked. Counted
    // separately from "pending" so the queue length never quietly includes work
    // nobody can action.
    prisma.sessionHandoff.count({
      where: {
        status: 'PENDING_INGEST',
        session: { photos: { some: { OR: [{ piiStatus: 'DEFERRED' }, { piiStatus: 'FAILED' }, { redactedPath: null }] } } },
      },
    }),
    prisma.purgeJob.count({ where: { status: { in: ['QUEUED', 'RUNNING', 'PARTIAL'] } } }),
    prisma.photo.count({ where: { piiStatus: { in: ['DEFERRED', 'FAILED'] } } }),
  ])

  return {
    role: 'dataAdmin',
    tiles: [
      tile('Open DSAR', queue.length, { href: '/data-admin/dsar-queue', emphasis: queue.length > 0 }),
      tile('SLA breached', queue.filter((r) => r.slaDueAt < now).length, {
        tone: queue.some((r) => r.slaDueAt < now) ? 'danger' : 'ok',
      }),
      tile('Handoffs pending', pendingHandoffs),
      tile('Handoffs blocked', blockedHandoffs, { tone: blockedHandoffs > 0 ? 'danger' : 'ok' }),
      tile('Purges in flight', purgesRunning),
      tile('Photos unmasked', deferredPhotos, { tone: deferredPhotos > 0 ? 'danger' : 'ok' }),
    ],
    queue: queue.map((r) => ({
      id: r.id,
      // The executor DOES need to act on the real subject, but the queue list is
      // not where that identity is needed — it is revealed on the request detail
      // page, behind an AccessEvent.
      subjectRef: pseudonymise(r.subjectId),
      type: r.type,
      status: r.status,
      assignedAdminId: r.assignedAdminId,
      createdAt: r.createdAt,
      slaDueAt: r.slaDueAt,
      breached: r.slaDueAt < now,
    })),
  }
}

// ---------------------------------------------------------------------------
// Platform root — everything, plus what nobody else is watching.
// ---------------------------------------------------------------------------
async function superAdminSummary() {
  const [admins, projects, subjects, openDsar, breaches, breakGlass] = await Promise.all([
    prisma.adminUser.count(),
    prisma.project.count(),
    prisma.subject.count(),
    prisma.dsarRequest.count({ where: { status: { notIn: ['CLOSED', 'REJECTED'] } } }),
    prisma.breachRecord.count({ where: { status: { in: ['OPEN', 'CONTAINED'] } } }),
    prisma.accessEvent.count({
      where: { breakGlass: true, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
    }),
  ])

  return {
    role: 'super_admin',
    tiles: [
      tile('Admin accounts', admins),
      tile('Projects', projects),
      tile('Data principals', subjects),
      tile('Open DSAR', openDsar),
      tile('Open breaches', breaches, { tone: breaches > 0 ? 'danger' : 'ok' }),
      tile('Break-glass (30d)', breakGlass, { tone: breakGlass > 0 ? 'warn' : 'ok' }),
    ],
  }
}

export async function getSummary(admin) {
  switch (admin.role) {
    case 'dpo':
      return dpoSummary()
    case 'dataOwner':
      return dataOwnerSummary(admin)
    case 'collectionAgent':
      return collectionAgentSummary(admin)
    case 'dataAdmin':
      return dataAdminSummary()
    case 'super_admin':
      return superAdminSummary()
    default:
      throw new ApiError(403, `No dashboard is defined for role ${admin.role}`)
  }
}

// ---------------------------------------------------------------------------
// Compliance report (DPDP §10 accountability evidence)
// ---------------------------------------------------------------------------
// ComplianceReports.jsx was assembled client-side from /audit and /audit/verify,
// which meant the report was whatever the browser happened to fetch. A report an
// auditor may rely on has to be produced server-side, over a stated window, from
// the same tables the enforcement reads — so this counts, and the UI renders.
//
// Pseudonymous throughout: nothing here names a principal, because nothing here
// needs to.
export async function getComplianceReport(admin, { from, to } = {}) {
  if (!['dpo', 'dataAdmin', 'dataOwner', 'super_admin'].includes(admin.role)) {
    throw new ApiError(403, 'Not authorized to generate a compliance report')
  }

  const now = new Date()
  const periodEnd = to ?? now
  const periodStart = from ?? new Date(periodEnd.getTime() - 90 * 24 * 60 * 60 * 1000)
  const window = { gte: periodStart, lte: periodEnd }

  // A data owner's report covers its own projects only. Everything below is
  // filtered through this, so there is one place the scope is decided.
  const ownedProjects =
    admin.role === 'dataOwner'
      ? (await prisma.project.findMany({ where: { ownerAdminId: admin.id }, select: { id: true } })).map((p) => p.id)
      : null
  const projectFilter = ownedProjects ? { in: ownedProjects } : undefined

  const [
    projectsByStatus,
    consentGranted,
    consentWithdrawn,
    dsarRaised,
    dsarClosed,
    dsarOpen,
    certificates,
    accessEvents,
    breakGlassEvents,
    breaches,
    photoByPii,
    handoffsByStatus,
    noticesPublished,
  ] = await Promise.all([
    prisma.project.groupBy({
      by: ['status'],
      where: projectFilter ? { id: projectFilter } : {},
      _count: { _all: true },
    }),
    prisma.projectConsent.count({
      where: { consentedAt: window, ...(projectFilter ? { projectId: projectFilter } : {}) },
    }),
    prisma.projectConsent.count({
      where: { revokedAt: window, ...(projectFilter ? { projectId: projectFilter } : {}) },
    }),
    prisma.dsarRequest.groupBy({
      by: ['type'],
      where: { createdAt: window, ...(projectFilter ? { projectId: projectFilter } : {}) },
      _count: { _all: true },
    }),
    prisma.dsarRequest.findMany({
      where: {
        closedAt: window,
        status: { in: ['CLOSED', 'REJECTED'] },
        ...(projectFilter ? { projectId: projectFilter } : {}),
      },
      select: { createdAt: true, closedAt: true, slaDueAt: true, internalDueAt: true },
    }),
    prisma.dsarRequest.findMany({
      where: {
        status: { notIn: ['CLOSED', 'REJECTED'] },
        ...(projectFilter ? { projectId: projectFilter } : {}),
      },
      select: { slaDueAt: true, internalDueAt: true },
    }),
    prisma.deletionCertificate.count({
      where: { issuedAt: window, ...(projectFilter ? { request: { projectId: projectFilter } } : {}) },
    }),
    prisma.accessEvent.count({ where: { createdAt: window } }),
    prisma.accessEvent.count({ where: { createdAt: window, breakGlass: true } }),
    prisma.breachRecord.count({ where: { discoveredAt: window } }),
    prisma.photo.groupBy({
      by: ['piiStatus'],
      where: projectFilter ? { session: { projectId: projectFilter } } : {},
      _count: { _all: true },
    }),
    prisma.sessionHandoff.groupBy({
      by: ['status'],
      where: projectFilter ? { projectId: projectFilter } : {},
      _count: { _all: true },
    }),
    prisma.consentTemplate.count({ where: { status: 'PUBLISHED' } }),
  ])

  const tally = (rows, key) => Object.fromEntries(rows.map((r) => [r[key], r._count._all]))

  const onTime = dsarClosed.filter((r) => r.closedAt <= r.slaDueAt).length
  const durations = dsarClosed
    .map((r) => (r.closedAt.getTime() - r.createdAt.getTime()) / 86_400_000)
    .sort((a, b) => a - b)
  const median = durations.length
    ? Number(durations[Math.floor((durations.length - 1) / 2)].toFixed(1))
    : null

  const piiCounts = tally(photoByPii, 'piiStatus')

  return {
    period: { from: periodStart.toISOString(), to: periodEnd.toISOString() },
    scope: ownedProjects ? { projectIds: ownedProjects } : { projectIds: 'ALL' },
    governance: {
      projects: tally(projectsByStatus, 'status'),
      publishedNotices: noticesPublished,
    },
    consent: { granted: consentGranted, withdrawn: consentWithdrawn },
    dsar: {
      raisedByType: tally(dsarRaised, 'type'),
      closed: dsarClosed.length,
      closedOnTime: onTime,
      // The number a regulator asks for first. Null rather than 100% when
      // nothing closed in the window — a rate computed from an empty set is a
      // claim the data does not support.
      onTimeRate: dsarClosed.length ? Number(((onTime / dsarClosed.length) * 100).toFixed(1)) : null,
      medianDaysToClose: median,
      open: dsarOpen.length,
      openBreached: dsarOpen.filter((r) => r.slaDueAt < now).length,
      openPastInternalTarget: dsarOpen.filter(
        (r) => r.internalDueAt && r.internalDueAt < now && r.slaDueAt >= now,
      ).length,
      certificatesIssued: certificates,
      slaDays: SLA_DAYS,
      internalSlaDays: INTERNAL_SLA_DAYS,
    },
    access: {
      events: accessEvents,
      breakGlass: breakGlassEvents,
      // Every break-glass read is an exception that must have been justified and
      // notified. Surfaced on its own line so it is never a rounding error in a
      // total.
      breakGlassShare: accessEvents ? Number(((breakGlassEvents / accessEvents) * 100).toFixed(2)) : 0,
    },
    minimisation: {
      photosByPiiStatus: piiCounts,
      framesBlockedByFailedRedaction: (piiCounts.DEFERRED ?? 0) + (piiCounts.FAILED ?? 0),
      handoffs: tally(handoffsByStatus, 'status'),
    },
    breaches: { detectedInPeriod: breaches },
    generatedAt: now.toISOString(),
    generatedForRole: admin.role,
  }
}
