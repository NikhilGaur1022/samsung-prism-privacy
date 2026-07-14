import { z } from 'zod'

export const ADMIN_ROLES = ['super_admin', 'dpo', 'dataOwner', 'collectionAgent', 'dataAdmin']

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(ADMIN_ROLES),
})

export const acceptInviteSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
})

export const requestResetSchema = z.object({
  email: z.string().email(),
})

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8),
})
