import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'

// An ephemeral database, created and dropped per run.
//
// Integration tests currently run against the shared development database and
// leave residue: 20 `rbac-*` and `e2e-*@test.invalid` admin rows, sessions that
// were never ended, and a junk AccessEvent the audit inserted to prove the
// ledger accepted an arbitrary string.
//
// The residue is not the real problem. The real problem is that the append-only
// ledgers make cleanup IMPOSSIBLE by design — audit_log and access_events are
// RLS-forced insert-and-select-only — so every integration run permanently
// writes rows into the tables that DPDP accountability rests on, attributed to
// principals that never existed. A compliance ledger polluted by test fixtures
// is a compliance ledger an auditor cannot rely on.
//
// So: a real database per run, torn down afterwards, and nothing to clean.
//
//   node scripts/test-db.js create        # prints a DATABASE_URL
//   node scripts/test-db.js drop <name>
//   node scripts/test-db.js run -- npm test
//
// It needs a role that may CREATE DATABASE, which the least-privilege
// application role deliberately is not — hence ADMIN_DATABASE_URL.

const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? process.env.DIRECT_URL
const PREFIX = 'prism_test_'

function adminClient() {
  if (!ADMIN_URL) {
    throw new Error(
      'ADMIN_DATABASE_URL is not set. Creating a database needs a role with ' +
        'CREATE DATABASE, which the application role deliberately lacks.',
    )
  }
  return new PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
}

function urlFor(dbName) {
  const url = new URL(ADMIN_URL)
  url.pathname = `/${dbName}`
  return url.toString()
}

async function create() {
  // A name that cannot collide with a concurrent run on the same server, which
  // is the case CI actually hits.
  const name = `${PREFIX}${randomUUID().replace(/-/g, '').slice(0, 16)}`
  const prisma = adminClient()

  try {
    // Not parameterised because an identifier cannot be. Bounded instead: the
    // name is generated here from a uuid and never comes from input.
    await prisma.$executeRawUnsafe(`CREATE DATABASE "${name}"`)
  } finally {
    await prisma.$disconnect()
  }

  const url = urlFor(name)

  // Migrations rather than `db push`: the tests have to run against the schema
  // that ships, including the RLS and the append-only enforcement, or the suite
  // is testing something the deployment does not have.
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
    shell: process.platform === 'win32',
  })

  return { name, url }
}

async function drop(name) {
  if (!name?.startsWith(PREFIX)) {
    throw new Error(`refusing to drop "${name}" — only ${PREFIX}* databases may be dropped here`)
  }
  const prisma = adminClient()
  try {
    // Terminate stragglers first; a single lingering connection makes DROP fail
    // and leaves the database behind forever.
    await prisma.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
    )
    // WITH (FORCE) rather than a bare DROP: against a pooled connection the
    // terminate above is immediately undone by the pooler opening a fresh
    // session, so a plain DROP loses that race and the database is orphaned.
    // Postgres 13+ terminates and drops in one statement, which cannot be raced.
    try {
      await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    } catch {
      await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}"`)
    }
  } finally {
    await prisma.$disconnect()
  }
}

/** Lists leftovers from runs that died before their teardown. */
async function list() {
  const prisma = adminClient()
  try {
    return await prisma.$queryRawUnsafe(
      `SELECT datname FROM pg_database WHERE datname LIKE '${PREFIX}%' ORDER BY datname`,
    )
  } finally {
    await prisma.$disconnect()
  }
}

async function run(command) {
  if (command.length === 0) throw new Error('nothing to run — pass a command after --')

  const { name, url } = await create()
  console.log(`\ntest database: ${name}\n`)

  let code = 0
  try {
    execFileSync(command[0], command.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url, NODE_ENV: 'test' },
      shell: process.platform === 'win32',
    })
  } catch (err) {
    code = err.status ?? 1
  } finally {
    // Dropped whether the suite passed or failed. A failing run that leaves its
    // database behind is how a server ends up with a hundred of them.
    console.log(`\ndropping ${name}`)
    await drop(name).catch((dropErr) => {
      console.error(`could not drop ${name}: ${dropErr.message}`)
    })
  }

  process.exitCode = code
}

const [verb, ...rest] = process.argv.slice(2)

const main = async () => {
  switch (verb) {
    case 'create': {
      const { name, url } = await create()
      console.log(name)
      console.log(url)
      break
    }
    case 'drop':
      await drop(rest[0])
      console.log(`dropped ${rest[0]}`)
      break
    case 'list': {
      const rows = await list()
      if (rows.length === 0) console.log('(no leftover test databases)')
      for (const r of rows) console.log(r.datname)
      break
    }
    case 'prune': {
      const rows = await list()
      for (const r of rows) {
        await drop(r.datname)
        console.log(`dropped ${r.datname}`)
      }
      break
    }
    case 'run': {
      const dashdash = process.argv.indexOf('--')
      await run(dashdash === -1 ? rest : process.argv.slice(dashdash + 1))
      break
    }
    default:
      console.log(
        'usage: node scripts/test-db.js <create|drop <name>|list|prune|run -- <command...>>',
      )
      process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exitCode = 1
})
