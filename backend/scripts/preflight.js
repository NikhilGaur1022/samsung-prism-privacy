import 'dotenv/config'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prisma } from '../src/config/prisma.js'
import { DEFAULT_AUDIT_SECRET } from '../src/lib/auditLog.js'

// Refuses to let a production deployment start on defaults.
//
// Every check here corresponds to something that fails silently and looks fine:
// a dev HMAC secret still produces a chain, a missing KEK still writes files, a
// BYPASSRLS role still accepts the RLS migration. The failure surfaces only when
// someone tries to rely on the guarantee, which is exactly too late.
//
// Severity model:
//   FAIL  — non-zero exit in production. In development it is reported and the
//           process still exits 0, because a laptop is allowed to run on defaults
//           so long as nobody is pretending otherwise.
//   WARN  — never blocks; something to fix.

const IS_PROD = process.env.NODE_ENV === 'production'
const results = []

function check(name, status, detail) {
  results.push({ name, status, detail })
}
const pass = (n, d) => check(n, 'PASS', d)
const fail = (n, d) => check(n, 'FAIL', d)
const warn = (n, d) => check(n, 'WARN', d)

const WEAK_VALUES = new Set([
  '', 'changeme', 'change-me', 'secret', 'dev', 'development', 'test',
  DEFAULT_AUDIT_SECRET, 'dev-only-secret-change-in-prod',
])

function isWeak(value) {
  return !value || WEAK_VALUES.has(String(value).trim().toLowerCase())
}

// --- secrets ---------------------------------------------------------------
function checkSecrets() {
  const auditSecret = process.env.AUDIT_HMAC_SECRET
  if (isWeak(auditSecret)) {
    fail('AUDIT_HMAC_SECRET', 'unset or still the development default — the audit chain would be forgeable')
  } else if (auditSecret.length < 32) {
    fail('AUDIT_HMAC_SECRET', `only ${auditSecret.length} chars; use at least 32`)
  } else {
    pass('AUDIT_HMAC_SECRET', 'set and long enough')
  }

  const kek = process.env.MEDIA_KEK
  if (isWeak(kek)) {
    fail('MEDIA_KEK', 'unset or a default — media at rest would be plaintext or unopenable')
  } else {
    const decoded = /^[0-9a-fA-F]{64}$/.test(kek) ? Buffer.from(kek, 'hex') : Buffer.from(kek, 'base64')
    if (decoded.length !== 32) {
      fail('MEDIA_KEK', `decodes to ${decoded.length} bytes; must be exactly 32`)
    } else {
      pass('MEDIA_KEK', '32 bytes')
    }
  }

  if (process.env.DSAR_SIGNING_SEED) {
    pass('DSAR_SIGNING_SEED', 'explicit signing seed set')
  } else if (process.env.MEDIA_KEK) {
    warn('DSAR_SIGNING_SEED', 'not set — certificate key is derived from MEDIA_KEK, so rotating the KEK invalidates verification of existing certificates')
  } else {
    fail('DSAR_SIGNING_SEED', 'no signing key and no MEDIA_KEK to derive one from — deletion certificates cannot be issued')
  }

  for (const name of ['JWT_ADMIN_SECRET', 'JWT_SUBJECT_SECRET']) {
    if (isWeak(process.env[name])) fail(name, 'unset or a default value')
    else pass(name, 'set')
  }

  if (IS_PROD && process.env.AUTH_PROVIDER !== 'real') {
    fail('AUTH_PROVIDER', 'must be "real" in production — the dev auth stub would be live')
  } else {
    pass('AUTH_PROVIDER', process.env.AUTH_PROVIDER ?? '(dev)')
  }
}

// --- transport -------------------------------------------------------------
function checkTransport() {
  const url = process.env.DATABASE_URL ?? ''
  if (!url) {
    fail('DATABASE_URL', 'not set')
  } else if (IS_PROD && !/sslmode=(require|verify-full|verify-ca)/.test(url)) {
    fail('DATABASE_URL', 'no sslmode=require — the Postgres connection would be in the clear')
  } else {
    pass('DATABASE_URL', 'present')
  }

  const redisUrl = process.env.REDIS_URL ?? ''
  if (IS_PROD && redisUrl && !redisUrl.startsWith('rediss://')) {
    warn('REDIS_URL', 'not TLS (rediss://) — job payloads carry photo and subject ids')
  }

  if (IS_PROD && process.env.MEDIA_REQUIRE_SEALED !== 'on') {
    warn(
      'MEDIA_REQUIRE_SEALED',
      'not "on" — a plaintext legacy blob would still be served silently. Turn on once scripts/migrate-media-encrypt.js has swept the store.',
    )
  } else if (process.env.MEDIA_REQUIRE_SEALED === 'on') {
    pass('MEDIA_REQUIRE_SEALED', 'on')
  }
}

