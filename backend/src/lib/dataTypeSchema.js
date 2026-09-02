import { z } from 'zod'
import {
  DATA_TYPE_CODES,
  MAX_CUSTOM_LENGTH,
  OTHER_PREFIX,
  normaliseDataType,
} from './dataTypes.js'

// Shared by the consent-template and project routers so the two cannot drift.
//
// They are checked against each other at approval time — a project's data types
// must be a subset of its notice's — and a rule enforced in one router and not
// the other would let a project declare a category no notice could express.

const single = z
  .string()
  .trim()
  .min(1)
  .transform((value, ctx) => {
    const normalised = normaliseDataType(value)
    if (!normalised) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `"${value}" is not a recognised data type. Choose one of: ${DATA_TYPE_CODES.join(', ')}. ` +
          `For anything else, send it as "${OTHER_PREFIX}your description" ` +
          `(up to ${MAX_CUSTOM_LENGTH} characters).`,
      })
      return z.NEVER
    }
    return normalised
  })

/**
 * A non-empty, duplicate-free list of data types.
 *
 * De-duplicated after normalisation rather than before: "FACE" and "face" arrive
 * as two entries and collapse to one, which is the whole point of normalising.
 */
export const dataTypeArraySchema = z
  .array(single)
  .min(1)
  .max(40)
  .transform((values) => [...new Set(values)])
