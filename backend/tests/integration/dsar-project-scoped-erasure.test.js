import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { prisma } from '../../src/config/prisma.js'
import { runDiscovery } from '../../src/modules/dsar/discovery.service.js'

// A §6(4) withdrawal names ONE project. It used to be executed as a whole-subject
// purge: consent.service.js raised the request with a projectId, createPurgeJob
// dropped it and called runDiscovery(subjectId), and the resulting job destroyed
// the principal's data in every other project, crypto-shredded the per-subject
// DEK and anonymised the identity row. The account was deleted in response to a
// request that never asked for it, and the subject could no longer log in.
//
// The bitter part is that consent.service.js reasons correctly about exactly this
// two lines before it raises the erasure — "If any other project still has active
// consent it stays" — and then handed the job to an executor that ignored the
// project entirely.

const SUBJECT_LEVEL = new Set(['PII', 'L8', 'L11'])

function codesOf(discovery) {
  return discovery.locations.map((l) => `${l.locationCode}:${l.objectType}`)
}

async function seedSubjectInTwoProjects() {
  const subjectId = randomUUID()
  const projectA = randomUUID()
  const projectB = randomUUID()

  await prisma.subject.create({
    data: {
      masterUserId: subjectId,
      group: 'VOLUNTEER',
      status: 'ACTIVE',
      fullName: 'Scoping Fixture',
      email: `scoping-${subjectId.slice(0, 8)}@prism.test`,
      registrationChannel: 'SELF',
      otpVerifiedAt: new Date(),
      generalTerms: true,
      piiProcessing: true,
      biometricMatch: true,
    },
  })

  // Real Project rows: project_consent_matrix has a FK onto them, and the whole
  // point of this fixture is that the subject genuinely belongs to two.
  for (const [id, name] of [
    [projectA, 'Scoping fixture A'],
    [projectB, 'Scoping fixture B'],
  ]) {
    await prisma.project.create({
      data: { id, name, purpose: 'project-scoped erasure regression fixture', status: 'APPROVED' },
    })
  }

  const consents = []
  for (const projectId of [projectA, projectB]) {
    consents.push(
      await prisma.projectConsent.create({
        data: {
          subjectId,
          projectId,
          status: 'ACTIVE',
          policyVersion: 'test-1',
          signatureHash: randomUUID(),
        },
        select: { consentId: true, projectId: true },
      }),
    )
  }

  return { subjectId, projectA, projectB, consents }
}

test('a project-scoped walk never names the identity row or the subject key', async (t) => {
  const { subjectId, projectA, projectB } = await seedSubjectInTwoProjects()
  t.after(async () => {
    await prisma.projectConsent.deleteMany({ where: { subjectId } })
    await prisma.subject.deleteMany({ where: { masterUserId: subjectId } })
    await prisma.project.deleteMany({ where: { id: { in: [projectA, projectB] } } })
  })

  const full = await runDiscovery(subjectId)
  const scoped = await runDiscovery(subjectId, { projectId: projectA })

  assert.equal(full.scope, 'FULL')
  assert.equal(full.projectId, null)
  assert.equal(scoped.scope, 'PROJECT')
  assert.equal(scoped.projectId, projectA)

  // The whole-subject walk still does what it always did. This is the half that
  // must not regress: an erasure that under-reports is data surviving a deletion
  // the principal was told was complete.
  assert.ok(codesOf(full).includes('PII:Subject'), 'a full walk must still anonymise the identity row')
  assert.ok(codesOf(full).includes('L5:SubjectKey'), 'a full walk must still crypto-shred the DEK')

  // And the scoped walk must not.
  assert.ok(!codesOf(scoped).includes('PII:Subject'), 'a project erasure must leave the account')
  assert.ok(!codesOf(scoped).includes('L5:SubjectKey'), 'a project erasure must leave the DEK')
  for (const loc of scoped.locations) {
    assert.ok(
      !SUBJECT_LEVEL.has(loc.locationCode),
      `project scope leaked the subject-level location ${loc.locationCode}`,
    )
  }
})

test('a project-scoped walk touches only the withdrawn project’s consent', async (t) => {
  const { subjectId, projectA, projectB } = await seedSubjectInTwoProjects()
  t.after(async () => {
    await prisma.projectConsent.deleteMany({ where: { subjectId } })
    await prisma.subject.deleteMany({ where: { masterUserId: subjectId } })
    await prisma.project.deleteMany({ where: { id: { in: [projectA, projectB] } } })
  })

  const full = await runDiscovery(subjectId)
  const scoped = await runDiscovery(subjectId, { projectId: projectA })

  const consentsIn = (d) => d.locations.filter((l) => l.locationCode === 'CONSENT')
  assert.equal(consentsIn(full).length, 2, 'a full walk revokes both consents')
  assert.equal(consentsIn(scoped).length, 1, 'a project walk revokes exactly one')

  // The other project is untouched, which is the entire point.
  const survivor = await prisma.projectConsent.findFirst({
    where: { subjectId, projectId: projectB },
  })
  assert.ok(survivor, 'the other project’s consent must still exist')
})

test('the enrollment and voice print survive a project erasure', async (t) => {
  const { subjectId, projectA, projectB } = await seedSubjectInTwoProjects()
  t.after(async () => {
    await prisma.projectConsent.deleteMany({ where: { subjectId } })
    await prisma.subject.deleteMany({ where: { masterUserId: subjectId } })
    await prisma.project.deleteMany({ where: { id: { in: [projectA, projectB] } } })
  })

  const scoped = await runDiscovery(subjectId, { projectId: projectA })
  const codes = codesOf(scoped)

  // Held once per subject, not per project. When the LAST consent goes,
  // consent.service.js deletes them directly — that is the only place that can
  // count the remaining consents, so it is where the decision belongs.
  for (const code of ['L4:SubjectFaceEnrollment.imagePath', 'L5:SubjectFaceEnrollment.embedding']) {
    assert.ok(!codes.includes(code), `project scope must not reach ${code}`)
  }
})