// --- no mock data ----------------------------------------------------------
function checkNoMockData() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const backend = path.resolve(here, '..')
  const repo = path.resolve(backend, '..')

  const banned = [
    path.join(backend, 'prisma', 'seed-project.js'),
    path.join(backend, 'prisma', 'seed.js'),
    path.join(backend, 'prisma', 'seed-subjects.js'),
    path.join(repo, 'admin-portal', 'src', 'data'),
  ]

  const present = banned.filter((p) => existsSync(p))
  if (present.length) {
    fail('no-mock-data', `these must not exist: ${present.map((p) => path.relative(repo, p)).join(', ')}`)
  } else {
    pass('no-mock-data', 'seed scripts and portal mock data are absent')
  }

  // seed-admin.js survives as the bootstrap, but only if it still refuses to run
  // against a populated system — the check is that the guard is present, since a
  // future edit removing it is exactly the regression that matters.
  const bootstrap = path.join(backend, 'prisma', 'seed-admin.js')
  if (existsSync(bootstrap)) {
    const src = readFileSync(bootstrap, 'utf8')
    if (!src.includes('adminUser.count()')) {
      fail('bootstrap-guard', 'prisma/seed-admin.js no longer refuses to run when admins already exist')
    } else {
      pass('bootstrap-guard', 'bootstrap refuses to run on a populated system')
    }
  }
}

// --- database --------------------------------------------------------------
async function checkDatabase() {
  try {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('audit_log','access_events','deletion_certificates')
    `)

    for (const name of ['audit_log', 'access_events', 'deletion_certificates']) {
      const row = rows.find((r) => r.table === name)
      if (!row) fail(`rls:${name}`, 'table not found')
      else if (!row.enabled || !row.forced) {
        fail(`rls:${name}`, `RLS enabled=${row.enabled} forced=${row.forced} — append-only is not enforced`)
      } else {
        pass(`rls:${name}`, 'RLS enabled and forced')
      }
    }

    const [role] = await prisma.$queryRawUnsafe(`
      SELECT current_user AS name, rolsuper AS superuser, rolbypassrls AS bypassrls
      FROM pg_roles WHERE rolname = current_user
    `)

    if (role?.superuser || role?.bypassrls) {
      const detail = `connected as "${role.name}" which has ${role.superuser ? 'SUPERUSER' : ''}${role.superuser && role.bypassrls ? ' and ' : ''}${role.bypassrls ? 'BYPASSRLS' : ''} — RLS is inert for this connection, so the append-only guarantee on audit_log does not hold`
      if (IS_PROD) fail('db-role', detail)
      else warn('db-role', detail)
    } else {
      pass('db-role', `connected as least-privilege role "${role?.name}"`)
    }

    // Supabase publishes every table in `public` through PostgREST, and the
    // `anon` key that reaches it is public by construction — it ships in the
    // portal bundles. If anon holds table privileges, the entire corpus is
    // readable with a key that is not a secret, whatever the API layer enforces.
    // Nothing here uses PostgREST, so the only correct number is zero.
    const exposed = await prisma.$queryRawUnsafe(`
      SELECT grantee, count(DISTINCT table_name)::int AS tables
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
      GROUP BY grantee
    `)
    if (exposed.length > 0) {
      const detail = exposed
        .map((r) => `${r.grantee} can reach ${r.tables} table(s)`)
        .join('; ')
      fail('postgrest-exposure', `${detail} — the anon key is public and bypasses the API entirely`)
    } else {
      pass('postgrest-exposure', 'anon and authenticated hold no table privileges')
    }

    const pending = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE finished_at IS NULL`,
    )
    if (pending[0]?.n > 0) fail('migrations', `${pending[0].n} migration(s) not finished`)
    else pass('migrations', 'all applied')
  } catch (err) {
    fail('database', `could not query: ${err.message}`)
  }
}

// --- redis -----------------------------------------------------------------
async function checkRedis() {
  let redis
  try {
    const mod = await import('../src/config/redis.js')
    redis = mod.redis
    const info = await redis.info('server')
    const version = /redis_version:([\d.]+)/.exec(info)?.[1]
    if (!version) {
      warn('redis', 'connected but could not read the version')
      return
    }

    const [major, minor] = version.split('.').map(Number)
    // BullMQ needs 6.2 for the commands the queues rely on. Below that the
    // workers start, accept jobs, and fail in ways that look like application
    // bugs — which is worse than refusing to boot.
    if (major < 6 || (major === 6 && minor < 2)) {
      fail('redis', `version ${version} is below BullMQ's 6.2.0 floor — the purge and redaction queues will not work correctly`)
    } else {
      pass('redis', `version ${version}`)
    }
  } catch (err) {
    fail('redis', `unreachable: ${err.message}`)
  } finally {
    try {
      await redis?.quit()
    } catch {
      /* closing a broken connection is not itself a finding */
    }
  }
}

async function main() {
  checkSecrets()
  checkTransport()
  checkNoMockData()
  await checkDatabase()
  await checkRedis()

  const width = Math.max(...results.map((r) => r.name.length))
  for (const r of results) {
    const mark = r.status === 'PASS' ? '  ok  ' : r.status === 'WARN' ? ' warn ' : ' FAIL '
    console.log(`[${mark}] ${r.name.padEnd(width)}  ${r.detail}`)
  }

  const failures = results.filter((r) => r.status === 'FAIL')
  const warnings = results.filter((r) => r.status === 'WARN')

  console.log(
    `\n${results.length} checks — ${results.length - failures.length - warnings.length} passed, ${warnings.length} warnings, ${failures.length} failures`,
  )

  if (failures.length === 0) {
    console.log('preflight: GREEN')
    return 0
  }

  if (IS_PROD) {
    console.error('\npreflight: RED — refusing to start in production with the failures above.')
    return 1
  }

  console.warn('\npreflight: RED, but NODE_ENV is not production so this is not fatal.')
  console.warn('Every failure above WILL block a production start.')
  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    console.error('preflight crashed:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
