import { z } from 'zod'

export const requestLoginSchema = z.object({
  email: z.string().email(),
})

export const verifyLoginSchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6),
})
