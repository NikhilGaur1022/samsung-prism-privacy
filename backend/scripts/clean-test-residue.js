import 'dotenv/config'
import { prisma } from '../src/config/prisma.js'

// Removes what previous test runs left in the shared database.
//
// Integration tests run against the live database and leave residue behind:
// `rbac-*@test.invalid` and `e2e-*@test.invalid` admin rows, sessions that were
// never ended, and — from the audit itself — one deliberately-inserted junk
// AccessEvent proving the ledger accepted an arbitrary string.
//
// The append-only ledgers make some of this impossible to clean by design, and
// that is precisely why a test must never write to a shared database. This
// script cleans what CAN be cleaned and REPORTS what cannot, rather than
// pretending the problem is solved. The real fix is the ephemeral database in
// scripts/test-db.js.
//
//   node scripts/clean-test-residue.js          # report
//   node scripts/clean-test-residue.js --apply

const APPLY = process.argv.includes('--apply')
const TEST_DOMAIN = '@test.invalid'

async function main() {
  console.log(APPLY ? '=== cleaning test residue ===\n' : '=== test residue (dry run) ===\n')

  const admins = await prisma.adminUser.findMany({
    where: { email: { contains: TEST_DOMAIN } },
    select: { id: true, email: true, role: true },
  })
  const subjects = await prisma.subject.findMany({
    where: { email: { contains: TEST_DOMAIN } },
    select: { masterUserId: true, email: true },
  })

  const adminIds = admins.map((a) => a.id)
  const subjectIds = subjects.map((s) => s.masterUserId)

  const sessions = await prisma.session.findMany({
    where: { agentId: { in: adminIds } },
    select: { id: true, code: true, status: true },
  })
  const projects = await prisma.project.findMany({
    where: { ownerAdminId: { in: adminIds } },
    select: { id: true, name: true },
  })

  console.log(`admin rows      ${admins.length}`)
  console.log(`subject rows    ${subjects.length}`)
  console.log(`sessions        ${sessions.length}`)
  console.log(`projects        ${projects.length}`)

  // What cannot be removed. Stated rather than quietly skipped: an auditor
  // reading the ledger will see these rows, and "a test wrote them" has to be
  // findable somewhere.
  const junkLedger = await prisma.accessEvent.count({
    where: { OR: [{ objectId: { contains: 'PROBE' } }, { actorId: { in: adminIds } }] },
  })
  const auditRows = await prisma.auditLog.count({ where: { actorId: { in: adminIds } } })

  console.log(`\nUNREMOVABLE (append-only by design):`)
  console.log(`  access events attributable to test actors  ${junkLedger}`)
  console.log(`  audit log rows attributable to test actors ${auditRows}`)
  console.log(
    `  These stay. They are why integration tests must run against an ephemeral\n` +
      `  database — see scripts/test-db.js.`,
  )

  if (!APPLY) {
    console.log('\n(dry run — pass --apply to delete)')
    return
  }

  // Ordered by dependency: media, then the rows pointing at it, then the
  // principals. Cascades cover most of it; being explicit keeps a partial
  // failure legible.
  const sessionIds = sessions.map((s) => s.id)

  const deleted = {}
  deleted.photoSubjects = (
    await prisma.photoSubject.deleteMany({ where: { photo: { sessionId: { in: sessionIds } } } })
  ).count
  deleted.faceDetections = (
    await prisma.faceDetection.deleteMany({ where: { photo: { sessionId: { in: sessionIds } } } })
  ).count
  deleted.photos = (await prisma.photo.deleteMany({ where: { sessionId: { in: sessionIds } } })).count
  deleted.handoffs = (
    await prisma.sessionHandoff.deleteMany({ where: { sessionId: { in: sessionIds } } })
  ).count
  deleted.sessions = (await prisma.session.deleteMany({ where: { id: { in: sessionIds } } })).count
  deleted.assignments = (
    await prisma.projectAssignment.deleteMany({ where: { adminId: { in: adminIds } } })
  ).count
  deleted.projects = (
    await prisma.project.deleteMany({ where: { id: { in: projects.map((p) => p.id) } } })
  ).count
  deleted.subjects = (
    await prisma.subject.deleteMany({ where: { masterUserId: { in: subjectIds } } })
  ).count
  deleted.admins = (await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } })).count

  console.log('\ndeleted:')
  for (const [k, v] of Object.entries(deleted)) console.log(`  ${k.padEnd(16)} ${v}`)
}

main()
  .catch((err) => {
    console.error('cleanup failed:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
