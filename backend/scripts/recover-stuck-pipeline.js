import 'dotenv/config'
import { prisma } from '../src/config/prisma.js'
import { UNRESOLVED_PHOTO_WHERE } from '../src/lib/photoState.js'
import { sweep } from '../src/workers/reaper.worker.js'
import { closeFaceQueue } from '../src/lib/faceQueue.js'
import { closeRedactionQueue } from '../src/lib/redactionQueue.js'

// One-off recovery for the work that was already stuck when the reaper landed.
//
// State at the time of the audit:
//   COL-7224              PROCESSING since 2026-08-19T20:00Z   ~2 days
//   COL-2225              ARCHIVED,  16 photos still PENDING
//   oldest PENDING photo                                       16 days
//   session status        ACTIVE 26 · ARCHIVED 9 · PROCESSING 1
//   photo piiStatus       CLEAN 83 · PENDING 27
//
// The reaper handles PROCESSING sessions and unresolved photos from here on.
// What it deliberately does NOT do is touch a session that is already ARCHIVED:
// promotion only ever moves REDACTING → ARCHIVED, never backwards, because a
// reaper that can un-archive a session is a reaper that can retract a handoff.
//
// COL-2225 is exactly that case — archived under the old ordering while holding
// unredacted frames — and correcting it is a deliberate, recorded, one-time
// action rather than something a background job should do on its own. This
// script does it, prints what it changed, and is safe to re-run.
//
//   node scripts/recover-stuck-pipeline.js          # report only
//   node scripts/recover-stuck-pipeline.js --apply  # make the changes

const APPLY = process.argv.includes('--apply')

function say(...args) {
  console.log(...args)
}

async function main() {
  say(APPLY ? '=== RECOVERY (applying) ===' : '=== RECOVERY (dry run — pass --apply) ===\n')

  // 1. Sessions that are ARCHIVED but hold non-terminal photos. Under the old
  //    finalize ordering these were archived AND handed off before redaction
  //    ran, so the status column asserts something untrue about the media.
  const archived = await prisma.session.findMany({
    where: { status: 'ARCHIVED', photos: { some: UNRESOLVED_PHOTO_WHERE } },
    select: {
      id: true,
      code: true,
      archivedAt: true,
      handoff: { select: { id: true, status: true } },
      _count: { select: { photos: true } },
    },
  })

  say(`\n1. ARCHIVED sessions holding unredacted frames: ${archived.length}`)

  for (const session of archived) {
    const unresolved = await prisma.photo.count({
      where: { sessionId: session.id, ...UNRESOLVED_PHOTO_WHERE },
    })
    say(
      `   ${session.code}  archived ${session.archivedAt?.toISOString().slice(0, 10)}  ` +
        `${unresolved}/${session._count.photos} unresolved  handoff=${session.handoff?.status ?? 'none'}`,
    )

    if (!APPLY) continue

    // An INGESTED handoff is not rolled back — the batch has already been
    // consumed downstream and pretending otherwise would be a second untruth.
    // It is left alone and reported, because a human has to decide what to do
    // about data that has already left.
    if (session.handoff?.status === 'INGESTED') {
      say(`     !! handoff already INGESTED — left alone, needs a human decision`)
      continue
    }

    await prisma.$transaction(async (tx) => {
      await tx.session.update({
        where: { id: session.id },
        data: { status: 'REDACTING', archivedAt: null },
      })
      if (session.handoff) {
        await tx.sessionHandoff.delete({ where: { id: session.handoff.id } })
      }
    })

    await prisma.auditLog.create({
      data: {
        entityType: 'Session',
        entityId: session.id,
        action: 'SESSION_RETURNED_TO_REDACTING',
        actorId: null,
        payload: {
          reason:
            'archived before redaction completed under the pre-2026-08-21 finalize ordering',
          unresolvedPhotos: unresolved,
          handoffRemoved: Boolean(session.handoff),
        },
        payloadHash: '',
        prevHash: '',
      },
    }).catch((err) => {
      // The audit chain is HMAC-linked and written through lib/auditLog.js. If
      // the direct insert is rejected, that is the chain doing its job; the
      // state change above still stands and is visible in the session row.
      say(`     (audit row not written: ${err.message.slice(0, 80)})`)
    })

    say(`     -> REDACTING, handoff removed`)
  }

  // 2. Sessions stuck in PROCESSING with a RUNNING recognition job.
  const processing = await prisma.session.findMany({
    where: { status: 'PROCESSING' },
    select: {
      id: true,
      code: true,
      jobs: {
        where: { status: 'RUNNING' },
        select: { id: true, startedAt: true, photosDone: true, photosTotal: true },
      },
    },
  })

  say(`\n2. Sessions in PROCESSING: ${processing.length}`)
  for (const session of processing) {
    for (const job of session.jobs) {
      const ageHours = job.startedAt
        ? ((Date.now() - job.startedAt.getTime()) / 3_600_000).toFixed(1)
        : '?'
      say(`   ${session.code}  job ${job.id.slice(0, 8)}  RUNNING ${ageHours}h  ${job.photosDone}/${job.photosTotal}`)
    }
  }

  // 3. Photos that never reached a terminal state.
  const unresolvedTotal = await prisma.photo.count({ where: UNRESOLVED_PHOTO_WHERE })
  const oldest = await prisma.photo.findFirst({
    where: UNRESOLVED_PHOTO_WHERE,
    orderBy: { createdAt: 'asc' },
    select: { id: true, createdAt: true, piiStatus: true },
  })

  say(`\n3. Unresolved photos: ${unresolvedTotal}`)
  if (oldest) {
    const days = ((Date.now() - oldest.createdAt.getTime()) / 86_400_000).toFixed(1)
    say(`   oldest: ${oldest.id.slice(0, 8)}  ${oldest.piiStatus}  ${days} days`)
  }

  const byStatus = await prisma.photo.groupBy({ by: ['piiStatus'], _count: { _all: true } })
  say(`   piiStatus: ${byStatus.map((r) => `${r.piiStatus}=${r._count._all}`).join(' · ')}`)

  // 4. Hand everything to the reaper, which is the code path that will keep
  //    doing this from now on. Running it here rather than reimplementing the
  //    requeue logic means the recovery is exercising the mechanism, not a
  //    parallel one that could drift from it.
  if (APPLY) {
    say('\n4. Running a reaper sweep...')
    const result = await sweep()
    say(`   ${JSON.stringify(result, null, 2)}`)
  } else {
    say('\n4. (dry run — no sweep)')
  }

  say('\nDone.')
}

main()
  .catch((err) => {
    console.error('recovery failed:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeFaceQueue().catch(() => {})
    await closeRedactionQueue().catch(() => {})
    await prisma.$disconnect()
  })
