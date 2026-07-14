import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { consentVerdict } from '../../lib/consent.js'

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

  return project
}

export async function listAssignedProjects(admin) {
  const where =
    admin.role === 'collectionAgent'
      ? { status: 'ACTIVE', assignments: { some: { adminId: admin.id } } }
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
