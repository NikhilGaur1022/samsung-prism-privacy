import test from 'node:test'
import assert from 'node:assert/strict'
import { runDiscovery } from '../../src/modules/dsar/discovery.service.js'
import { prisma } from '../../src/config/prisma.js'

test('Audio DSAR discovery includes audio segments and recordings', async () => {
  const seg = await prisma.audioSegment.findFirst({
    where: { subjectId: { not: null } },
  })

  if (seg?.subjectId) {
    const discovery = await runDiscovery(seg.subjectId)
    assert.ok(discovery.counts.audioSegments >= 1, 'should count audio segments')
    assert.ok(discovery.counts.recordings >= 1, 'should count recordings')
    
    const segmentLocation = discovery.locations.find((l) => l.objectType === 'AudioSegment')
    assert.ok(segmentLocation, 'AudioSegment location must be present')
    assert.equal(segmentLocation.locationCode, 'AUDIO_SEGMENT')
  }
})
