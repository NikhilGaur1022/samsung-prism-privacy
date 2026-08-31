import test from 'node:test'
import assert from 'node:assert/strict'

import { queryBoolean, itemQuerySchema } from '../../src/modules/dsar/query.schema.js'

// GET /api/v1/dsar/:id/items 400'd on every call that did not pass
// ?includeDeleted explicitly — which is every call the item grid makes unless
// the operator has ticked "include deleted". The DSAR workspace therefore
// rendered empty for every role, including the DPO who has to read it before
// closing a request, and there was nothing in it to say why.
//
// The cause was `.default(false)` on a pipeline whose input side is a string
// enum. A Zod default is supplied as INPUT, so the boolean never reached the
// transform: it failed the enum first.

test('an absent includeDeleted parses, and means false', () => {
  const parsed = itemQuerySchema.parse({})
  assert.equal(parsed.includeDeleted, false)
  assert.equal(parsed.limit, 50)
})

test('the default survives alongside other query params', () => {
  const parsed = itemQuerySchema.parse({ limit: '5', type: 'PHOTO' })
  assert.equal(parsed.includeDeleted, false)
  assert.equal(parsed.limit, 5)
  assert.equal(parsed.type, 'PHOTO')
})

test('includeDeleted is honoured when passed explicitly', () => {
  assert.equal(itemQuerySchema.parse({ includeDeleted: 'true' }).includeDeleted, true)
  assert.equal(itemQuerySchema.parse({ includeDeleted: '1' }).includeDeleted, true)
  assert.equal(itemQuerySchema.parse({ includeDeleted: 'false' }).includeDeleted, false)
  assert.equal(itemQuerySchema.parse({ includeDeleted: '0' }).includeDeleted, false)
})

// The reason queryBoolean is a string enum rather than z.coerce.boolean(): the
// latter is Boolean(value), under which the string "false" is TRUE and asking
// to exclude deleted items would include them.
test('the string "false" is false, not truthy', () => {
  assert.equal(queryBoolean.parse('false'), false)
  assert.equal(queryBoolean.parse('0'), false)
})

test('a garbage value is rejected rather than silently coerced', () => {
  assert.throws(() => itemQuerySchema.parse({ includeDeleted: 'yes' }))
  assert.throws(() => itemQuerySchema.parse({ includeDeleted: '' }))
})

// The exact shape of the bug, pinned. A boolean default cannot reach the
// transform, so if anyone reintroduces `.default(false)` this fails.
test('a boolean is not valid input to the pipeline — why the default is a string', () => {
  assert.throws(() => queryBoolean.parse(false))
  assert.throws(() => queryBoolean.parse(true))
})

// DataItemType gained VIDEO when the video pipeline landed. itemIndex.service
// indexes it, discovery walks it and purge erases it — but these filter enums
// were left at PHOTO|AUDIO, so a subject's clips showed up in the totals and
// then 400'd the moment anyone filtered to them.
test('every DataItemType the index can hold is filterable', () => {
  for (const type of ['PHOTO', 'AUDIO', 'VIDEO']) {
    assert.equal(itemQuerySchema.parse({ type }).type, type)
  }
})

test('a type outside the enum is still rejected', () => {
  assert.throws(() => itemQuerySchema.parse({ type: 'TEXT' }))
})
