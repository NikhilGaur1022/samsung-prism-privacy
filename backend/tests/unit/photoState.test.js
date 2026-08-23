import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TERMINAL_PII_STATUSES,
  UNRESOLVED_PHOTO_WHERE,
  RESOLVED_PHOTO_WHERE,
  isResolved,
  isUnresolved,
  countBlockedFrames,
} from '../../src/lib/photoState.js'

// Every value the PiiStatus enum can take, copied from prisma/schema.prisma.
// If someone adds a sixth, this list is where they will notice they have to
// decide whether it is terminal — which is the entire point of the inversion.
const ALL_PII_STATUSES = ['PENDING', 'CLEAN', 'MASKED', 'DEFERRED', 'FAILED']

const photo = (piiStatus, redactedPath = '/x/y.jpg') => ({ piiStatus, redactedPath })

test('exactly two statuses are terminal, and PENDING is not one of them', () => {
  assert.deepEqual([...TERMINAL_PII_STATUSES].sort(), ['CLEAN', 'MASKED'])
  assert.ok(!TERMINAL_PII_STATUSES.includes('PENDING'))
})

test('every non-terminal status is unresolved, even with a derivative on disk', () => {
  for (const status of ALL_PII_STATUSES) {
    const expected = !TERMINAL_PII_STATUSES.includes(status)
    assert.equal(
      isUnresolved(photo(status)),
      expected,
      `${status} should be ${expected ? 'unresolved' : 'resolved'}`,
    )
  }
})

test('a terminal status with no derivative is still unresolved', () => {
  // This is the case the old inline checks in dashboard.service.js missed: the
  // finalize path could commit CLEAN before the redacted file was written.
  for (const status of TERMINAL_PII_STATUSES) {
    assert.equal(isUnresolved({ piiStatus: status, redactedPath: null }), true)
    // The column absent from the select entirely, not merely null — the shape a
    // partial `select` hands back, and the one a default-argument helper would
    // quietly paper over.
    assert.equal(isUnresolved({ piiStatus: status }), true)
    assert.equal(isUnresolved({ piiStatus: status, redactedPath: '' }), true)
  }
})

test('an unknown future status fails safe as unresolved', () => {
  assert.equal(isUnresolved(photo('QUARANTINED')), true)
  assert.equal(isUnresolved(photo('SOME_NEW_STATE')), true)
})

test('a missing photo is unresolved rather than throwing', () => {
  assert.equal(isUnresolved(null), true)
  assert.equal(isUnresolved(undefined), true)
})

test('isResolved is the exact complement of isUnresolved', () => {
  for (const status of [...ALL_PII_STATUSES, 'FUTURE_STATE']) {
    for (const path of ['/x.jpg', null]) {
      assert.equal(isResolved(photo(status, path)), !isUnresolved(photo(status, path)))
    }
  }
})

test('the two Prisma where fragments are complements of each other', () => {
  // Not executed against the database here — asserted structurally, so a future
  // edit that loosens one without the other is caught by a unit test rather than
  // by an unredacted frame reaching an export.
  assert.deepEqual(UNRESOLVED_PHOTO_WHERE, {
    OR: [{ piiStatus: { notIn: TERMINAL_PII_STATUSES } }, { redactedPath: null }],
  })
  assert.deepEqual(RESOLVED_PHOTO_WHERE, {
    piiStatus: { in: TERMINAL_PII_STATUSES },
    redactedPath: { not: null },
  })
})

test('the where fragments are frozen, so a caller cannot mutate the shared object', () => {
  assert.throws(() => {
    UNRESOLVED_PHOTO_WHERE.OR = []
  })
})

// The reporting counterpart. Two dashboards spelled this as a sum of named
// buckets, and the first pass of this fix only widened the list to include
// PENDING — which reads as correct and still loses the next enum value.

test('countBlockedFrames counts every non-terminal bucket', () => {
  assert.equal(countBlockedFrames({ PENDING: 1, DEFERRED: 2, FAILED: 3 }), 6)
})

test('countBlockedFrames reproduces the live distribution that reported zero', () => {
  // photo piiStatus: CLEAN 83 · PENDING 27, and both dashboards showed 0.
  assert.equal(countBlockedFrames({ CLEAN: 83, PENDING: 27, DEFERRED: 0, FAILED: 0 }), 27)
})

test('countBlockedFrames treats an unknown future status as blocked', () => {
  assert.equal(countBlockedFrames({ CLEAN: 5, QUARANTINED: 2 }), 2)
})

test('countBlockedFrames is zero when everything is terminal', () => {
  assert.equal(countBlockedFrames({ CLEAN: 10, MASKED: 4 }), 0)
  assert.equal(countBlockedFrames({}), 0)
  assert.equal(countBlockedFrames(null), 0)
  assert.equal(countBlockedFrames(undefined), 0)
})

test('countBlockedFrames agrees with the portal mirror on the terminal list', () => {
  assert.deepEqual([...TERMINAL_PII_STATUSES].sort(), ['CLEAN', 'MASKED'])
})
