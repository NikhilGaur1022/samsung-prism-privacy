import 'dotenv/config'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { PrismaClient, Prisma } from '@prisma/client'

// The other half of backup.js.
//
// This is the script nobody runs until the worst day, which is exactly why it
// has to be run on an ordinary day first. Restoring is not the hard part —
// knowing whether what came back is usable is. So this script deliberately does
// LESS than you might expect: it puts the bytes and the rows back, and then it
// tells you to run verify-restore.js, because "the copy finished" and "the
// system works" are different claims and only the second one matters.
//
// Two guards worth knowing about before you read further:
//
//   * It refuses to restore into a database that already has rows unless you
//     pass --force. A restore run against the wrong DATABASE_URL is the classic
//     way to turn an incident into a much larger incident.
//   * It refuses to restore media over an existing tree unless you pass
//     --force. Half-overwritten media is worse than either version alone.
//
// Usage:
//   node scripts/restore.js --backup <dir> --target-db <url> --target-media <dir>
//   node scripts/restore.js --backup <dir> --rows-only
//   node scripts/restore.js --backup <dir> --media-only
//
// After it finishes:
//   node scripts/verify-restore.js --backup <dir>

const args = process.argv.slice(2)
const argValue = (flag) => {
  const i = args.indexOf(flag)
  return i === -1 ? null : args[i + 1]
}

const BACKUP = argValue('--backup')
const FORCE = args.includes('--force')
const ROWS_ONLY = args.includes('--rows-only')
const MEDIA_ONLY = args.includes('--media-only')

const TARGET_DB = argValue('--target-db') ?? process.env.DATABASE_URL
const TARGET_MEDIA = path.resolve(argValue('--target-media') ?? process.env.STORAGE_ROOT ?? './storage/media')

const prisma = new PrismaClient({ datasources: { db: { url: TARGET_DB } } })

const delegateFor = (model) => prisma[model.charAt(0).toLowerCase() + model.slice(1)]

/**
 * Insertion order that satisfies the foreign keys.
 *
 * A logical dump is a set of tables with no inherent order, and inserting a
 * PhotoSubject before its Photo fails. Prisma's DMMF knows which side of every
 * relation holds the key — the side with `relationFromFields` — so the graph is
 * already there to be walked; there is no need to hand-maintain a list that
 * would go stale the first time someone adds a model.
 *
 * Cycles (a model that references itself, or a mutually-optional pair) are
 * emitted last rather than throwing: their FKs are nullable by construction, so
 * the rows insert and the references resolve once every table is present.
 */
function topologicalOrder() {
  const models = Prisma.dmmf.datamodel.models
  const byName = new Map(models.map((m) => [m.name, m]))
  const deps = new Map()

  for (const model of models) {
    const set = new Set()
    for (const field of model.fields) {
      if (field.kind !== 'object') continue
      if (!field.relationFromFields?.length) continue // the other side holds the key
      if (field.type === model.name) continue // self-reference: nullable, resolves later
      if (byName.has(field.type)) set.add(field.type)
    }
    deps.set(model.name, set)
  }

  const ordered = []
  const placed = new Set()
  let progress = true

  while (progress) {
    progress = false
    for (const model of models) {
      if (placed.has(model.name)) continue
      const unmet = [...deps.get(model.name)].filter((d) => !placed.has(d))
      if (unmet.length === 0) {
        ordered.push(model.name)
        placed.add(model.name)
        progress = true
      }
    }
  }

  const cyclic = models.map((m) => m.name).filter((n) => !placed.has(n))
  return { ordered, cyclic }
}

/** Undo the encoding backup.js applied to types JSON cannot carry. */
function reviver(_key, value) {
  if (value && typeof value === 'object') {
    if (typeof value.__bigint === 'string') return BigInt(value.__bigint)
    if (typeof value.__bytes === 'string') return Buffer.from(value.__bytes, 'base64')
  }
  return value
}

async function readTable(model) {
  let raw
  try {
    raw = await fs.readFile(path.join(BACKUP, 'db', `${model}.jsonl`), 'utf8')
  } catch {
    return null
  }
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l, reviver))
}

async function assertTargetEmpty() {
  if (FORCE) return

  const busy = []
  for (const model of ['AdminUser', 'Subject', 'Project', 'Photo']) {
    const delegate = delegateFor(model)
    if (!delegate?.count) continue
    const n = await delegate.count()
    if (n > 0) busy.push(`${model}=${n}`)
  }

  if (busy.length) {
    throw new Error(
      `Refusing to restore: the target database already holds data (${busy.join(', ')}).\n` +
        'Restoring into a live database merges two histories and produces a third\n' +
        'that matches neither. Point --target-db at an empty database, or pass\n' +
        '--force if you genuinely mean to overwrite this one.',
    )
  }
}

