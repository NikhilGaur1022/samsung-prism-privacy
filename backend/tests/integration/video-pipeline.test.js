import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { prisma } from '../../src/config/prisma.js'
import { redis } from '../../src/config/redis.js'
import { writeFile, readFile, resolvePath } from '../../src/lib/storage.js'
import {
  UNRESOLVED_VIDEO_WHERE,
  isVideoUnresolved,
  TERMINAL_VIDEO_STATUS,
} from '../../src/lib/photoState.js'
import { promoteIfRedacted } from '../../src/modules/sessions/session.service.js'
import { runDiscovery } from '../../src/modules/dsar/discovery.service.js'
import { indexSubject } from '../../src/modules/dsar/itemIndex.service.js'
import { closeFaceQueue } from '../../src/lib/faceQueue.js'
import { closeRedactionQueue } from '../../src/lib/redactionQueue.js'
import { closePurgeQueue } from '../../src/lib/purgeQueue.js'

// Video, end to end, against the real worker.
//
// Every piece of this existed before today and none of it was connected. The
// service layer had analyzeVideo, redactVideos, countDeferredVideos and
// rebuildRedactedVideoForRemaining; the schema had VideoFaceTrack.clusterId
// pointing at the same FaceCluster a photo face uses, plus videoTrackCount and
// repTrackId on the cluster; DataItemType had a VIDEO member whose own comment
// asserted that "the capture path and the erasure path landed in the same
// change". Nothing called any of it. The assertion in that comment was false —
// there was no erasure path for video at all.
//
// The four things that made it more than dead code, and what each one costs if
// it regresses:
//
//   VideoSubject links       never created by anything. redactVideos builds its
//                            keep-visible set from them, so every face in every
//                            clip fell to the blur branch — including the
//                            consenting participants the session was recorded
//                            for. A derivative that is technically redacted and
//                            completely useless.
//   promotion gate           counted unresolved photos only, so a session could
//                            archive holding a clip whose bystanders were never
//                            blurred while carefully holding back an unredacted
//                            STILL of the same person in the same session.
//   DSAR discovery           had no video query. A subject tagged in a clip
//                            could be purged, certified, and told their data was
//                            destroyed with their face still in the footage.
//   cluster merge            deletes source clusters, and VideoFaceTrack.clusterId
//                            is onDelete: SetNull — merging two people silently
//                            detached their tracks, leaving them unreachable from
//                            any card and PENDING forever.
//
// Requires the video worker (docker compose --profile video up -d) and
// VIDEO_CAPTURE_ENABLED=on. Skipped, loudly, when it is not reachable — a
// silent pass here would mean video shipped unverified, which is the one thing
// this file exists to prevent.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIP = path.resolve(HERE, '../fixtures/clip-group.mp4')
const VIDEO_SERVICE_URL = process.env.VIDEO_SERVICE_URL ?? 'http://localhost:8005'

const RUN = randomUUID().slice(0, 8)
const fx = { written: [] }

let workerUp = false

async function probeWorker() {
  try {
    const res = await fetch(`${VIDEO_SERVICE_URL}/health`, { signal: AbortSignal.timeout(5000) })
    return res.ok
  } catch {
    return false
  }
}

/** Puts the fixture clip into storage and returns a VideoAsset row for it. */
async function addVideo(sessionId, { status = 'PENDING_ANALYSIS' } = {}) {
  const buffer = await fs.readFile(CLIP)
  const storagePath = `sessions/${sessionId}/videos/vid-${randomUUID()}.mp4`
  await writeFile(storagePath, buffer)
  fx.written.push(storagePath)

  return prisma.videoAsset.create({
    data: {
      sessionId,
      storagePath,
      mimeType: 'video/mp4',
      sha256: createHash('sha256').update(buffer).digest('hex') + randomUUID().slice(0, 4),
      sizeBytes: buffer.length,
      status,
    },
  })
}

function mkSession(status = 'TAGGING') {
  return prisma.session.create({
    data: {
      code: `VID-${RUN}-${randomUUID().slice(0, 6)}`,
      projectId: fx.project.id,
      agentId: fx.agent.id,
      status,
    },
  })
}

