import test from 'node:test'
import assert from 'node:assert/strict'

import { canonicalJson, summariseOutcome } from '../../src/modules/dsar/certificate.service.js'

// summariseOutcome() decides the two numbers a principal actually reads on a
// deletion certificate: what was destroyed outright, and what was kept and
// re-rendered with them removed. Both are read from the purge job's own rows,
// and the rows come in pairs — an original (L2/L14/L20) and the derivative that
// gets rebuilt when other people are still lawfully in the frame (L6/L15/L21).
//
// The pairing is the whole trap: counting both rows doubles every figure, and
// counting only the DONE ones reports a shared photo as destroyed when it is
// still on disk with somebody else in it.
//
// Covered here because the function had integration coverage only, and these are
// the cases where an arithmetic slip becomes a false statement on a signed
// document rather than a failing request.

function loc(locationCode, objectId, status) {
  return { locationCode, objectId, status, storagePath: null, hashBefore: null }
}

test('an object the subject was last on is erased, not redacted', () => {
  const o = summariseOutcome([loc('L2', 'photo-1', 'DONE'), loc('L6', 'photo-1', 'DONE')])
  assert.equal(o.erased, 1)
  assert.equal(o.redacted, 0)
  assert.equal(o.total, 1, 'the original and its rebuild row are one object, not two')
  assert.deepEqual(o.byMedium, { photo: { erased: 1, redacted: 0 } })
})

test('an object somebody else is still entitled to is redacted, not erased', () => {
  // The original survives (SKIPPED) and the derivative was re-rendered (DONE).
  const o = summariseOutcome([loc('L2', 'photo-1', 'SKIPPED'), loc('L6', 'photo-1', 'DONE')])
  assert.equal(o.erased, 0)
  assert.equal(o.redacted, 1)
  assert.equal(o.total, 1)
})

test('a skipped original with no rebuild is counted as neither', () => {
  // Nothing was destroyed and nothing was re-rendered. Counting it as redacted
  // would claim a masking that never happened.
  const o = summariseOutcome([loc('L2', 'photo-1', 'SKIPPED')])
  assert.equal(o.erased, 0)
  assert.equal(o.redacted, 0)
  assert.equal(o.total, 0)
  assert.deepEqual(o.byMedium, {}, 'a medium with no activity is omitted entirely')
})

test('a rebuild that did not complete does not make its original redacted', () => {
  const o = summariseOutcome([loc('L2', 'photo-1', 'SKIPPED'), loc('L6', 'photo-1', 'FAILED')])
  assert.equal(o.redacted, 0, 'a failed re-render is not a redaction')
  assert.equal(o.total, 0)
})

test('the rebuild row is matched to its own object, never to another', () => {
  // photo-1 was destroyed; photo-2 was kept and re-rendered. If the rebuild set
  // were consulted without matching objectId, photo-2 would be miscounted.
  const o = summariseOutcome([
    loc('L2', 'photo-1', 'DONE'),
    loc('L6', 'photo-1', 'DONE'),
    loc('L2', 'photo-2', 'SKIPPED'),
    loc('L6', 'photo-2', 'DONE'),
    loc('L2', 'photo-3', 'SKIPPED'),
    loc('L6', 'photo-3', 'SKIPPED'),
  ])
  assert.equal(o.erased, 1, 'only photo-1')
  assert.equal(o.redacted, 1, 'only photo-2')
  assert.equal(o.total, 2, 'photo-3 was neither destroyed nor re-rendered')
})

test('each medium is counted under its own noun', () => {
  const o = summariseOutcome([
    loc('L2', 'p1', 'DONE'),
    loc('L14', 'r1', 'SKIPPED'),
    loc('L15', 'r1', 'DONE'),
    loc('L20', 'v1', 'DONE'),
    loc('L21', 'v1', 'DONE'),
  ])
  assert.deepEqual(o.byMedium, {
    photo: { erased: 1, redacted: 0 },
    recording: { erased: 0, redacted: 1 },
    video: { erased: 1, redacted: 0 },
  })
  assert.equal(o.erased, 2)
  assert.equal(o.redacted, 1)
  assert.equal(o.total, 3)
})

test('non-media locations are not counted as objects', () => {
  // The subject row, consent rows and key material are destroyed by the same
  // job, but they are not things the principal has a copy of. Counting them
  // would inflate "erased" with rows that are not photographs.
  const o = summariseOutcome([
    loc('L2', 'p1', 'DONE'),
    loc('PII', 'subject', 'DONE'),
    loc('CONSENT', 'consent-1', 'DONE'),
    loc('L5', 'key', 'DONE'),
    loc('L3', 'face-1', 'DONE'),
  ])
  assert.equal(o.total, 1, 'only the photograph is an object the principal held')
})

test('the totals always reconcile', () => {
  const o = summariseOutcome([
    loc('L2', 'a', 'DONE'),
    loc('L2', 'b', 'SKIPPED'),
    loc('L6', 'b', 'DONE'),
    loc('L20', 'c', 'DONE'),
  ])
  assert.equal(o.erased + o.redacted, o.total)
  const summed = Object.values(o.byMedium).reduce((n, m) => n + m.erased + m.redacted, 0)
  assert.equal(summed, o.total, 'the per-medium figures must account for every object')
})

test('input order does not change the signed bytes', () => {
  // canonicalJson sorts object keys but preserves array order. summariseOutcome
  // feeds the signed payload, so it must be order-independent or two runs over
  // the same job would sign differently.
  const rows = [
    loc('L2', 'a', 'DONE'),
    loc('L6', 'a', 'DONE'),
    loc('L2', 'b', 'SKIPPED'),
    loc('L6', 'b', 'DONE'),
  ]
  assert.equal(
    canonicalJson(summariseOutcome(rows)),
    canonicalJson(summariseOutcome([...rows].reverse())),
  )
})
