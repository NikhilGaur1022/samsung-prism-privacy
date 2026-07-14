import 'dotenv/config'
import { prisma } from '../src/config/prisma.js'
import { signConsent } from '../src/lib/consent.js'

// Test-data shortcut ONLY. Creates ACTIVE subjects and, optionally, grants them
// consent to a project directly — skipping the OTP + user-portal flow so the
// agent-side session/tagging flow can be exercised without a working mailbox per
// person. Never point this at a production database.
const PEOPLE = [
  { fullName: 'Aarav Sharma', email: 'aarav@example.test' },
  { fullName: 'Riya Fernandes', email: 'riya@example.test' },
  { fullName: 'Kabir Iyer', email: 'kabir@example.test' },
  { fullName: 'Mei Chen', email: 'mei@example.test' },
]

async function main() {
  const projectId = process.argv[2]
  const withoutConsent = process.argv.includes('--no-consent')

  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to seed test subjects in production.')
    process.exit(1)
  }

  const project = projectId
    ? await prisma.project.findUnique({ where: { id: projectId } })
    : await prisma.project.findFirst({ orderBy: { createdAt: 'desc' } })

  if (!project) {
    console.error('No project found. Run: npm run prisma:seed-project -- <agentEmail>')
    process.exit(1)
  }

  for (const person of PEOPLE) {
    const subject = await prisma.subject.upsert({
      where: { email: person.email },
      update: { status: 'ACTIVE' },
      create: {
        ...person,
        group: 'VOLUNTEER',
        status: 'ACTIVE',
        registrationChannel: 'AGENT',
        otpVerifiedAt: new Date(),
      },
    })

    // The last person is deliberately left unconsented — that's the case the
    // agent's roster search must show as blocked.
    const isLast = person === PEOPLE[PEOPLE.length - 1]
    if (withoutConsent || isLast) {
      console.log(`${subject.fullName.padEnd(18)} — no consent (blocked in roster)`)
      continue
    }

    const consentedAt = new Date()
    await prisma.projectConsent.upsert({
      where: { subjectId_projectId: { subjectId: subject.masterUserId, projectId: project.id } },
      update: { status: 'ACTIVE', revokedAt: null },
      create: {
        subjectId: subject.masterUserId,
        projectId: project.id,
        policyVersion: project.policyVersion,
        consentedAt,
        signatureHash: signConsent({
          subjectId: subject.masterUserId,
          projectId: project.id,
          policyVersion: project.policyVersion,
          signedAt: consentedAt,
        }),
      },
    })
    console.log(`${subject.fullName.padEnd(18)} — consent ACTIVE`)
  }

  console.log(`\nProject: ${project.name} (${project.id})\n`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
