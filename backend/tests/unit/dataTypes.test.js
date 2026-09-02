import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DATA_TYPE_CATALOG,
  DATA_TYPE_CODES,
  OTHER_PREFIX,
  MAX_CUSTOM_LENGTH,
  isValidDataType,
  normaliseDataType,
  labelForDataType,
  groupedCatalog,
} from '../../src/lib/dataTypes.js'
import { dataTypeArraySchema } from '../../src/lib/dataTypeSchema.js'

// The vocabulary behind a DPDP §5 notice's data categories.
//
// It replaced a free-text field. The bug that motivated it was not cosmetic:
// assertPurposeLimitation compares a project's data types against its notice's
// with an exact string match, so "Face" on the notice and "face" on the project
// made the project undisclosed — refused, naming a category that reads on screen
// as identical to one that was disclosed.

test('the codes already stored in live rows remain valid', () => {
  // Every consent template and project in this deployment stores these three.
  // Renaming or dropping one would invalidate live consent records.
  for (const code of ['FACE', 'VOICE', 'TEXT']) {
    assert.ok(DATA_TYPE_CODES.includes(code), `${code} is no longer in the catalogue`)
  }
})

test('codes are unique and stable-looking', () => {
  assert.equal(new Set(DATA_TYPE_CODES).size, DATA_TYPE_CODES.length, 'duplicate code')
  for (const code of DATA_TYPE_CODES) {
    assert.match(code, /^[A-Z][A-Z_]*$/, `${code} is not an upper-snake code`)
    assert.ok(!code.startsWith(OTHER_PREFIX), 'a catalogue code must not collide with the custom prefix')
  }
})

test('every entry carries a label and a group', () => {
  for (const entry of DATA_TYPE_CATALOG) {
    assert.ok(entry.label && entry.label.trim().length > 0, `${entry.code} has no label`)
    assert.ok(entry.group && entry.group.trim().length > 0, `${entry.code} has no group`)
  }
  // The picker renders groups; an entry in no group would silently not render.
  const grouped = groupedCatalog()
  const total = grouped.reduce((n, g) => n + g.items.length, 0)
  assert.equal(total, DATA_TYPE_CATALOG.length, 'grouping lost or duplicated an entry')
})

test('case and surrounding space are forgiven — the whole point of normalising', () => {
  assert.equal(normaliseDataType('face'), 'FACE')
  assert.equal(normaliseDataType('  Face  '), 'FACE')
  assert.equal(normaliseDataType('FaCe'), 'FACE')
})

test('an unrecognised word is rejected, never promoted to a custom entry', () => {
  // Promoting it would turn a typo into a new data category on a legal notice.
  assert.equal(normaliseDataType('fase'), null)
  assert.equal(normaliseDataType('anything at all'), null)
  assert.equal(isValidDataType('fase'), false)
})

test('custom entries round-trip under the OTHER prefix', () => {
  assert.equal(normaliseDataType('OTHER:tattoo placement'), 'OTHER:tattoo placement')
  // Interior whitespace is collapsed so two operators typing the same thing with
  // different spacing still produce one value the subset check can match.
  assert.equal(normaliseDataType('OTHER:tattoo   placement'), 'OTHER:tattoo placement')
  assert.ok(isValidDataType('OTHER:something bespoke'))
  assert.equal(isValidDataType(OTHER_PREFIX), false, 'an empty custom entry is not a category')
  assert.equal(isValidDataType(`${OTHER_PREFIX}${'x'.repeat(MAX_CUSTOM_LENGTH + 1)}`), false)
})

test('labels are readable, and a custom entry keeps its own words', () => {
  assert.equal(labelForDataType('FACE'), 'Face')
  assert.equal(labelForDataType('FACE_EMBEDDING'), 'Face embedding')
  // Verbatim: it is the text of a notice, and reformatting it would change it.
  assert.equal(labelForDataType('OTHER:tattoo placement'), 'tattoo placement')
})

test('the array schema normalises, de-duplicates and requires at least one', () => {
  const ok = dataTypeArraySchema.safeParse(['FACE', 'face', '  Voice '])
  assert.ok(ok.success)
  // "FACE" and "face" are one category, not two — this is the bug being fixed.
  assert.deepEqual(ok.data, ['FACE', 'VOICE'])

  assert.equal(dataTypeArraySchema.safeParse([]).success, false)
  assert.equal(dataTypeArraySchema.safeParse(['nonsense']).success, false)
})

test('a rejection names what to do instead', () => {
  const result = dataTypeArraySchema.safeParse(['fase'])
  assert.equal(result.success, false)
  const message = result.error.issues[0].message
  // An error that only says "invalid" leaves the DPO guessing at a vocabulary
  // they cannot see from the error.
  assert.match(message, /FACE/)
  assert.match(message, /OTHER:/)
})
