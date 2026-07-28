import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import { prisma } from '../../src/config/prisma.js'
import { redis } from '../../src/config/redis.js'
import { closeFaceQueue } from '../../src/lib/faceQueue.js'
import { closeRedactionQueue } from '../../src/lib/redactionQueue.js'
import { closePurgeQueue } from '../../src/lib/purgeQueue.js'
import { destroyGallery } from '../../src/lib/faceGallery.js'
import * as templateService from '../../src/modules/consentTemplates/consentTemplate.service.js'
import * as projectService from '../../src/modules/projects/project.service.js'
import * as consentService from '../../src/modules/consent/consent.service.js'
import * as enrollmentService from '../../src/modules/enrollment/enrollment.service.js'
import * as sessionService from '../../src/modules/sessions/session.service.js'
import { processSession } from '../../src/modules/sessions/recognition.service.js'

// Shared setup for the end-to-end suites. Both of them need the same thing: a
// governed project, two consented and enrolled people, a session that has been
// captured, matched, tagged and archived. Building that twice, slightly
// differently, is how two tests end up disagreeing about what "the system" is.
//
// Everything here goes through the real services. Nothing is inserted into a
// table the application would not have written itself, because a fixture that
// skips the service also skips the rule the service enforces.

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

// A certificate cannot be issued without a signing key, and a developer machine
// has neither DSAR_SIGNING_SEED nor MEDIA_KEK set — preflight is what insists on
// real ones before production, and it still does. This supplies a fixed throwaway
// seed so the erasure path can be exercised locally. It never overrides a
// configured key, and it is deliberately a constant: a random seed per run would
// make a failing signature indistinguishable from a rotated key.
if (!process.env.DSAR_SIGNING_SEED && !process.env.MEDIA_KEK) {
  process.env.DSAR_SIGNING_SEED = '00'.repeat(31) + 'e2'
}

export const REQUIRED_FIXTURES = ['solo-a.jpg', 'group.jpg', 'enroll-b.jpg']

/** Human-readable reason the suite cannot run, or null when it can. */
export async function checkPreconditions() {
  const missing = []

  for (const name of REQUIRED_FIXTURES) {
    try {
      await readFile(path.join(FIXTURES, name))
    } catch {
      missing.push(name)
    }
  }
  if (missing.length) {
    return `missing fixture image(s): ${missing.join(', ')} — run \`npm run fixtures:e2e\` (see tests/fixtures/README.md)`
  }

  const services = [
    ['face worker', `${process.env.FACE_SERVICE_URL ?? 'http://localhost:8001'}/health`],
    ['image-pii worker', `${process.env.PII_SERVICE_URL ?? 'http://localhost:8002'}/health`],
    ['qdrant', `${process.env.QDRANT_URL ?? 'http://localhost:6333'}/collections`],
  ]
  for (const [name, url] of services) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) return `${name} answered ${res.status} at ${url}`
    } catch (err) {
      return `${name} unreachable at ${url} (${err.message})`
    }
  }

  try {
    await prisma.$queryRaw`SELECT 1`
  } catch (err) {
    return `postgres unreachable (${err.message})`
  }

  return null
}

export async function fixture(name) {
  return readFile(path.join(FIXTURES, name))
}

const upload = async (name) => ({
  buffer: await fixture(name),
  originalname: name,
  mimetype: 'image/jpeg',
})

/**
 * A world is one disposable universe: its own admins, its own project, its own
 * people. The tag prefixes every email so teardown can find everything it made
 * without touching anything it did not.
 */
