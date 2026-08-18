import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { prisma } from '../../src/config/prisma.js'
import { indexSubject, indexRecording } from '../../src/modules/dsar/itemIndex.service.js'
import { runDiscovery } from '../../src/modules/dsar/discovery.service.js'
import { createPurgeJob, executePurgeJob } from '../../src/modules/dsar/purge.service.js'
import { writeFile, fileExists } from '../../src/lib/storage.js'
import { closeRedactionQueue } from '../../src/lib/redactionQueue.js'
import { closePurgeQueue } from '../../src/lib/purgeQueue.js'

// The regression suite for the hole this phase closed.
//
// Audio shipped with a capture path and no erasure path: `DataItemType` had only
// PHOTO, `runDiscovery()` never walked `recordings`, and `purge.service.js` had
// no handler that could reach one. So an ERASE completed, destroyed the
// per-subject DEK, and signed an Ed25519 deletion certificate — while the
// recording sat intact under the session key. The certificate was a false
// statement, which is the one failure mode this platform cannot have.
//
// Every assertion below is about that. In priority order:
//
//   * an analysed recording appears in the item index as an AUDIO item, for
//     every speaker it identified and for nobody else;
//   * discovery names it (SEGMENT + L14, and L15 when a derivative exists);
//   * a sole-speaker recording is destroyed — row gone, bytes gone;
//   * a shared recording SURVIVES for the other speaker, with the erasing
//     subject's attribution stripped and their spans flipped to REDACT_VOICE;
//   * the L15 re-mute fails CLOSED when the audio worker is unreachable: the
//     stale derivative — which still carries the erased voice — is retracted,
//     and the job goes PARTIAL rather than reporting a clean erasure.
//
// DB-only apart from that last one. The audio worker is deliberately NOT
// required: the point of the fail-closed assertion is what happens when it is
// down, which is the state this suite runs in.
//   node --test tests/integration/dsar-audio-erasure.test.js

const RUN = randomUUID().slice(0, 8)

const ids = {
  admin: randomUUID(),
  project: randomUUID(),
  session: randomUUID(),
  erasing: randomUUID(),
  cospeaker: randomUUID(),
  soloRecording: randomUUID(),
  sharedRecording: randomUUID(),
  request: randomUUID(),
}

const dataAdmin = { id: ids.admin, role: 'dataAdmin' }

// Real bytes on disk, so "the file is gone" is a fact about the filesystem and
// not about a row that pointed at nothing to begin with.
const AUDIO_BYTES = Buffer.from('RIFF....WAVEfmt fake pcm payload for erasure test', 'utf8')

async function seedSubject(masterUserId, name) {
  await prisma.subject.create({
    data: {
      masterUserId,
      group: 'VOLUNTEER',
      status: 'ACTIVE',
      fullName: `${RUN} ${name}`,
      email: `${name.toLowerCase()}-${RUN}@audioerasure.test`,
      registrationChannel: 'AGENT',
    },
  })
  return prisma.projectConsent.create({
    data: {
      subjectId: masterUserId,
      projectId: ids.project,
      status: 'ACTIVE',
      policyVersion: 'v1',
      signatureHash: 'test',
    },
  })
}

function pathsFor(recordingId) {
  return {
    original: `sessions/${ids.session}/audio/${recordingId}.wav`,
    redacted: `sessions/${ids.session}/audio/${recordingId}.redacted.wav`,
  }
}

async function seedRecording(id, speakers, { withDerivative }) {
  const { original, redacted } = pathsFor(id)
  await writeFile(original, AUDIO_BYTES)
  if (withDerivative) await writeFile(redacted, AUDIO_BYTES)

  await prisma.recording.create({
    data: {
      id,
      sessionId: ids.session,
      storagePath: original,
      redactedPath: withDerivative ? redacted : null,
      status: withDerivative ? 'REDACTED' : 'ANALYZED',
      mimeType: 'audio/wav',
      sha256: `${RUN}-${id}`,
      sizeBytes: AUDIO_BYTES.length,
      durationSec: 60,
    },
  })

  let at = 0
  for (const { subjectId, consentId } of speakers) {
    await prisma.audioSegment.create({
      data: {
        recordingId: id,
        speakerId: `SPEAKER_0${at}`,
        subjectId,
        consentId,
        startSec: at * 10,
        endSec: at * 10 + 8,
        action: 'KEEP',
        matchScore: 0.91,
      },
    })
    at += 1
  }

  // One unattributed PII span, to prove redaction metadata with no subject on it
  // is never mistaken for a second speaker.
  await prisma.audioSegment.create({
    data: {
      recordingId: id,
      speakerId: 'SPEAKER_00',
      startSec: 30,
      endSec: 31.5,
      action: 'REDACT_PII',
    },
  })
}

