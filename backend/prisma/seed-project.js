import 'dotenv/config'
import { prisma } from '../src/config/prisma.js'

// Creates a project and assigns a collection agent to it. Until the Data Owner's
// "Create Project" screen is wired to the API, this is how a project gets into the
// system — an agent with no assignment sees an empty Assignments list and can't
// start a session at all.
async function main() {
  const agentEmail = process.argv[2] ?? process.env.SEED_AGENT_EMAIL
  const name = process.argv[3] ?? 'Face Recognition Training v4.2'

  if (!agentEmail) {
    console.error('Usage: node prisma/seed-project.js <agentEmail> [projectName]')
    process.exit(1)
  }

  const agent = await prisma.adminUser.findUnique({ where: { email: agentEmail } })
  if (!agent) {
    console.error(`No admin user with email ${agentEmail}. Seed one first (npm run prisma:seed-admin).`)
    process.exit(1)
  }

  const project = await prisma.project.create({
    data: {
      name,
      purpose:
        'Training adaptive facial geometry models across diverse lighting conditions, for biometric authentication research.',
      retention: '2 years',
      policyVersion: 'v1',
      assignments: { create: { adminId: agent.id } },
    },
  })

  console.log(`\nProject created: ${project.name} (${project.id})`)
  console.log(`Assigned to: ${agent.email} (${agent.role})\n`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