export async function buildWorld({ tag = randomUUID().slice(0, 8) } = {}) {
  const world = { tag, admins: {}, subjects: {}, cleanup: { sessionIds: [] } }
  const email = (who) => `e2e-${tag}-${who}@test.invalid`

  for (const role of ['dpo', 'dataOwner', 'collectionAgent', 'dataAdmin', 'super_admin']) {
    world.admins[role] = await prisma.adminUser.create({
      data: { email: email(role), role, status: 'ACTIVE' },
    })
  }

  // --- governance: notice, then project, then approval -----------------------
  const draft = await templateService.createTemplate(
    {
      name: `E2E Notice ${tag}`,
      purpose: 'Supervised collection of facial imagery for on-device recognition research.',
      bodyByLocale: {
        en:
          'We collect your photograph and name so that we can build and evaluate an on-device ' +
          'face recognition model. You may withdraw consent at any time, and we will erase your ' +
          'images and biometric templates. Contact the grievance officer below with any question.',
      },
      dataTypes: ['FACE_IMAGE', 'NAME', 'EMAIL'],
      retention: '90 days after project close',
      grievanceContact: `grievance-${tag}@test.invalid`,
    },
    world.admins.dpo,
  )
  world.template = await templateService.publishTemplate(draft.id, world.admins.dpo)

  const project = await projectService.createProject(
    { name: `E2E Project ${tag}`, purpose: 'placeholder' },
    world.admins.dataOwner,
  )
  await projectService.updateDraft(
    project.id,
    {
      purpose: 'Supervised collection of facial imagery for on-device recognition research.',
      retention: '90 days after project close',
      dataTypes: ['FACE_IMAGE', 'NAME'],
      consentTemplateId: world.template.id,
      riskLevel: 'HIGH',
    },
    world.admins.dataOwner,
  )
  await projectService.submitForApproval(project.id, world.admins.dataOwner)
  world.project = await projectService.approveProject(project.id, world.admins.dpo)

  // Assignment is the owner's call, not the DPO's — the DPO approves the purpose,
  // the owner staffs it (project.service.assignAgent → assertOwned).
  await projectService.assignAgent(
    world.project.id,
    world.admins.collectionAgent.id,
    world.admins.dataOwner,
  )

  // --- the two data principals ----------------------------------------------
  for (const [key, who] of [
    ['a', 'subject-a'],
    ['b', 'subject-b'],
  ]) {
    world.subjects[key] = await prisma.subject.create({
      data: {
        fullName: `E2E ${key.toUpperCase()} ${tag}`,
        email: email(who),
        group: 'VOLUNTEER',
        status: 'ACTIVE',
        registrationChannel: 'SELF',
        otpVerifiedAt: new Date(),
        // Intake-time UX default only. Nothing downstream reads it — every gate in
        // the pipeline goes through project_consent_matrix (invariant 2). It is
        // set here because enrollment.service still checks it before capturing a
        // biometric, which is the one place it is legitimately the signal.
        biometricMatch: true,
      },
    })
  }

  world.consents = {
    a: await consentService.grantConsent(world.subjects.a.masterUserId, world.project.id),
    b: await consentService.grantConsent(world.subjects.b.masterUserId, world.project.id),
  }

  world.enrollments = {
    a: (
      await enrollmentService.createEnrollment({
        subjectId: world.subjects.a.masterUserId,
        file: await upload('solo-a.jpg'),
        source: 'AGENT',
        capturedBy: world.admins.collectionAgent.id,
        pose: 'FRONT',
      })
    ).enrollment,
    b: (
      await enrollmentService.createEnrollment({
        subjectId: world.subjects.b.masterUserId,
        file: await upload('enroll-b.jpg'),
        source: 'AGENT',
        capturedBy: world.admins.collectionAgent.id,
        pose: 'FRONT',
      })
    ).enrollment,
  }

  return world
}

/**
 * Captures a session, runs recognition, tags every group, and archives it.
 *
 * Recognition is driven by calling the pass directly rather than by enqueueing
 * it. The queue is BullMQ's business, not this suite's — what is under test is
 * what the pass does to the data, and waiting on a broker would only add a way
 * for the test to hang.
 */
export async function runSession(world, { photos = ['solo-a.jpg', 'group.jpg'] } = {}) {
  const agent = world.admins.collectionAgent

  const session = await sessionService.createSession({ projectId: world.project.id }, agent)
  world.cleanup.sessionIds.push(session.id)

  await sessionService.addParticipant(session.id, world.subjects.a.masterUserId, agent)
  await sessionService.addParticipant(session.id, world.subjects.b.masterUserId, agent)

  const added = []
  for (const name of photos) {
    const { photo } = await sessionService.addPhoto(
      session.id,
      await upload(name),
      { cameraSource: 'IPHONE_UPLOAD' },
      agent,
    )
    added.push({ name, photo })
  }

  const ended = await sessionService.endSession(session.id, agent)
  const recognition = await processSession(session.id, ended.job.id)

  // Whatever the matcher did or did not resolve, every group has to carry a
  // decision before finalize will run. Auto-tagged groups are already TAGGED; the
  // rest are tagged here from the suggestion, and anything with no suggestion at
  // all is marked UNKNOWN — which is the agent's real workflow, not a shortcut.
  const { clusters } = await sessionService.getClusters(session.id, agent)
  for (const cluster of clusters) {
    if (cluster.tagStatus !== 'PENDING') continue
    const suggested = cluster.suggestedSubjectId ?? cluster.suggested?.subjectId ?? null
    await sessionService.tagCluster(
      session.id,
      cluster.id,
      suggested ? { tagStatus: 'TAGGED', subjectId: suggested } : { tagStatus: 'UNKNOWN' },
      agent,
    )
  }

  const finalized = await sessionService.finalizeSession(session.id, agent)

  return { session, photos: added, recognition, finalized }
}