test.before(async () => {
  await prisma.adminUser.create({
    data: { id: ids.admin, email: `admin-${RUN}@audioerasure.test`, role: 'dataAdmin', status: 'ACTIVE' },
  })
  await prisma.project.create({
    data: {
      id: ids.project,
      name: `audio-erasure ${RUN}`,
      purpose: 'testing',
      status: 'ACTIVE',
      ownerAdminId: ids.admin,
    },
  })

  const erasingConsent = await seedSubject(ids.erasing, 'Kavya')
  const cospeakerConsent = await seedSubject(ids.cospeaker, 'Rohit')

  await prisma.session.create({
    data: {
      id: ids.session,
      code: `AU-${randomUUID().slice(0, 8)}`,
      projectId: ids.project,
      agentId: ids.admin,
      status: 'ARCHIVED',
    },
  })

  await seedRecording(
    ids.soloRecording,
    [{ subjectId: ids.erasing, consentId: erasingConsent.consentId }],
    { withDerivative: false },
  )
  await seedRecording(
    ids.sharedRecording,
    [
      { subjectId: ids.erasing, consentId: erasingConsent.consentId },
      { subjectId: ids.cospeaker, consentId: cospeakerConsent.consentId },
    ],
    { withDerivative: true },
  )

  await prisma.dsarRequest.create({
    data: {
      id: ids.request,
      subjectId: ids.erasing,
      type: 'ERASE',
      status: 'DISCOVERY',
      channel: 'PORTAL',
      slaDueAt: new Date(Date.now() + 30 * 86_400_000),
    },
  })

  await indexSubject(ids.erasing)
  await indexSubject(ids.cospeaker)
})

test.after(async () => {
  try {
    await prisma.dsarRequest.deleteMany({ where: { id: ids.request } })
    await prisma.recording.deleteMany({ where: { sessionId: ids.session } })
    await prisma.subject.deleteMany({
      where: { masterUserId: { in: [ids.erasing, ids.cospeaker] } },
    })
    await prisma.session.deleteMany({ where: { id: ids.session } })
    await prisma.project.deleteMany({ where: { id: ids.project } })
    await prisma.adminUser.deleteMany({ where: { id: ids.admin } })
  } finally {
    await Promise.allSettled([closeRedactionQueue(), closePurgeQueue()])
    await prisma.$disconnect()
  }
})

test('an analysed recording enters the item index as an AUDIO item', async () => {
  const items = await prisma.subjectDataItem.findMany({
    where: { subjectId: ids.erasing, type: 'AUDIO', deletedAt: null },
  })

  assert.equal(items.length, 2, 'both recordings this subject speaks in should be indexed')
  assert.ok(
    items.every((i) => i.sourceTable === 'recordings'),
    'an AUDIO item is keyed on the recording, not on individual segments',
  )

  const solo = items.find((i) => i.sourceId === ids.soloRecording)
  const shared = items.find((i) => i.sourceId === ids.sharedRecording)

  assert.equal(solo.sharedSubjectCount, 1, 'one identified speaker')
  assert.equal(
    shared.sharedSubjectCount,
    2,
    'two identified speakers — this is what downgrades a DELETE to a mute',
  )
  assert.equal(
    solo.redactedAvailable,
    false,
    'ANALYZED is not REDACTED — no confirmed derivative exists yet',
  )
  assert.equal(shared.redactedAvailable, true)
  assert.equal(shared.meta.lawfulBasis, 'CONSENT')
})

test('an unattributed PII span is not counted as a second speaker', async () => {
  const solo = await prisma.subjectDataItem.findFirst({
    where: { subjectId: ids.erasing, sourceId: ids.soloRecording, type: 'AUDIO' },
  })
  // The fixture puts a REDACT_PII segment with no subjectId on every recording.
  // Counting it would report two principals on a one-person recording and block
  // a lawful delete.
  assert.equal(solo.sharedSubjectCount, 1)
})

