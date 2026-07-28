import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prisma } from '../src/config/prisma.js'

// Clears the admin table back to empty so `bootstrap-admin` can mint the first
// super_admin again. It exists because seed-admin.js deliberately refuses to run
// while any admin row survives, and after a gate run the table is full of
// `@test.invalid` fixtures that the e2e teardown does not remove.
//
// It only ever deletes rows from admin_users. audit_log and access_events are
// append-only and are left alone, so the history of the accounts being removed
// outlives the accounts themselves — which is the point.
//
// Two things cascade from AdminUser and are worth knowing before running it:
//   AuthToken / RefreshToken  onDelete: Cascade   — credentials, expected
//   Session.agent             onDelete: Cascade   — DESTRUCTIVE: takes photos with it
// so it refuses to run if any admin here owns a session. Project.owner is
// SetNull, so projects survive as orphans rather than disappearing.

const here = path.dirname(fileURLToPath(import.meta.url))
const backupPath = path.resolve(here, '..', '..', 'scratchpad', `backup-admins-${Date.now()}.json`)

const TEST_SUFFIX = '@test.invalid'

async function main() {
  const keepArg = process.argv.indexOf('--keep')
  const keep = keepArg === -1 ? [] : process.argv[keepArg + 1].split(',').map((e) => e.trim().toLowerCase())

  const admins = await prisma.adminUser.findMany({
    select: { id: true, email: true, role: true, status: true, createdAt: true },
  })
  const doomed = admins.filter((a) => !keep.includes(a.email.toLowerCase()))

  if (doomed.length === 0) {
    console.log('Nothing to delete — admin table is already empty of removable rows.')
    return
  }

  // Session.agent cascades. An admin who ran a session cannot be deleted without
  // silently taking the session, its photos and every derived row with it, so
  // this stops rather than guessing that the caller meant that.
  const sessions = await prisma.session.count({ where: { agentId: { in: doomed.map((a) => a.id) } } })
  if (sessions > 0) {
    console.error(
      `Refusing to run: ${sessions} session(s) are owned by admins scheduled for deletion.\n` +
        'Session.agent cascades, so this would delete those sessions and their photos.\n' +
        'Reassign or remove the sessions deliberately first.',
    )
    process.exit(1)
  }

  fs.mkdirSync(path.dirname(backupPath), { recursive: true })
  fs.writeFileSync(backupPath, JSON.stringify({ deletedAt: new Date().toISOString(), admins: doomed }, null, 2))
  console.log(`Backed up ${doomed.length} admin row(s) to ${backupPath}\n`)

  const tests = doomed.filter((a) => a.email.endsWith(TEST_SUFFIX))
  const real = doomed.filter((a) => !a.email.endsWith(TEST_SUFFIX))

  console.log(`  ${tests.length} e2e fixture(s) (${TEST_SUFFIX})`)
  for (const a of real) console.log(`  real account: ${a.email} (${a.role}, ${a.status})`)

  const removed = await prisma.adminUser.deleteMany({ where: { id: { in: doomed.map((a) => a.id) } } })

  const remaining = await prisma.adminUser.count()
  console.log(`\nDeleted ${removed.count} admin row(s). ${remaining} remain.`)

  const orphans = await prisma.project.count({ where: { ownerAdminId: null } })
  if (orphans > 0) {
    console.log(`\nNote: ${orphans} project(s) now have no owner (Project.owner is SetNull, not Cascade).`)
  }

  if (remaining === 0) {
    console.log('\nAdmin table is empty. Run:  npm run bootstrap-admin -- <email>')
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
