import 'dotenv/config'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { PrismaClient, Prisma } from '@prisma/client'

// A backup you can actually restore from.
//
// The database is managed Postgres and its provider takes snapshots. That covers
// exactly one of the three things this system needs to survive a rebuild:
//
//   1. the rows                — provider snapshot, or the dump written here
//   2. the sealed media tree   — a directory on the app server. Nobody is
//                                backing this up. It is not in the database and
//                                it is not in the provider's snapshot.
//   3. the keys                — MEDIA_KEK, FACE_EMBEDDING_KEY,
//                                DSAR_SIGNING_SEED. They live in one .env file
//                                on one machine.
//
// Any two of those without the third is a pile of unopenable bytes. That is the
// design working as intended — envelope encryption is what makes a DSAR erasure
// provable — but it means a routine "restore the database" produces something
// that looks recovered and is not.
//
// THE KEYS ARE DELIBERATELY NOT IN THIS BACKUP. Writing them next to the
// ciphertext they open would turn every backup into a plaintext copy of the
// whole system. What is recorded instead is a FINGERPRINT of each key, so a
// restore can prove it holds the right key without the backup ever having
// contained it. Where the real keys live is a custody question, answered in
// docs/KEY_CUSTODY.md, not a scripting one.
//
// Usage:
//   node scripts/backup.js                       # to ./backups/<timestamp>
//   node scripts/backup.js --out /path/to/dir
//   node scripts/backup.js --skip-media          # rows and manifest only
//
// See also: restore.js, verify-restore.js.

const args = process.argv.slice(2)
const argValue = (flag) => {
  const i = args.indexOf(flag)
  return i === -1 ? null : args[i + 1]
}

const STORAGE_ROOT = process.env.STORAGE_ROOT ?? './storage/media'
const SKIP_MEDIA = args.includes('--skip-media')

// The erasure ledger is the one file that must NOT live only inside a backup.
// See the long comment on collectTombstones().
const LEDGER_PATH =
  process.env.ERASURE_LEDGER_PATH ?? path.join(path.dirname(STORAGE_ROOT), 'erasure-tombstones.jsonl')

const prisma = new PrismaClient()

function stamp() {
  // Filesystem-safe ISO: 2026-08-21T104233Z
  return new Date().toISOString().replace(/[:.]/g, '').replace(/(\d{8})(\d{6})\d*Z/, '$1T$2Z')
}

/**
 * A key's identity without the key.
 *
 * HMAC rather than a plain hash of the secret: a bare SHA-256 of a 32-byte key
 * is offline-guessable if the key ever had low entropy, and a fingerprint file
 * is by definition the least-guarded thing in the backup. The label is a fixed
 * domain separator, so the same key fingerprints differently per role.
 */
function fingerprint(secret, label) {
  if (!secret) return null
  return createHash('sha256').update(`prism-key-fingerprint:${label}:`).update(secret).digest('hex').slice(0, 32)
}

function collectKeyFingerprints() {
  const keys = {
    MEDIA_KEK: process.env.MEDIA_KEK,
    MEDIA_KEK_PREVIOUS: process.env.MEDIA_KEK_PREVIOUS,
    FACE_EMBEDDING_KEY: process.env.FACE_EMBEDDING_KEY,
    DSAR_SIGNING_SEED: process.env.DSAR_SIGNING_SEED,
  }

  const out = {
    kekVersion: Number.parseInt(process.env.MEDIA_KEK_VERSION ?? '1', 10),
    requireSealed: process.env.MEDIA_REQUIRE_SEALED === 'on',
    fingerprints: {},
  }

  for (const [name, value] of Object.entries(keys)) {
    out.fingerprints[name] = value ? fingerprint(value, name) : null
  }

  return out
}

/**
 * Refuse to produce a backup that cannot be restored.
 *
 * A backup taken with MEDIA_KEK unset is a directory of sealed blobs and no
 * record of what opens them. It would restore cleanly, verify cleanly at the
 * row level, and hand back nothing but noise — and you would find out at the
 * worst possible moment. Better to fail here, loudly, while someone is watching.
 */