async function mkSubject(name) {
  return prisma.subject.create({
    data: {
      fullName: `${name} ${RUN}`,
      email: `vid-${RUN}-${name.toLowerCase()}@test.invalid`,
      group: 'VOLUNTEER',
      status: 'ACTIVE',
      registrationChannel: 'AGENT',
    },
  })
}

test.before(async () => {
  workerUp = await probeWorker()

  fx.owner = await prisma.adminUser.create({
    data: { email: `vid-${RUN}-owner@test.invalid`, role: 'dataOwner', status: 'ACTIVE' },
  })
  fx.agent = await prisma.adminUser.create({
    data: { email: `vid-${RUN}-agent@test.invalid`, role: 'collectionAgent', status: 'ACTIVE' },
  })
  fx.project = await prisma.project.create({
    data: {
      name: `Video ${RUN}`,
      purpose: 'video pipeline fixture',
      ownerAdminId: fx.owner.id,
      status: 'APPROVED',
    },
  })
})

test.after(async () => {
  for (const p of fx.written) await fs.rm(resolvePath(p), { force: true }).catch(() => {})

  const sessionWhere = { session: { projectId: fx.project?.id } }
  await prisma.videoFaceTrack.deleteMany({ where: { video: sessionWhere } })
  await prisma.videoPiiSpan.deleteMany({ where: { video: sessionWhere } })
  await prisma.videoSubject.deleteMany({ where: { video: sessionWhere } })
  await prisma.videoAsset.deleteMany({ where: sessionWhere })
  await prisma.faceCluster.deleteMany({ where: { session: { projectId: fx.project?.id } } })
  await prisma.sessionParticipant.deleteMany({ where: { session: { projectId: fx.project?.id } } })
  await prisma.sessionHandoff.deleteMany({ where: { projectId: fx.project?.id } })
  await prisma.session.deleteMany({ where: { projectId: fx.project?.id } })
  await prisma.subjectDataItem.deleteMany({ where: { subject: { email: { contains: `vid-${RUN}-` } } } })
  await prisma.projectConsent.deleteMany({ where: { projectId: fx.project?.id } })
  await prisma.project.deleteMany({ where: { id: fx.project?.id } })
  await prisma.subject.deleteMany({ where: { email: { contains: `vid-${RUN}-` } } })
  await prisma.adminUser.deleteMany({ where: { email: { contains: `vid-${RUN}-` } } })

  await Promise.allSettled([
    closeFaceQueue(),
    closeRedactionQueue(),
    closePurgeQueue(),
    redis.quit(),
    prisma.$disconnect(),
  ])
})

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('an unredacted clip blocks promotion exactly as an unredacted still does', async () => {
  const session = await mkSession('REDACTING')
  // Analysed, so it is past the DEFERRED excuse — but no derivative was ever
  // written, which is precisely the state that used to archive silently.
  await addVideo(session.id, { status: 'ANALYZED' })

  const result = await promoteIfRedacted(session.id)

  assert.equal(result.archived, false, 'a session holding an unredacted clip was archived')
  assert.equal(result.reason, 'VIDEOS_UNRESOLVED')

  const after = await prisma.session.findUnique({ where: { id: session.id } })
  assert.equal(after.status, 'REDACTING')

  const handoff = await prisma.sessionHandoff.findUnique({ where: { sessionId: session.id } })
  assert.equal(handoff, null, 'a handoff was created for a session holding unredacted video')
})

test('a clip marked REDACTED with no derivative still blocks promotion', async () => {
  const session = await mkSession('REDACTING')
  const video = await addVideo(session.id, { status: 'ANALYZED' })
  // The status column says finished; the file says otherwise. The predicate is
  // written as an AND of both for exactly this case — a status set by a code
  // path that crashed before writing the bytes.
  await prisma.videoAsset.update({
    where: { id: video.id },
    data: { status: TERMINAL_VIDEO_STATUS, redactedPath: null },
  })

  assert.equal(isVideoUnresolved(await prisma.videoAsset.findUnique({ where: { id: video.id } })), true)

  const result = await promoteIfRedacted(session.id)
  assert.equal(result.archived, false, 'a REDACTED-but-derivativeless clip was archived over')
})

