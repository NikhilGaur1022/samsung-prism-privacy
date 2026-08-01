import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'

// Validation for the import leg. Kept in its own file because two of the rules
// here are policy, not shape — "you may not import into an erased subject" and
// "an image is the only thing this endpoint accepts" — and policy that lives
// inline in a route handler is policy nobody finds again.

export const uuid = z.string().uuid()

// Mirrors the session upload limits exactly. An import that accepted larger or
// stranger files than the capture path would be the softer way in.
export const MAX_FILE_BYTES = 25 * 1024 * 1024
export const MAX_FILES_PER_REQUEST = 20

export const MIME_ALLOWLIST = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']

export const createBatchSchema = z.object({
  subjectId: uuid,
  // Optional on purpose. Supplying it is what lets the import inherit a real
  // lawful basis; omitting it is an honest declaration that there isn't one.
  projectId: uuid.optional(),
  note: z.string().trim().max(2000).optional(),
})

export const listBatchesSchema = z.object({
  subjectId: uuid.optional(),
  status: z.enum(['OPEN', 'CLOSED', 'FAILED']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export const closeBatchSchema = z.object({
  note: z.string().trim().max(2000).optional(),
})

export const ingestMetaSchema = z.object({
  // The date the photo was taken, if the importing admin knows it. Null is a
  // legitimate answer and is preserved — inventing `now()` would put a false
  // capture date on a person's record.
  takenAt: z.coerce.date().optional(),
})

/**
 * The subject must exist and must not be ERASED.
 *
 * Importing into an erased subject would re-create the very data an erasure
 * certificate says was destroyed, and the certificate is signed — so this is a
 * 409, not a soft warning. Re-collection after erasure is a new consent event
 * and a new subject record, not an import.
 */
export async function assertImportableSubject(subjectId) {
  const subject = await prisma.subject.findUnique({
    where: { masterUserId: subjectId },
    select: { masterUserId: true, status: true },
  })
  if (!subject) throw new ApiError(404, 'Subject not found')
  if (subject.status === 'ERASED') {
    throw new ApiError(409, 'This subject has been erased; data cannot be imported into it', {
      subjectStatus: subject.status,
    })
  }
  return subject
}

export function assertAcceptableFile(file) {
  if (!file?.buffer?.length) throw new ApiError(400, 'Empty file')
  if (file.buffer.length > MAX_FILE_BYTES) {
    throw new ApiError(413, `File exceeds the ${MAX_FILE_BYTES} byte import limit`)
  }
  if (!MIME_ALLOWLIST.includes(file.mimetype)) {
    throw new ApiError(415, `Unsupported media type "${file.mimetype}"`, {
      accepted: MIME_ALLOWLIST,
    })
  }
}
