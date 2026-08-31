import { prisma } from '../../config/prisma.js'

// DPDP §11 — "a summary of personal data being processed and the processing
// activities undertaken". Note *summary*: the section entitles the principal to
// know what is held about them and on what basis, not to a self-service viewer
// over the collected material.
//
// This surface therefore returns counts, purposes and consent state only. It
// used to return one row per photograph — id, session code, capture location,
// timestamp, and a `viewable` flag the portal used to fetch the actual bytes —
// which made the portal a standing read channel over the dataset, available to
// anyone holding a session cookie and answerable to no approval.
//
// Actual material is delivered through an ACCESS request instead: reviewed by a
// data admin, approved by the DPO, packaged as redacted derivatives with a
// manifest, and downloaded once through a single-use token. That path is
// auditable and revocable; a photo grid in a portal is neither.
//
// The counts are derived from PhotoSubject, the same link table erasure operates
// on, so the number a principal sees and the number an erasure would destroy can
// never disagree.
export async function summariseMyPhotos(subjectId) {
  const links = await prisma.photoSubject.findMany({
    where: { subjectId },
    select: {
      createdAt: true,
      consent: {
        select: { consentId: true, status: true, policyVersion: true, consentedAt: true, revokedAt: true },
      },
      photo: {
        select: {
          // No storagePath and no redactedPath: nothing downstream can turn this
          // response into a fetch, because nothing here names a stored object.
          // Enforced by the select rather than by remembering not to spread it.
          sessionId: true,
          takenAt: true,
          createdAt: true,
          session: {
            select: {
              project: { select: { id: true, name: true, purpose: true, retention: true, status: true } },
            },
          },
        },
      },
    },
  })

  const byProject = new Map()
  const allSessions = new Set()
  let first = null
  let last = null

  for (const link of links) {
    const { photo } = link
    const project = photo.session.project
    const at = photo.takenAt ?? photo.createdAt

    if (!byProject.has(project.id)) {
      byProject.set(project.id, {
        project,
        consent: link.consent,
        photoCount: 0,
        sessions: new Set(),
        first: null,
        last: null,
      })
    }
    const group = byProject.get(project.id)
    group.photoCount += 1
    group.sessions.add(photo.sessionId)
    if (!group.first || at < group.first) group.first = at
    if (!group.last || at > group.last) group.last = at

    allSessions.add(photo.sessionId)
    if (!first || at < first) first = at
    if (!last || at > last) last = at
  }

  const projects = [...byProject.values()].map((g) => ({
    project: g.project,
    consent: g.consent,
    photoCount: g.photoCount,
    sessionCount: g.sessions.size,
    firstCollectedAt: g.first,
    lastCollectedAt: g.last,
  }))

  return {
    totalPhotos: links.length,
    projectCount: projects.length,
    sessionCount: allSessions.size,
    firstCollectedAt: first,
    lastCollectedAt: last,
    projects,
  }
}