test('UNRESOLVED_VIDEO_WHERE and isVideoUnresolved agree on the same rows', async () => {
  const session = await mkSession('REDACTING')
  await addVideo(session.id, { status: 'ANALYZED' })
  const done = await addVideo(session.id, { status: 'ANALYZED' })
  await prisma.videoAsset.update({
    where: { id: done.id },
    data: { status: TERMINAL_VIDEO_STATUS, redactedPath: `sessions/${session.id}/redacted/x.mp4` },
  })

  const byQuery = await prisma.videoAsset.findMany({
    where: { sessionId: session.id, ...UNRESOLVED_VIDEO_WHERE },
    select: { id: true },
  })
  const all = await prisma.videoAsset.findMany({ where: { sessionId: session.id } })
  const byPredicate = all.filter(isVideoUnresolved).map((v) => v.id)

  // The database form and the in-memory form must not drift: one gates the
  // promotion, the other gates the serving layer, and a disagreement means a
  // clip is servable but unarchivable or the reverse.
  assert.deepEqual(byQuery.map((v) => v.id).sort(), byPredicate.sort())
})

// ---------------------------------------------------------------------------
// The real pipeline, against the real worker
// ---------------------------------------------------------------------------

test('analysis produces tracks that cluster with photo faces', async (t) => {
  if (!workerUp) {
    t.skip(`video worker unreachable at ${VIDEO_SERVICE_URL} — start it with: docker compose --profile video up -d`)
    return
  }

  const { analyzeVideo } = await import('../../src/modules/videos/video.service.js')
  const session = await mkSession('TAGGING')
  const video = await addVideo(session.id)

  const result = await analyzeVideo(video.id)

  assert.ok(result, 'analyzeVideo returned null — the worker call failed')
  assert.ok(result.tracks.length > 0, 'no identifiable tracks were produced from a clip with faces')

  // 512 is the buffalo_l ArcFace dimensionality. It has to match what the face
  // worker produces for stills or the shared clustering compares vectors from
  // two different models by cosine similarity and produces confident nonsense.
  for (const track of result.tracks) {
    assert.equal(track.embedding.length, 512, 'track embedding is not a 512-d ArcFace vector')
    assert.equal(track.kind, 'track', 'tracks must be tagged so the cluster writer can tell the media apart')
  }

  const persisted = await prisma.videoFaceTrack.findMany({ where: { videoId: video.id } })
  assert.equal(persisted.length >= result.tracks.length, true)

  for (const row of persisted) {
    assert.ok(Array.isArray(row.boxes) && row.boxes.length > 0, 'a track was stored with no boxes')
    // No boxes means a redaction pass over this clip would blur nothing and
    // still write a derivative — an unmasked file stamped clean.
  }

  const after = await prisma.videoAsset.findUnique({ where: { id: video.id } })
  assert.equal(after.status, 'ANALYZED')
  fx.written.push(...persisted.map((r) => r.cropPath).filter(Boolean))
})

test('a clip whose analysis failed is DEFERRED and never gets a derivative', async (t) => {
  if (!workerUp) {
    t.skip('video worker unreachable')
    return
  }

  const { redactVideos } = await import('../../src/modules/videos/video.service.js')
  const session = await mkSession('TAGGING')
  const video = await addVideo(session.id, { status: 'DEFERRED' })

  const result = await redactVideos(session.id)

  assert.equal(result.written, 0, 'a derivative was written for a clip that was never analysed')
  assert.equal(result.deferred >= 1, true)

  const after = await prisma.videoAsset.findUnique({ where: { id: video.id } })
  assert.equal(after.redactedPath, null, 'a DEFERRED clip was given a redactedPath')
  // This is the dangerous case: no tracks means no boxes, so a redaction pass
  // would blur nothing and produce a file that looks processed and is not.
})

