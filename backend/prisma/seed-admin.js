import 'dotenv/config'
import { prisma } from '../src/config/prisma.js'
import { generateOpaqueToken, hashOpaqueToken } from '../src/lib/tokens.js'

const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

// Bootstraps the very first super_admin outside the normal invite flow (nobody
// exists yet to send the invite). Prints a one-time accept-invite link to the
// console instead of hardcoding a password.
const ROLES = ['super_admin', 'dpo', 'dataOwner', 'collectionAgent', 'dataAdmin']

async function main() {
  const email = process.argv[2] ?? process.env.SEED_ADMIN_EMAIL
  const role = process.argv[3] ?? process.env.SEED_ADMIN_ROLE ?? 'super_admin'
  if (!email) {
    console.error('Usage: node prisma/seed-admin.js <email> [role]  (or set SEED_ADMIN_EMAIL)')
    process.exit(1)
  }
  if (!ROLES.includes(role)) {
    console.error(`Invalid role "${role}". Expected one of: ${ROLES.join(', ')}`)
    process.exit(1)
  }

  const existing = await prisma.adminUser.findUnique({ where: { email } })
  if (existing) {
    console.error(`An admin with email ${email} already exists (status: ${existing.status}).`)
    process.exit(1)
  }

  const admin = await prisma.adminUser.create({
    data: { email, role, status: 'INVITED' },
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

  const base = process.env.ADMIN_APP_BASE_URL ?? 'http://localhost:5180'
  console.log(`\nAdmin bootstrapped: ${email} (role: ${role})`)
  console.log(`Accept-invite link (single-use, expires in 7 days):\n\n  ${base}/accept-invite?token=${rawToken}\n`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
