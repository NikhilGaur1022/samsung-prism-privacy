import { z } from 'zod'

export const uuid = z.string().uuid()

// Optional, not lenient: an absent pose means "not recorded" (agent-side capture
// is free-form — one usable shot in the field is the norm), but a value that
// isn't one of the five must 400 rather than land in the DB as null.
export const pose = z.enum(['FRONT', 'LEFT', 'RIGHT', 'UP', 'DOWN']).optional()

export const parsePose = (value) => pose.parse(value || undefined) ?? null

export const subjectIdParam = z.object({ subjectId: uuid })
export const enrollmentIdParam = z.object({ subjectId: uuid, id: uuid })
export const selfEnrollmentIdParam = z.object({ id: uuid })