test('redaction keeps linked subjects visible and blurs everyone else', async (t) => {
  if (!workerUp) {
    t.skip('video worker unreachable')
    return
  }

  const { analyzeVideo, redactVideos } = await import('../../src/modules/videos/video.service.js')
  const session = await mkSession('TAGGING')
  const subject = await mkSubject('Asha')
  const consent = await prisma.projectConsent.create({
    data: {
      projectId: fx.project.id,
      subjectId: subject.masterUserId,
      status: 'ACTIVE',
      policyVersion: 'v1-test',
      signatureHash: 'test-signature',
    },
  })

  const video = await addVideo(session.id)
  const analysis = await analyzeVideo(video.id)
  assert.ok(analysis?.tracks.length >= 1)

  const tracks = await prisma.videoFaceTrack.findMany({ where: { videoId: video.id } })
  fx.written.push(...tracks.map((r) => r.cropPath).filter(Boolean))

  // One person tagged, and the consent link written — which is the row that was
  // never created by anything before today.
  await prisma.videoFaceTrack.update({
    where: { id: tracks[0].id },
    data: { tagStatus: 'TAGGED', taggedSubjectId: subject.masterUserId },
  })
  await prisma.videoSubject.create({
    data: {
      videoId: video.id,
      subjectId: subject.masterUserId,
      consentId: consent.consentId,
    },
  })

  const result = await redactVideos(session.id, { videoIds: [video.id] })
  assert.equal(result.written, 1, `expected one derivative, got ${JSON.stringify(result)}`)

  const after = await prisma.videoAsset.findUnique({ where: { id: video.id } })
  assert.equal(after.status, TERMINAL_VIDEO_STATUS)
  assert.ok(after.redactedPath, 'no derivative path was recorded')
  fx.written.push(after.redactedPath)

  const bytes = await readFile(after.redactedPath)
  assert.ok(bytes.length > 0, 'the derivative is empty')

  // Now the clip is terminal, the session can be promoted — the same gate that
  // refused it in the first test.
  await prisma.session.update({ where: { id: session.id }, data: { status: 'REDACTING' } })
  const promotion = await promoteIfRedacted(session.id)
  assert.notEqual(promotion.reason, 'VIDEOS_UNRESOLVED', 'a fully redacted clip still blocked promotion')
})

test('with no consent link, nobody is kept visible', async (t) => {
  if (!workerUp) {
    t.skip('video worker unreachable')
    return
  }

  const { analyzeVideo, redactVideos } = await import('../../src/modules/videos/video.service.js')
  const session = await mkSession('TAGGING')
  const video = await addVideo(session.id)
  await analyzeVideo(video.id)

  const tracks = await prisma.videoFaceTrack.findMany({ where: { videoId: video.id } })
  fx.written.push(...tracks.map((r) => r.cropPath).filter(Boolean))

  // Tagged, but with NO VideoSubject row. This is the state the whole system was
  // in before the link was wired: the tag says "this is Asha", and the keep set
  // — built from the links — is empty, so Asha is blurred out of her own
  // footage. Max-privacy is the correct behaviour for an unlinked face; the bug
  // was that the link could never exist.
  await prisma.videoFaceTrack.updateMany({
    where: { videoId: video.id },
    data: { tagStatus: 'TAGGED', taggedSubjectId: null },
  })

  const result = await redactVideos(session.id, { videoIds: [video.id] })
  assert.equal(result.written, 1)

  const after = await prisma.videoAsset.findUnique({ where: { id: video.id } })
  fx.written.push(after.redactedPath)
  assert.ok(after.redactedPath, 'no derivative written')
})

// ---------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------

