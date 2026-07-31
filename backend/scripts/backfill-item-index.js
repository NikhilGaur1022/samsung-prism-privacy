#!/usr/bin/env node
import process from 'node:process'

import { prisma } from '../src/config/prisma.js'
import { rebuildAll } from '../src/modules/dsar/itemIndex.service.js'

// One-shot (and re-runnable) backfill of `subject_data_items` from the source
// tables. Safe to run against a live database and safe to run twice: every
// write is an upsert on (subjectId, type, sourceTable, sourceId), so a second
// pass changes zero rows.
//
// Resumable by subject id rather than by a checkpoint file: rebuildAll() walks
// subjects keyset-ordered, and the last id it finished is printed on every
// batch, so a crashed run continues with --after=<id> and re-does at most one
// subject.
//
// Usage:
//   node scripts/backfill-item-index.js [--batch-size=100] [--after=<subjectId>]
//                                       [--subject=<subjectId>] [--quiet]

const args = process.argv.slice(2)

function flag(name, fallback = null) {
  const found = args.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

const BATCH_SIZE = Number.parseInt(flag('batch-size', '100'), 10)
const AFTER = flag('after')
const ONLY_SUBJECT = flag('subject')
const QUIET = args.includes('--quiet')

if (!Number.isInteger(BATCH_SIZE) || BATCH_SIZE < 1) {
  console.error('--batch-size must be a positive integer')
  process.exit(2)
}

async function main() {
  const startedAt = Date.now()

  if (ONLY_SUBJECT) {
    const { indexSubject } = await import('../src/modules/dsar/itemIndex.service.js')
    const result = await indexSubject(ONLY_SUBJECT)
    console.log(JSON.stringify(result, null, 2))
    return
  }

  let done = 0
  const totals = await rebuildAll({
    batchSize: BATCH_SIZE,
    after: AFTER,
    onSubject: (result) => {
      done += 1
      if (QUIET) return
      // Printed per subject, not per batch: the last id on stdout is the exact
      // resume point, and a run killed mid-batch still leaves one.
      console.log(
        `[${done}] ${result.subjectId} indexed=${result.indexed} live=${result.live} tombstoned=${result.tombstoned}`,
      )
    },
  })

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(
    `\ndone in ${seconds}s — subjects=${totals.subjects} items=${totals.indexed} ` +
      `live=${totals.live} tombstoned=${totals.tombstoned}`,
  )
  if (totals.lastSubjectId) console.log(`resume point: --after=${totals.lastSubjectId}`)
}

main()
  .catch((err) => {
    console.error('backfill failed:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
