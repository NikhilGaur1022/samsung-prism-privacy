import 'dotenv/config'
import { prisma } from '../src/config/prisma.js'
import { generateOpaqueToken, hashOpaqueToken } from '../src/lib/tokens.js'
import { writeAuditLog } from '../src/lib/auditLog.js'

const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

// The single bootstrap escape hatch: creates the very first super_admin, because
// the invite flow needs an existing admin to send an invite and at t=0 there is
// none. It is not a seeder — it invents no data, only an identity, and the
// operator still has to prove control of the mailbox to activate it.
//
// Two hard limits keep it from becoming a back door:
//   1. it refuses to run once ANY admin row exists, so it cannot be used to mint
//      a second privileged account behind the invite audit trail;
//   2. it only ever creates super_admin — every other role comes from the invite
//      flow, where an existing admin's identity is on the record as the inviter.
//
// No password is set here. The account is INVITED until a human accepts the
// printed single-use link and chooses their own credential.
async function main() {
  const email = (process.argv[2] ?? process.env.SEED_ADMIN_EMAIL ?? '').trim().toLowerCase()

  if (!email) {
    console.error('Usage: npm run bootstrap-admin -- <email>   (or set SEED_ADMIN_EMAIL)')
    process.exit(1)
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error(`"${email}" is not a valid email address.`)
    process.exit(1)
  }

  const adminCount = await prisma.adminUser.count()
  if (adminCount > 0) {
    console.error(
      `Refusing to run: ${adminCount} admin account(s) already exist.\n` +
        'Bootstrap is for an empty system only. Invite further admins from the portal,\n' +
        'where the invite is attributed to the admin who sent it.',
    )
    process.exit(1)
  }

  const admin = await prisma.adminUser.create({
    data: { email, role: 'super_admin', status: 'INVITED' },
  })

  const rawToken = generateOpaqueToken()
  await prisma.authToken.create({
    data: {
      adminUserId: admin.id,
      purpose: 'ADMIN_INVITE',
      tokenHash: hashOpaqueToken(rawToken),
      expiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS),
    },
  })

  // The bootstrap is the one privileged action with no admin actor behind it.
  // That fact belongs in the ledger rather than only in someone's shell history.
  await writeAuditLog({
    entityType: 'AdminUser',
    entityId: admin.id,
    action: 'ADMIN_BOOTSTRAPPED',
    actorId: null,
    payload: { email, role: 'super_admin' },
  })

  const base = process.env.ADMIN_APP_BASE_URL ?? 'http://localhost:5180'
  console.log(`\nFirst super_admin created: ${email} (status: INVITED)`)
  console.log(`Accept-invite link (single-use, expires in 7 days):\n\n  ${base}/accept-invite?token=${rawToken}\n`)
  console.log('This link is printed once and is not recoverable. If it is lost, delete the')
  console.log('admin row and re-run this script.\n')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