test('discovery names the recording, its derivative and its attributions', async () => {
  const discovery = await runDiscovery(ids.erasing)
  const codes = discovery.locations.map((l) => l.locationCode)

  assert.ok(codes.includes('SEGMENT'), 'voice attributions must be a location')
  assert.ok(codes.includes('L14'), 'recording originals must be a location')
  assert.ok(codes.includes('L15'), 'the muted derivative must be a location')

  assert.equal(discovery.counts.recordings, 2)
  assert.equal(discovery.counts.multiSpeakerRecordings, 1)

  const solo = discovery.locations.find(
    (l) => l.locationCode === 'L14' && l.objectId === ids.soloRecording,
  )
  const shared = discovery.locations.find(
    (l) => l.locationCode === 'L14' && l.objectId === ids.sharedRecording,
  )

  assert.equal(solo.action, 'DELETE', 'sole speaker — the recording goes')
  assert.equal(shared.action, 'MUTE_SPEAKER', 'shared — the other speaker keeps theirs')
  assert.equal(solo.present, true, 'the walk must confirm the bytes are really there')
})

test('a sole-speaker recording is destroyed, bytes and row', async () => {
  const job = await createPurgeJob(ids.request, dataAdmin)
  await executePurgeJob(job.id, { admin: dataAdmin })

  const row = await prisma.recording.findUnique({ where: { id: ids.soloRecording } })
  assert.equal(row, null, 'the Recording row must be gone')

  const { original } = pathsFor(ids.soloRecording)
  assert.equal(await fileExists(original), false, 'the audio must be gone from disk')
})

test('a shared recording survives for the other speaker, stripped of the erased one', async () => {
  const row = await prisma.recording.findUnique({ where: { id: ids.sharedRecording } })
  assert.ok(row, 'the co-speaker is still entitled to this recording')

  const { original } = pathsFor(ids.sharedRecording)
  assert.equal(await fileExists(original), true, 'the original is the source of every future re-mute')

  const mine = await prisma.audioSegment.findMany({
    where: { recordingId: ids.sharedRecording, subjectId: ids.erasing },
  })
  assert.equal(mine.length, 0, 'nothing may still attribute this voice to the erased subject')

  const theirs = await prisma.audioSegment.findMany({
    where: { recordingId: ids.sharedRecording, subjectId: ids.cospeaker },
  })
  assert.equal(theirs.length, 1, "the co-speaker's own attribution is untouched")
  assert.equal(theirs[0].action, 'KEEP')

  // The timings survive with the person removed. They are what mutes this voice
  // out of a file the co-speaker keeps; deleting the rows would have made that
  // impossible.
  const orphaned = await prisma.audioSegment.findMany({
    where: { recordingId: ids.sharedRecording, subjectId: null, action: 'REDACT_VOICE' },
  })
  assert.ok(orphaned.length >= 1, 'the erased speaker’s spans must survive as mute intervals')
})

test('the re-mute fails closed when the audio worker is unreachable', async () => {
  // The whole point of this assertion is the degraded state, and this suite runs
  // with no audio worker — so L15 on the shared recording could not rebuild.
  const location = await prisma.purgeJobLocation.findFirst({
    where: { locationCode: 'L15', objectId: ids.sharedRecording },
    orderBy: { id: 'desc' },
  })
  assert.ok(location, 'L15 must have been planned for the shared recording')
  assert.equal(location.status, 'FAILED', 'an unbuildable derivative is a failure, never a pass')

  const row = await prisma.recording.findUnique({ where: { id: ids.sharedRecording } })
  assert.equal(
    row.redactedPath,
    null,
    'the stale derivative still carried the erased voice — it must be retracted, not left serveable',
  )
  assert.equal(row.status, 'DEFERRED', 'fail-closed: nothing may serve this until it is rebuilt')

  const job = await prisma.purgeJob.findFirst({ where: { dsarRequestId: ids.request } })
  assert.equal(
    job.status,
    'PARTIAL',
    'a job with an unrebuilt derivative must not report a completed erasure',
  )
})
