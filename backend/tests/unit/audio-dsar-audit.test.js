import test from 'node:test'
import assert from 'node:assert/strict'
import { runDiscovery } from '../../src/modules/dsar/discovery.service.js'
import { prisma } from '../../src/config/prisma.js'

// Audio has to appear in DSAR discovery the same way stills do, and for the same
// reason: the attribution row — who is speaking in this segment — is the erasure
// key. Delete it and nothing in the system claims that voice was theirs any more.
//
// Two things this test had wrong until the suite was run end to end:
//
//   * it asserted `counts.audioSegments`, which discovery never emitted. The
//     summary counted recordings — the files — and not the claims about who is
//     on them, which is the number a deletion certificate has to account for.
//     Discovery now reports it.
//   * it asserted the location code was `AUDIO_SEGMENT`. It is `SEGMENT`, which
//     is what purge.service.js matches on and what dsar-audio-erasure asserts.
//     The test was the thing that was wrong.
//
// It also passed vacuously whenever the database held no attributed audio,
// because the whole body sat inside an `if`. A missing fixture is now a skip
// that says so, not a green tick.

test('Audio DSAR discovery includes audio segments and recordings', async (t) => {
  const seg = await prisma.audioSegment.findFirst({ where: { subjectId: { not: null } } })

  if (!seg?.subjectId) {
    t.skip('no attributed audio segment in this database — nothing to discover')
    return
  }

  const discovery = await runDiscovery(seg.subjectId)

  assert.ok(discovery.counts.audioSegments >= 1, 'should count audio segments')
  assert.ok(discovery.counts.recordings >= 1, 'should count recordings')

  const segmentLocation = discovery.locations.find((l) => l.objectType === 'AudioSegment')
  assert.ok(segmentLocation, 'AudioSegment location must be present')
  assert.equal(segmentLocation.locationCode, 'SEGMENT')

  // The count is the number of attributions, not the number of recordings they
  // are spread across — those are different numbers and the erasure works on the
  // first one.
  const attributions = await prisma.audioSegment.count({ where: { subjectId: seg.subjectId } })
  assert.ok(
    discovery.counts.audioSegments <= attributions,
    'discovery cannot claim more attributions than exist',
  )
})

test.after(async () => {
  await prisma.$disconnect()
})
