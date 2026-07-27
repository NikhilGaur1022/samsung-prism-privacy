import { prisma } from '../../config/prisma.js'

// DPDP §11 — "a summary of personal data being processed and the processing
// activities undertaken". For an image platform that means the principal must be
// able to answer *how many photos am I in, and under which purpose*, without
// filing a DSAR. The answer is derived from PhotoSubject, the same link table
// erasure operates on, so the count a principal sees and the count an erasure
// would destroy can never disagree.
//
// Scope is deliberately narrow: no other principal on the frame is named, no
// face box is returned, and no storage path ever leaves this function. The photo
// itself is served only through the per-person redacted route, which blurs
// everyone else.
export async function listMyPhotos(subjectId) {
  const links = await prisma.photoSubject.findMany({
    where: { subjectId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      createdAt: true,
      consent: {
        select: { consentId: true, status: true, policyVersion: true, consentedAt: true, revokedAt: true },
      },
      photo: {
        select: {
          id: true,
          sessionId: true,
          takenAt: true,
          createdAt: true,
          redactedPath: true,
          piiStatus: true,
          session: {
            select: {
              code: true,
              status: true,
              location: true,
              archivedAt: true,
              project: { select: { id: true, name: true, purpose: true, retention: true, status: true } },
            },
          },
        },
      },
    },
  })

  const byProject = new Map()

  for (const link of links) {
    const { photo } = link
    const project = photo.session.project
    if (!byProject.has(project.id)) {
      byProject.set(project.id, {
        project,
        consent: link.consent,
        photoCount: 0,
        sessions: new Set(),
        photos: [],
      })
    }
    const group = byProject.get(project.id)
    group.photoCount += 1
    group.sessions.add(photo.sessionId)
    group.photos.push({
      photoId: photo.id,
      sessionId: photo.sessionId,
      sessionCode: photo.session.code,
      sessionStatus: photo.session.status,
      location: photo.session.location,
      takenAt: photo.takenAt ?? photo.createdAt,
      linkedAt: link.createdAt,
      // Whether the principal can currently view their own copy. A DEFERRED or
      // FAILED mask means the redaction did not confirm, and invariant 8 says a
      // frame in that state is served to nobody — including its own subject.
      viewable: Boolean(photo.redactedPath) && !['DEFERRED', 'FAILED'].includes(photo.piiStatus),
    })
  }

  const projects = [...byProject.values()].map((g) => ({
    project: g.project,
    consent: g.consent,
    photoCount: g.photoCount,
    sessionCount: g.sessions.size,
    photos: g.photos,
  }))

  return {
    totalPhotos: links.length,
    projectCount: projects.length,
    projects,
  }
}
