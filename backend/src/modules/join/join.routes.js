import { Router } from 'express'
import { z } from 'zod'
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import { requireSubjectAuth } from '../../middleware/requireSubjectAuth.js'
import { joinLookupIpLimiter, joinAcceptIpLimiter } from '../../middleware/rateLimiter.js'
import * as joinService from './join.service.js'

const uuid = z.string().uuid()
// base64url, 32 random bytes. Bounded so a lookup can't be used to probe with
// arbitrarily long strings.
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/)

// --- Agent-facing: /api/v1/sessions/:sessionId/invite --------------------------
// Guards are per-route rather than router-level: this router shares the
// /api/v1/sessions mount and must not run auth for paths it doesn't own.
export const sessionInviteRoutes = Router()

const agentOnly = [requireAdminAuth, requireRole('collectionAgent', 'super_admin')]

sessionInviteRoutes.get('/:sessionId/invite', ...agentOnly, async (req, res, next) => {
  try {
    res.json(await joinService.getActiveInvite(uuid.parse(req.params.sessionId), req.admin))
  } catch (err) {
    next(err)
  }
})

sessionInviteRoutes.post('/:sessionId/invite', ...agentOnly, async (req, res, next) => {
  try {
    res.status(201).json(await joinService.createInvite(uuid.parse(req.params.sessionId), req.admin))
  } catch (err) {
    next(err)
  }
})

sessionInviteRoutes.delete('/:sessionId/invite', ...agentOnly, async (req, res, next) => {
  try {
    res.json(await joinService.revokeInvite(uuid.parse(req.params.sessionId), req.admin))
  } catch (err) {
    next(err)
  }
})

// --- Subject-facing: /api/v1/join ---------------------------------------------
export const joinRoutes = Router()

// Public: anyone holding the QR can read the project card, so it is rate-limited
// hard — an unauthenticated lookup endpoint keyed by a guessable-shaped token is
// exactly what a scanner would grind against.
joinRoutes.get('/:token', joinLookupIpLimiter, async (req, res, next) => {
  try {
    res.json(
      await joinService.describeInvite(
        tokenSchema.parse(req.params.token),
        typeof req.query.locale === 'string' ? req.query.locale : undefined,
      ),
    )
  } catch (err) {
    next(err)
  }
})

// Requires a signed-in subject: the consent signature has to name a real person.
joinRoutes.post('/:token/accept', joinAcceptIpLimiter, requireSubjectAuth, async (req, res, next) => {
  try {
    res.json(
      await joinService.acceptInvite(tokenSchema.parse(req.params.token), req.subject.masterUserId),
    )
  } catch (err) {
    next(err)
  }
})
