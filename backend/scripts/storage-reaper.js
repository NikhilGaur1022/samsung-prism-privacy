import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { prisma } from '../src/config/prisma.js'
import { logger } from '../src/lib/logger.js'
import { resolvePath } from '../src/lib/storage.js'
import { findOrphans, findDanglingReferences } from '../src/lib/storageSweep.js'
import { withAdvisoryLock, LOCK_NAMESPACE } from '../src/lib/advisoryLock.js'
import { writeAuditLog } from '../src/lib/auditLog.js'

// The storage reaper.
//
// Quarantine, never hard-delete on first sight. The one failure worse than an
// orphan is deleting a file that a row written moments later would have
// referenced — an upload that wrote the blob before its row (which is exactly
// what session.service.js addPhoto does) is indistinguishable from an orphan for
// the length of that window.
//
// So the lifecycle is:
//
//   seen unreferenced        -> OrphanBlob(PENDING_DELETE), nothing touched
//   still unreferenced after GRACE   -> moved to _quarantine/, QUARANTINED
//   still unreferenced after RETENTION after that -> shredded, DELETED
//
// A human can mark any of them RETAINED at any point and it is excluded
// permanently. Nothing is ever deleted in one pass, which means a mistake in the
// reference set costs a restore rather than a loss.
//
//   node scripts/storage-reaper.js                 # report
//   node scripts/storage-reaper.js --quarantine    # move the aged ones aside
//   node scripts/storage-reaper.js --purge         # shred aged quarantine
//   node scripts/storage-reaper.js --remediate     # the one-off 265 MB backlog

const GRACE_MS = Number(process.env.ORPHAN_GRACE_MS ?? 24 * 60 * 60 * 1000)
const QUARANTINE_RETENTION_MS = Number(process.env.ORPHAN_QUARANTINE_MS ?? 7 * 24 * 60 * 60 * 1000)
const QUARANTINE_PREFIX = '_quarantine'

const args = new Set(process.argv.slice(2))
const DO_QUARANTINE = args.has('--quarantine') || args.has('--remediate')
const DO_PURGE = args.has('--purge')
const REMEDIATE = args.has('--remediate')

/** Records everything currently unreferenced, without touching a byte. */
async function recordOrphans() {
  const { orphans, totalFiles, referencedCount, bytes } = await findOrphans()

  // Anything already under the quarantine prefix is the reaper's own work, not a
  // new finding.
  const fresh = orphans.filter((o) => !o.path.startsWith(`${QUARANTINE_PREFIX}/`))

  if (fresh.length > 0) {
    await prisma.orphanBlob.createMany({
      data: fresh.map((o) => ({
        storagePath: o.path,
        sizeBytes: o.sizeBytes === null ? null : BigInt(o.sizeBytes),
        reason: 'SWEEP_UNREFERENCED',
        state: 'PENDING_DELETE',
      })),
      skipDuplicates: true,
    })
  }

  // A file that has come BACK into use — a row now points at it — must leave the
  // work list. Without this the reaper would eventually quarantine a live blob.
  const stillOrphaned = new Set(fresh.map((o) => o.path))
  const recovered = await prisma.orphanBlob.findMany({
    where: { state: 'PENDING_DELETE' },
    select: { id: true, storagePath: true },
  })
  const nowReferenced = recovered.filter((r) => !stillOrphaned.has(r.storagePath))
  if (nowReferenced.length > 0) {
    await prisma.orphanBlob.deleteMany({ where: { id: { in: nowReferenced.map((r) => r.id) } } })
  }

  return { totalFiles, referencedCount, orphanCount: fresh.length, bytes, recovered: nowReferenced.length }
}

