import { z } from 'zod'

const SUBJECT_GROUPS = [
  'SAMSUNG_EMPLOYEE',
  'EX_SAMSUNG_EMPLOYEE',
  'SEED_LAB_EMPLOYEE',
  'EX_SEED_LAB_EMPLOYEE',
  'VOLUNTEER',
]

const SUBJECT_STATUSES = ['PENDING', 'ACTIVE', 'INACTIVE', 'REJECTED']

export const registerSubjectSchema = z.object({
  group: z.enum(SUBJECT_GROUPS),
  fullName: z.string().min(1).max(200),
  email: z.string().email(),
  phone: z.string().min(6).max(20).optional(),
  employeeRef: z.string().min(1).max(64).optional(),
  registrationChannel: z.enum(['SELF', 'AGENT']),
  registeredByUserId: z.string().uuid().optional(),
})

// Self-registration from the user portal, which is unauthenticated by design.
// Deliberately NOT registerSubjectSchema: that one accepts `registrationChannel`
// and `registeredByUserId`, and an anonymous caller must not be able to stamp
// their own record as agent-assisted or attribute it to an admin who never saw
// them. The channel is set server-side, not parsed. `employeeRef` is withheld
// too — an unverified stranger asserting an employee reference is exactly the
// claim a collection agent exists to witness.
export const selfRegisterSubjectSchema = z.object({
  group: z.enum(SUBJECT_GROUPS),
  fullName: z.string().min(1).max(200),
  email: z.string().email(),
  phone: z.string().min(6).max(20).optional(),
})

export const listSubjectsQuerySchema = z.object({
  group: z.enum(SUBJECT_GROUPS).optional(),
  status: z.enum(SUBJECT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().uuid().optional(),
})

export const updateConsentSchema = z.object({
  generalTerms: z.boolean().optional(),
  piiProcessing: z.boolean().optional(),
  biometricMatch: z.boolean().optional(),
})

export const updateStatusSchema = z.object({
  status: z.enum(SUBJECT_STATUSES),
})

export const updateGroupSchema = z.object({
  group: z.enum(SUBJECT_GROUPS),
})

export const subjectIdParamSchema = z.string().uuid()