function assertRestorable() {
  const missing = []
  if (!process.env.MEDIA_KEK) missing.push('MEDIA_KEK')
  if (!process.env.FACE_EMBEDDING_KEY) missing.push('FACE_EMBEDDING_KEY')
  if (!process.env.DSAR_SIGNING_SEED && !process.env.MEDIA_KEK) missing.push('DSAR_SIGNING_SEED')

  if (missing.length) {
    throw new Error(
      `Refusing to back up: ${missing.join(', ')} not set.\n` +
        'A backup taken without these restores into unopenable ciphertext.\n' +
        'Load the real environment first, or pass --skip-media if you genuinely\n' +
        'only want the rows and understand the media will not be recoverable.',
    )
  }
}

/** Everything the model layer knows about, so a new table cannot be forgotten. */
function modelNames() {
  return Prisma.dmmf.datamodel.models.map((m) => m.name)
}

const delegateFor = (model) => prisma[model.charAt(0).toLowerCase() + model.slice(1)]

/**
 * Logical dump, one JSONL file per table.
 *
 * pg_dump is used when it is on PATH — it is faster, it round-trips types
 * exactly, and it is what a production runbook should say. It is not installed
 * on every machine that needs to take a backup, and a rehearsal that cannot be
 * run is not a rehearsal, so the logical path exists as the fallback that always
 * works.
 */
async function dumpDatabase(outDir) {
  await fs.mkdir(path.join(outDir, 'db'), { recursive: true })

  const direct = process.env.DIRECT_URL ?? process.env.DATABASE_URL
  if (direct && hasPgDump()) {
    const file = path.join(outDir, 'db', 'dump.pgcustom')
    execFileSync('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', file, direct], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    return { format: 'pg_dump', file: 'db/dump.pgcustom', tables: null }
  }

  const tables = {}
  for (const model of modelNames()) {
    const delegate = delegateFor(model)
    if (!delegate?.findMany) continue

    const rows = await delegate.findMany()
    const file = path.join(outDir, 'db', `${model}.jsonl`)
    // Buffers and BigInts do not survive JSON.stringify on their own, and both
    // appear in this schema (SubjectKey.salt is Bytes).
    const body = rows
      .map((row) =>
        JSON.stringify(row, (_k, v) => {
          if (typeof v === 'bigint') return { __bigint: v.toString() }
          if (v?.type === 'Buffer' && Array.isArray(v.data)) return { __bytes: Buffer.from(v.data).toString('base64') }
          return v
        }),
      )
      .join('\n')
    await fs.writeFile(file, body ? `${body}\n` : '', 'utf8')
    tables[model] = rows.length
  }

  return { format: 'jsonl', file: 'db/', tables }
}

function hasPgDump() {
  try {
    execFileSync('pg_dump', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' })
    return true
  } catch {
    return false
  }
}

async function* walk(dir, base = dir) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full, base)
    else if (entry.isFile()) yield path.relative(base, full).replaceAll('\\', '/')
  }
}

/**
 * The media tree, copied verbatim.
 *
 * No re-encryption and no decryption: the blobs on disk are already sealed and
 * this process has no business opening them. Checksums are over the sealed
 * bytes, so a restore can prove the ciphertext is intact without ever holding
 * the key that opens it.
 */
async function copyMedia(outDir) {
  const src = path.resolve(STORAGE_ROOT)
  const dst = path.join(outDir, 'media')
  const digests = []
  let bytes = 0

  for await (const rel of walk(src)) {
    const from = path.join(src, rel)
    const to = path.join(dst, rel)
    await fs.mkdir(path.dirname(to), { recursive: true })
    const buf = await fs.readFile(from)
    await fs.writeFile(to, buf)
    digests.push(`${createHash('sha256').update(buf).digest('hex')}  ${rel}`)
    bytes += buf.length
  }

  await fs.writeFile(path.join(outDir, 'media.sha256'), digests.length ? `${digests.join('\n')}\n` : '', 'utf8')
  return { files: digests.length, bytes }
}

