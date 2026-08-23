import 'dotenv/config'
import { prisma } from '../src/config/prisma.js'
import { findOrphans, findDanglingReferences } from '../src/lib/storageSweep.js'
import { UNRESOLVED_PHOTO_WHERE } from '../src/lib/photoState.js'

// The check that has to be green before anyone signs off on this system.
//
// Every number here corresponds to a class of silent failure that the audit
// reproduced against the running stack, and every one of them was invisible to
// the existing tests because those tests read rows and the failures live at the
// filesystem boundary.
//
// Exit code is the point: 0 means clean, 1 means something is wrong. Wire it
// into CI and into the go-live gate.
//
//   node scripts/integrity-check.js
//   node scripts/integrity-check.js --json

const JSON_OUT = process.argv.includes('--json')

const checks = []
const add = (name, ok, detail, count = null) => checks.push({ name, ok, detail, count })

async function main() {
  // 1. Orphan blobs — files on disk no row references.
  const { orphans, totalFiles, referencedCount, bytes } = await findOrphans()
  const quarantined = orphans.filter((o) => o.path.startsWith('_quarantine/'))
  const live = orphans.filter((o) => !o.path.startsWith('_quarantine/'))

  add(
    'orphan-blobs',
    live.length === 0,
    live.length === 0
      ? `${totalFiles} files, all ${referencedCount} referenced (${quarantined.length} in quarantine)`
      : `${live.length} unreferenced file(s), ${(bytes / 1e6).toFixed(1)} MB — invisible to DSAR discovery and unreachable by purge`,
    live.length,
  )

  // 2. Dangling references — rows pointing at files that are not there.
  const dangling = await findDanglingReferences()
  add(
    'dangling-references',
    dangling.length === 0,
    dangling.length === 0
      ? 'every referenced path exists on disk'
      : `${dangling.length} row(s) point at a file that is not in storage — a package build would ship short`,
    dangling.length,
  )

  // 3. The DSAR index specifically. 88 of the 91 SubjectDataItem rows pointed at
  //    files that were gone, while totals.all — the completeness claim the grid
  //    renders — counted them.
  const indexRows = await prisma.subjectDataItem.findMany({
    where: { storagePath: { not: null }, deletedAt: null },
    select: { id: true, storagePath: true },
  })
  const danglingSet = new Set(dangling)
  const brokenIndex = indexRows.filter((r) => danglingSet.has(r.storagePath.replace(/\\/g, '/')))
  add(
    'dsar-index-integrity',
    brokenIndex.length === 0,
    brokenIndex.length === 0
      ? `${indexRows.length} indexed items all resolvable`
      : `${brokenIndex.length} of ${indexRows.length} indexed items cannot be produced — totals.all is claiming more than exists`,
    brokenIndex.length,
  )

  // 4. Sessions asserting something untrue about their media.
  const archivedUnredacted = await prisma.session.count({
    where: { status: 'ARCHIVED', photos: { some: UNRESOLVED_PHOTO_WHERE } },
  })
  add(
    'archived-sessions-are-redacted',
    archivedUnredacted === 0,
    archivedUnredacted === 0
      ? 'no ARCHIVED session holds a non-terminal photo'
      : `${archivedUnredacted} ARCHIVED session(s) hold unredacted frames — the status column is asserting something false`,
    archivedUnredacted,
  )

  // 5. Handoffs that cannot lawfully be ingested.
  const blockedHandoffs = await prisma.sessionHandoff.count({
    where: { status: 'PENDING_INGEST', session: { photos: { some: UNRESOLVED_PHOTO_WHERE } } },
  })
  add(
    'handoffs-ingestable',
    blockedHandoffs === 0,
    blockedHandoffs === 0
      ? 'every pending handoff is fully masked'
      : `${blockedHandoffs} pending handoff(s) contain unmasked frames`,
    blockedHandoffs,
  )

  // 6. Work that stopped and nothing noticed.
  const unresolvedPhotos = await prisma.photo.count({ where: UNRESOLVED_PHOTO_WHERE })
  const oldest = await prisma.photo.findFirst({
    where: UNRESOLVED_PHOTO_WHERE,
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  })
  const oldestDays = oldest ? (Date.now() - oldest.createdAt.getTime()) / 86_400_000 : 0
  add(
    'no-stale-unresolved-photos',
    oldestDays < 1,
    unresolvedPhotos === 0
      ? 'every photo is terminal'
      : `${unresolvedPhotos} unresolved photo(s), oldest ${oldestDays.toFixed(1)} days`,
    unresolvedPhotos,
  )

  const stuckRecognition = await prisma.recognitionJob.count({
    where: { status: 'RUNNING', startedAt: { lt: new Date(Date.now() - 60 * 60_000) } },
  })
  add(
    'no-stuck-recognition-jobs',
    stuckRecognition === 0,
    stuckRecognition === 0 ? 'no job RUNNING over an hour' : `${stuckRecognition} job(s) RUNNING over an hour`,
    stuckRecognition,
  )

  // 7. Relational integrity. Clean at audit time and worth keeping that way,
  //    since a regression here is invisible until a DSAR walk hits it.
  const [facesNoPhoto, linksNoPhoto, photosNoSession, linksNoConsent] = await Promise.all([
    // Quoted camelCase identifiers: these columns carry no @map, so Postgres
    // holds them case-sensitively and an unquoted `photo_id` does not exist.
    prisma.$queryRawUnsafe(
      'SELECT count(*)::int AS n FROM face_detections f LEFT JOIN photos p ON p.id = f."photoId" WHERE p.id IS NULL',
    ),
    prisma.$queryRawUnsafe(
      'SELECT count(*)::int AS n FROM photo_subjects s LEFT JOIN photos p ON p.id = s."photoId" WHERE p.id IS NULL',
    ),
    prisma.$queryRawUnsafe(
      'SELECT count(*)::int AS n FROM photos WHERE "sessionId" IS NULL',
    ),
    // Reported on its own line below rather than folded in — a null consentId is
    // legal on an IMPORT link and illegal on a collected one, so the count alone
    // is not a verdict.
    prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n
         FROM photo_subjects ps
         JOIN subject_data_items sdi ON sdi.source_id = ps.id
        WHERE ps."consentId" IS NULL AND sdi.origin = 'COLLECTION_SESSION'`,
    ),
  ])
  const relationalOrphans = facesNoPhoto[0].n + linksNoPhoto[0].n + photosNoSession[0].n
  add(
    'relational-orphans',
    relationalOrphans === 0,
    relationalOrphans === 0
      ? 'zero orphans across every join'
      : `${relationalOrphans} relational orphan(s)`,
    relationalOrphans,
  )

  // A photo-to-person link with no consent id, on a photo that was COLLECTED
  // rather than imported, is a frame held with no recorded lawful basis.
  // finalizeSession refuses to write one, so any that exist predate that guard
  // and need a basis attached or the link removed — neither is something a
  // script should decide.
  add(
    'collected-links-have-consent',
    linksNoConsent[0].n === 0,
    linksNoConsent[0].n === 0
      ? 'every collected photo-subject link carries a consent id'
      : `${linksNoConsent[0].n} collected link(s) have no consent id — a frame held with no recorded lawful basis`,
    linksNoConsent[0].n,
  )

  // ---- report -------------------------------------------------------------
  const failed = checks.filter((c) => !c.ok)

  if (JSON_OUT) {
    console.log(JSON.stringify({ checks, ok: failed.length === 0 }, null, 2))
  } else {
    const width = Math.max(...checks.map((c) => c.name.length))
    for (const c of checks) {
      console.log(`[${c.ok ? '  ok  ' : ' FAIL '}] ${c.name.padEnd(width)}  ${c.detail}`)
    }
    console.log(
      `\n${checks.length} checks — ${checks.length - failed.length} passed, ${failed.length} failed`,
    )
    console.log(failed.length === 0 ? 'integrity: GREEN' : 'integrity: RED')
  }

  process.exitCode = failed.length === 0 ? 0 : 1
}

main()
  .catch((err) => {
    console.error('integrity check crashed:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