/** Photo row for a fixture filename inside a session, with its links. */
export async function photoByFixture(sessionId, name, photos) {
  const entry = photos.find((p) => p.name === name)
  if (!entry) throw new Error(`no photo captured for fixture ${name}`)
  return prisma.photo.findUnique({
    where: { id: entry.photo.id },
    include: { subjects: true, faces: true },
  })
}

export async function destroyWorld(world) {
  if (!world) return

  for (const sessionId of world.cleanup.sessionIds) {
    await destroyGallery(sessionId).catch(() => {})
  }

  // Ordered by dependency: rows that reference a subject or project must go
  // before it. Sessions cascade to photos, faces, clusters and participants.
  const subjectIds = Object.values(world.subjects ?? {}).map((s) => s.masterUserId)

  if (subjectIds.length) {
    // DeletionCertificate relates to the DSAR request, not to the purge job, so
    // the requests are the handle for all of it.
    //
    // Teardown deliberately does NOT delete deletion_certificates. The app role
    // has no DELETE on that table — it is evidence, and the whole point of
    // provision-app-role.sql is that nothing running as the application can
    // remove it. A teardown that deleted it only ever worked because the old
    // connection was Supabase's `postgres`, which holds BYPASSRLS. Certificates
    // are reached by the ON DELETE CASCADE from DsarRequest instead; referential
    // actions run as the constraint, not as the caller, so cleanup still
    // completes without the privilege.
    const requests = await prisma.dsarRequest.findMany({
      where: { subjectId: { in: subjectIds } },
      select: { id: true },
    })
    const requestIds = requests.map((r) => r.id)

    if (requestIds.length) {
      await prisma.dsarEvidence.deleteMany({ where: { dsarRequestId: { in: requestIds } } })
    }

    const jobs = await prisma.purgeJob.findMany({
      where: { subjectId: { in: subjectIds } },
      select: { id: true },
    })
    if (jobs.length) {
      await prisma.purgeJobLocation.deleteMany({
        where: { purgeJobId: { in: jobs.map((j) => j.id) } },
      })
    }
    await prisma.purgeJob.deleteMany({ where: { subjectId: { in: subjectIds } } })
    await prisma.dsarRequest.deleteMany({ where: { subjectId: { in: subjectIds } } })
    await prisma.subjectKey.deleteMany({ where: { subjectId: { in: subjectIds } } })
  }

  if (world.project) {
    await prisma.session.deleteMany({ where: { projectId: world.project.id } })
    await prisma.projectAssignment.deleteMany({ where: { projectId: world.project.id } })
    await prisma.projectConsent.deleteMany({ where: { projectId: world.project.id } })
    await prisma.retentionPolicy.deleteMany({ where: { projectId: world.project.id } })
    await prisma.project.delete({ where: { id: world.project.id } }).catch(() => {})
  }

  if (subjectIds.length) {
    await prisma.subject.deleteMany({ where: { masterUserId: { in: subjectIds } } })
  }
  if (world.template) {
    await prisma.consentTemplate.deleteMany({ where: { id: world.template.id } })
  }
  await prisma.adminUser.deleteMany({ where: { email: { contains: `e2e-${world.tag}-` } } })
}

/**
 * Hands back everything the process opened at import time.
 *
 * Without this the test file cannot exit: the Redis client behind the rate
 * limiter reconnects forever by design, and node:test reports a file that never
 * exits as a failure even when every assertion passed.
 */
export async function closeResources() {
  await Promise.allSettled([
    closeFaceQueue(),
    closeRedactionQueue(),
    closePurgeQueue(),
    redis.quit(),
    prisma.$disconnect(),
  ])
}