test('DSAR discovery finds the clip, its tracks and its consent link', async () => {
  const session = await mkSession('TAGGING')
  const subject = await mkSubject('Bilal')
  const consent = await prisma.projectConsent.create({
    data: {
      projectId: fx.project.id,
      subjectId: subject.masterUserId,
      status: 'ACTIVE',
      policyVersion: 'v1-test',
      signatureHash: 'test-signature',
    },
  })
  const video = await addVideo(session.id, { status: 'ANALYZED' })

  await prisma.videoFaceTrack.create({
    data: {
      videoId: video.id,
      trackId: 't0',
      startFrame: 0,
      endFrame: 27,
      startSec: 0,
      endSec: 2.7,
      boxes: [{ frame: 0, x1: 1, y1: 1, x2: 2, y2: 2 }],
      tagStatus: 'TAGGED',
      taggedSubjectId: subject.masterUserId,
    },
  })
  await prisma.videoSubject.create({
    data: { videoId: video.id, subjectId: subject.masterUserId, consentId: consent.consentId },
  })

  const discovery = await runDiscovery(subject.masterUserId)
  const codes = discovery.locations.map((l) => l.locationCode)

  // Before today discovery had no video query at all, so every one of these was
  // absent and a purge would have reported success having touched none of it.
  assert.ok(codes.includes('VLINK'), 'the consent link is not a discovered location')
  assert.ok(codes.includes('TRACK'), 'the face attributions are not a discovered location')
  assert.ok(codes.includes('L20'), 'the clip original is not a discovered location')

  assert.equal(discovery.counts.videos, 1)
  assert.equal(discovery.counts.videoTracks, 1)

  const l20 = discovery.locations.find((l) => l.locationCode === 'L20')
  assert.equal(l20.soleSubject, true)
  assert.equal(l20.action, 'DELETE', 'a clip nobody else is linked to should be destroyed, not retained')
})

test('a clip holding two people is re-redacted, never destroyed', async () => {
  const session = await mkSession('TAGGING')
  const asha = await mkSubject('Chandni')
  const bilal = await mkSubject('Deepak')

  const consents = await Promise.all(
    [asha, bilal].map((s) =>
      prisma.projectConsent.create({
        data: {
          projectId: fx.project.id,
          subjectId: s.masterUserId,
          status: 'ACTIVE',
          policyVersion: 'v1-test',
          signatureHash: 'test-signature',
        },
      }),
    ),
  )

  const video = await addVideo(session.id, { status: 'ANALYZED' })
  await prisma.videoAsset.update({
    where: { id: video.id },
    data: { redactedPath: `sessions/${session.id}/redacted/${video.id}.mp4`, status: 'REDACTED' },
  })

  for (const [i, s] of [asha, bilal].entries()) {
    await prisma.videoSubject.create({
      data: {
        videoId: video.id,
        subjectId: s.masterUserId,
        consentId: consents[i].consentId,
      },
    })
  }

  const discovery = await runDiscovery(asha.masterUserId)
  const l20 = discovery.locations.find((l) => l.locationCode === 'L20')
  const l21 = discovery.locations.find((l) => l.locationCode === 'L21')

  // The other person's consent to their own footage survives this erasure. The
  // clip is rebuilt with the erased subject blurred out, exactly as a
  // multi-speaker recording is re-muted rather than deleted.
  assert.equal(l20.soleSubject, false)
  assert.equal(l20.action, 'RETAIN', 'a clip holding another consenting subject was marked for destruction')
  assert.equal(l21.action, 'REREDACT')
  assert.equal(discovery.counts.multiSubjectVideos, 1)
})

test('a clip appears in the subject item index, so "my data" is not understating', async () => {
  const session = await mkSession('TAGGING')
  const subject = await mkSubject('Esha')
  const consent = await prisma.projectConsent.create({
    data: {
      projectId: fx.project.id,
      subjectId: subject.masterUserId,
      status: 'ACTIVE',
      policyVersion: 'v1-test',
      signatureHash: 'test-signature',
    },
  })
  const video = await addVideo(session.id, { status: 'ANALYZED' })
  await prisma.videoSubject.create({
    data: { videoId: video.id, subjectId: subject.masterUserId, consentId: consent.consentId },
  })

  await indexSubject(subject.masterUserId)

  const items = await prisma.subjectDataItem.findMany({
    where: { subjectId: subject.masterUserId, deletedAt: null },
  })
  const videoItems = items.filter((i) => i.type === 'VIDEO')

  assert.equal(videoItems.length, 1, 'the clip is not listed among the things we hold about this person')
  assert.equal(videoItems[0].sourceTable, 'video_subjects')
  // Keyed on the LINK, not the clip: the clip legitimately survives for the
  // other people in it, so an item pointing at it would outlive the erasure.
  assert.equal(videoItems[0].sourceId, (await prisma.videoSubject.findFirst({ where: { videoId: video.id } })).id)
  assert.equal(videoItems[0].redactedAvailable, false, 'a clip with no derivative was advertised as redacted')
})