async function restoreRows() {
  const manifest = JSON.parse(await fs.readFile(path.join(BACKUP, 'MANIFEST.json'), 'utf8'))

  if (manifest.database?.format === 'pg_dump') {
    const file = path.join(BACKUP, manifest.database.file)
    execFileSync('pg_restore', ['--no-owner', '--no-privileges', '--dbname', TARGET_DB, file], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    return { format: 'pg_dump' }
  }

  await assertTargetEmpty()

  const { ordered, cyclic } = topologicalOrder()
  const sequence = [...ordered, ...cyclic]
  const counts = {}
  let total = 0
  // Counted separately from `total`, because they mean opposite things. With
  // --force onto a populated database, skipDuplicates leaves every existing row
  // exactly as it was — so "11,093 rows restored" can be true of the file and
  // false of the database. A restore that reports a number it did not actually
  // write is the kind of claim this whole system exists to stop making.
  let skipped = 0

  for (const model of sequence) {
    const rows = await readTable(model)
    if (!rows) continue
    if (rows.length === 0) {
      counts[model] = 0
      continue
    }

    const delegate = delegateFor(model)
    if (!delegate?.createMany) continue

    // Chunked: a single createMany of 100k rows exceeds the parameter limit the
    // driver will accept, and the failure mode is an opaque protocol error.
    const CHUNK = 500
    let inserted = 0
    for (let i = 0; i < rows.length; i += CHUNK) {
      const result = await delegate.createMany({ data: rows.slice(i, i + CHUNK), skipDuplicates: true })
      inserted += result.count
    }

    counts[model] = inserted
    total += inserted
    skipped += rows.length - inserted
  }

  if (cyclic.length) {
    console.log(`  (${cyclic.length} model(s) restored last to resolve circular references: ${cyclic.join(', ')})`)
  }

  return { format: 'jsonl', tables: counts, total, skipped }
}

async function restoreMedia() {
  const src = path.join(BACKUP, 'media')

  try {
    const existing = await fs.readdir(TARGET_MEDIA)
    const meaningful = existing.filter((n) => n !== '.gitkeep')
    if (meaningful.length && !FORCE) {
      throw new Error(
        `Refusing to restore media: ${TARGET_MEDIA} is not empty (${meaningful.length} entries).\n` +
          'Overwriting a live media tree file-by-file leaves a mixture of two\n' +
          'states that no checksum will match. Restore into an empty directory,\n' +
          'or pass --force.',
      )
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }

  let listing
  try {
    listing = await fs.readFile(path.join(BACKUP, 'media.sha256'), 'utf8')
  } catch {
    return { files: 0, note: 'no media in this backup' }
  }

  const lines = listing.split('\n').filter((l) => l.trim())
  const mismatched = []
  let bytes = 0

  for (const line of lines) {
    const [digest, rel] = line.split(/\s{2,}/)
    if (!rel) continue

    const buf = await fs.readFile(path.join(src, rel))
    // Checked on the way in, not afterwards: a corrupt blob that reaches the
    // live tree is indistinguishable from a blob whose key is wrong, and those
    // have very different remedies.
    if (createHash('sha256').update(buf).digest('hex') !== digest) {
      mismatched.push(rel)
      continue
    }

    const to = path.join(TARGET_MEDIA, rel)
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.writeFile(to, buf)
    bytes += buf.length
  }

  if (mismatched.length) {
    throw new Error(
      `${mismatched.length} file(s) in the backup failed their checksum and were NOT restored:\n` +
        mismatched.slice(0, 10).map((f) => `  ${f}`).join('\n') +
        (mismatched.length > 10 ? `\n  ...and ${mismatched.length - 10} more` : ''),
    )
  }

  return { files: lines.length, bytes }
}

async function main() {
  if (!BACKUP) {
    console.error('usage: node scripts/restore.js --backup <dir> [--target-db <url>] [--target-media <dir>] [--force]')
    process.exitCode = 1
    return
  }

  const manifest = JSON.parse(await fs.readFile(path.join(BACKUP, 'MANIFEST.json'), 'utf8'))

  console.log(`\nrestoring from ${BACKUP}`)
  console.log(`backup taken ${manifest.createdAt}${manifest.gitCommit ? ` at ${manifest.gitCommit}` : ''}`)
  console.log(`target db    ${String(TARGET_DB).replace(/:[^:@/]+@/, ':****@')}`)
  console.log(`target media ${TARGET_MEDIA}\n`)

  if (!MEDIA_ONLY) {
    const rows = await restoreRows()
    console.log(
      rows.format === 'pg_dump'
        ? '  rows       restored via pg_restore'
        : `  rows       ${rows.total} inserted across ${Object.keys(rows.tables).length} tables` +
          (rows.skipped ? `, ${rows.skipped} already present and left untouched` : ''),
    )

    if (rows.skipped) {
      console.log('')
      console.log('  Rows already present were NOT overwritten. If you meant to replace this')
      console.log("  database's contents rather than fill gaps in it, restore into an empty")
      console.log('  one — the merged result matches neither history.')
      console.log('')
    }
  }

  if (!ROWS_ONLY) {
    const media = await restoreMedia()
    console.log(
      media.note
        ? `  media      ${media.note}`
        : `  media      ${media.files} files, ${(media.bytes / 1e6).toFixed(1)} MB (checksums verified on the way in)`,
    )
  }

  console.log('\nrestore complete — but not yet proven.\n')
  console.log('  The bytes are back. Whether they are USABLE depends on whether you hold')
  console.log('  the same keys this backup was sealed with, and whether restoring an older')
  console.log('  state has undone an erasure someone is legally entitled to. Run:\n')
  console.log(`    node scripts/verify-restore.js --backup "${BACKUP}"\n`)
}

main()
  .catch((err) => {
    console.error(`\n${err.message}\n`)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