async function quarantineAged() {
  const cutoff = new Date(Date.now() - (REMEDIATE ? 0 : GRACE_MS))

  const aged = await prisma.orphanBlob.findMany({
    where: { state: 'PENDING_DELETE', firstSeenAt: { lt: cutoff } },
    take: 5000,
  })

  let moved = 0
  for (const blob of aged) {
    const target = `${QUARANTINE_PREFIX}/${blob.storagePath}`
    try {
      const from = resolvePath(blob.storagePath)
      const to = resolvePath(target)
      await fs.mkdir(path.dirname(to), { recursive: true })
      await fs.rename(from, to)

      await prisma.orphanBlob.update({
        where: { id: blob.id },
        data: { state: 'QUARANTINED', quarantinePath: target, quarantinedAt: new Date() },
      })
      moved += 1
    } catch (err) {
      if (err.code === 'ENOENT') {
        // Already gone. That is the outcome we wanted.
        await prisma.orphanBlob.update({
          where: { id: blob.id },
          data: { state: 'DELETED', resolvedAt: new Date() },
        })
        continue
      }
      logger.error({ err, path: blob.storagePath }, 'could not quarantine orphan')
    }
  }

  return { moved, considered: aged.length }
}

async function purgeQuarantined() {
  const cutoff = new Date(Date.now() - QUARANTINE_RETENTION_MS)

  const ripe = await prisma.orphanBlob.findMany({
    where: { state: 'QUARANTINED', quarantinedAt: { lt: cutoff } },
    take: 5000,
  })

  let shredded = 0
  for (const blob of ripe) {
    try {
      await fs.rm(resolvePath(blob.quarantinePath ?? blob.storagePath), { force: true })
      await prisma.orphanBlob.update({
        where: { id: blob.id },
        data: { state: 'DELETED', resolvedAt: new Date() },
      })
      shredded += 1
    } catch (err) {
      logger.error({ err, path: blob.quarantinePath }, 'could not shred quarantined orphan')
    }
  }

  return { shredded, considered: ripe.length }
}

async function main() {
  const { acquired, result } = await withAdvisoryLock(LOCK_NAMESPACE.STORAGE_REAPER, 'storage', async () => {
    console.log('=== storage reaper ===\n')

    const swept = await recordOrphans()
    console.log(`files on disk        ${swept.totalFiles}`)
    console.log(`referenced by a row  ${swept.referencedCount}`)
    console.log(`unreferenced         ${swept.orphanCount}  (${(swept.bytes / 1e6).toFixed(1)} MB)`)
    if (swept.recovered) console.log(`back in use          ${swept.recovered}  (removed from the work list)`)

    const dangling = await findDanglingReferences()
    console.log(`\ndangling references  ${dangling.length}  (a row points at a file that is not there)`)
    for (const p of dangling.slice(0, 10)) console.log(`   ${p}`)
    if (dangling.length > 10) console.log(`   ... and ${dangling.length - 10} more`)

    const byState = await prisma.orphanBlob.groupBy({ by: ['state'], _count: { _all: true } })
    console.log(`\norphan ledger        ${byState.map((r) => `${r.state}=${r._count._all}`).join(' · ') || '(empty)'}`)

    let quarantined = null
    let purged = null

    if (DO_QUARANTINE) {
      quarantined = await quarantineAged()
      console.log(`\nquarantined          ${quarantined.moved} of ${quarantined.considered} aged`)
    }
    if (DO_PURGE) {
      purged = await purgeQuarantined()
      console.log(`shredded             ${purged.shredded} of ${purged.considered} ripe`)
    }

    if (REMEDIATE) {
      // The one-off backlog remediation, recorded. The plan requires the
      // remediation itself to be auditable — "we deleted 265 MB" is not a claim
      // anyone should have to take on trust.
      await writeAuditLog({
        entityType: 'Storage',
        entityId: 'media-root',
        action: 'ORPHAN_BACKLOG_REMEDIATED',
        actorId: null,
        payload: {
          filesOnDisk: swept.totalFiles,
          referenced: swept.referencedCount,
          orphansFound: swept.orphanCount,
          bytes: swept.bytes,
          quarantined: quarantined?.moved ?? 0,
          danglingReferences: dangling.length,
        },
      }).catch((err) => console.log(`(audit row not written: ${err.message.slice(0, 90)})`))
    }

    if (!DO_QUARANTINE && !DO_PURGE) {
      console.log('\n(report only — pass --quarantine, --purge or --remediate to act)')
    }

    return { swept, dangling: dangling.length, quarantined, purged }
  })

  if (!acquired) {
    console.error('another reaper holds the lock')
    process.exitCode = 1
    return
  }
  return result
}

main()
  .catch((err) => {
    console.error('storage reaper failed:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