/**
 * The erasure ledger — the piece that makes a restore safe rather than merely
 * successful.
 *
 * Restoring a backup taken before an erasure resurrects that person: their
 * per-subject salt comes back, their biometrics become readable again, and the
 * signed certificate saying they were destroyed is now false. The restore
 * itself reports success. Nothing in the database can catch this, because the
 * database being restored is precisely the one that predates the erasure.
 *
 * So the record of who has been erased has to live OUTSIDE any single database
 * state: an append-only file that accumulates across backups and is never
 * rolled back with them. verify-restore.js checks the restored database against
 * it and names anyone who came back from the dead.
 *
 * Honest limitation: if the ledger file is lost along with the server, the
 * newest copy inside a backup is the fallback, and it is only as current as
 * that backup. Custody of this file matters nearly as much as custody of the
 * KEK — docs/KEY_CUSTODY.md says so explicitly.
 */
async function collectTombstones(outDir) {
  const destroyed = await prisma.subjectKey.findMany({
    where: { destroyedAt: { not: null } },
    select: { subjectId: true, keyId: true, destroyedAt: true, kekVersion: true },
  })

  const existing = new Map()
  try {
    const raw = await fs.readFile(LEDGER_PATH, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      const row = JSON.parse(line)
      existing.set(row.subjectId, row)
    }
  } catch {
    // No ledger yet. The first backup creates it.
  }

  const added = []
  for (const row of destroyed) {
    if (existing.has(row.subjectId)) continue
    const entry = {
      subjectId: row.subjectId,
      keyId: row.keyId,
      destroyedAt: row.destroyedAt?.toISOString() ?? null,
      kekVersion: row.kekVersion,
      recordedAt: new Date().toISOString(),
    }
    existing.set(row.subjectId, entry)
    added.push(entry)
  }

  const body = [...existing.values()].map((e) => JSON.stringify(e)).join('\n')
  const serialised = body ? `${body}\n` : ''

  await fs.mkdir(path.dirname(LEDGER_PATH), { recursive: true })
  await fs.writeFile(LEDGER_PATH, serialised, 'utf8')
  await fs.writeFile(path.join(outDir, 'erasure-tombstones.jsonl'), serialised, 'utf8')

  return { total: existing.size, added: added.length, ledgerPath: LEDGER_PATH }
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    }).trim()
  } catch {
    return null
  }
}

async function main() {
  if (!SKIP_MEDIA) assertRestorable()

  const outDir = path.resolve(argValue('--out') ?? path.join('backups', stamp()))
  await fs.mkdir(outDir, { recursive: true })

  console.log(`\nbacking up to ${outDir}\n`)

  const db = await dumpDatabase(outDir)
  console.log(`  database   ${db.format}${db.tables ? ` — ${Object.keys(db.tables).length} tables` : ''}`)

  const media = SKIP_MEDIA ? { files: 0, bytes: 0, skipped: true } : await copyMedia(outDir)
  console.log(
    SKIP_MEDIA
      ? '  media      SKIPPED (--skip-media)'
      : `  media      ${media.files} files, ${(media.bytes / 1e6).toFixed(1)} MB (sealed, not decrypted)`,
  )

  const tombstones = await collectTombstones(outDir)
  console.log(`  erasures   ${tombstones.total} tombstoned (${tombstones.added} new this run)`)

  const keys = collectKeyFingerprints()
  await fs.writeFile(path.join(outDir, 'keys.fingerprint.json'), JSON.stringify(keys, null, 2), 'utf8')
  console.log(`  keys       fingerprints only — KEK v${keys.kekVersion}, no key material written`)

  const manifest = {
    createdAt: new Date().toISOString(),
    gitCommit: gitCommit(),
    storageRoot: path.resolve(STORAGE_ROOT),
    database: db,
    media,
    tombstones: { total: tombstones.total, ledgerPath: tombstones.ledgerPath },
    keys,
    // Stated in the artifact itself so nobody has to infer it from the file list.
    warning:
      'This backup contains NO key material. Restoring it without MEDIA_KEK, ' +
      'FACE_EMBEDDING_KEY and DSAR_SIGNING_SEED yields unopenable ciphertext. ' +
      'See docs/KEY_CUSTODY.md.',
  }
  await fs.writeFile(path.join(outDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2), 'utf8')

  console.log(`\nbackup complete\n`)
  console.log(`  verify it:  node scripts/verify-restore.js --backup "${outDir}"\n`)
}

main()
  .catch((err) => {
    console.error(`\n${err.message}\n`)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
