import { z } from 'zod'

// Query-string schemas for the DSAR item grid, kept in a leaf module.
//
// They live here rather than in dsar.routes.js because that module pulls in
// prisma, redis and the middleware chain: importing it from a test hangs the
// runner on the open handles those keep. A validation rule that cannot be
// tested without standing up the whole app is a validation rule that does not
// get tested, and the bug below is what that costs.

const uuid = z.string().uuid()

// Not z.coerce.boolean(): that is Boolean(value), so every non-empty string is
// true and the string "false" coerces to TRUE. `?includeDeleted=false` would
// return deleted items — the exact opposite of what was asked for.
//
// The pipeline therefore starts as a STRING enum and transforms to a boolean,
// which matters for anything downstream that supplies a default — see below.
export const queryBoolean = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')

export const itemQuerySchema = z.object({
  // Mirrors DataItemType in prisma/schema.prisma. VIDEO was added there when the
  // video pipeline landed — indexed by itemIndex.service, walked by discovery
  // and erased by purge — but this enum was not updated with it, so a subject's
  // video items appeared in the totals and could never be filtered to.
  type: z.enum(['PHOTO', 'AUDIO', 'VIDEO']).optional(),
  origin: z.enum(['COLLECTION_SESSION', 'IMPORT', 'ENROLLMENT']).optional(),
  projectId: uuid.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  // '.default("false")', not '.default(false)'. A Zod default is fed into the
  // INPUT side of the pipeline, and this pipeline starts with a string enum, so
  // a boolean default never reaches the transform: it fails the enum and 400s
  // the entire request. An absent parameter is the normal case — the item grid
  // omits it unless the operator ticks "include deleted" — so this one wrong
  // literal made GET /items reject every default call, and the DSAR workspace
  // rendered empty for every role, with no error anyone could act on.
  includeDeleted: queryBoolean.default('false'),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
