import 'dotenv/config'
import bcrypt from 'bcrypt'
import { prisma } from '../src/config/prisma.js'
import { writeAuditLog } from '../src/lib/auditLog.js'

// Local-testing only. Mints one ACTIVE admin per role with a shared, known
// password so every workspace in the portal can be opened without going through
// the invite flow — which is unusable locally, because the accept link is only
// ever sent by email and sendAdminInviteEmail() does not log it the way
// sendOtpEmail() logs OTPs.
//
// This is a deliberate bypass of the invite audit trail: the accounts it creates
// have no inviter and were never activated by a human proving mailbox control.
// It refuses to run under NODE_ENV=production for that reason.
const BCRYPT_COST = 12
const PASSWORD = process.env.DEV_ADMIN_PASSWORD ?? 'Prism@2026!'

const ACCOUNTS = [
  { role: 'super_admin', email: 'nikhilgaur1022@gmail.com' },
  { role: 'dpo', email: 'dpo@prism.local' },
  { role: 'dataOwner', email: 'dataowner@prism.local' },
  { role: 'collectionAgent', email: 'agent@prism.local' },
  { role: 'dataAdmin', email: 'dataadmin@prism.local' },
]

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to run under NODE_ENV=production.')
    process.exit(1)
  }

  const passwordHash = await bcrypt.hash(PASSWORD, BCRYPT_COST)
  const results = []

  for (const { role, email } of ACCOUNTS) {
    const existing = await prisma.adminUser.findUnique({ where: { email } })

    if (existing && existing.role !== role) {
      console.error(`${email} already exists as ${existing.role}, not ${role} — skipping.`)
      continue
    }

    const admin = await prisma.adminUser.upsert({
      where: { email },
      update: { passwordHash, status: 'ACTIVE', failedLoginAttempts: 0, lockedUntil: null },
      create: { email, role, status: 'ACTIVE', passwordHash },
    })

    // Any INVITE token still outstanding for this account is now meaningless —
    // the password it would have set has been set here instead.
    await prisma.authToken.deleteMany({
      where: { adminUserId: admin.id, purpose: 'ADMIN_INVITE', consumedAt: null },
    })

    await writeAuditLog({
      entityType: 'AdminUser',
      entityId: admin.id,
      action: existing ? 'ACTIVATED' : 'ADMIN_BOOTSTRAPPED',
      actorId: admin.id,
      payload: { role, via: 'dev-seed-admins' },
    })

    results.push({ role, email, created: !existing })
  }

  console.table(results)
  console.log(`\npassword for all of the above: ${PASSWORD}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
