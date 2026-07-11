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
  email: z.string().email().optional(),
  phone: z.string().min(6).max(20).optional(),
  employeeRef: z.string().min(1).max(64).optional(),
  registrationChannel: z.enum(['SELF', 'AGENT']),
  registeredByUserId: z.string().uuid().optional(),
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

export const verifyOtpSchema = z.object({
  otp: z.string().min(4).max(10),
})

export const subjectIdParamSchema = z.string().uuid()
