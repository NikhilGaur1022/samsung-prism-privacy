import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { prisma } from './config/prisma.js'
import { qdrant } from './config/qdrant.js'
import { logger } from './lib/logger.js'
import { requestLogger } from './middleware/requestLogger.js'
import { errorHandler } from './middleware/errorHandler.js'
import { subjectRoutes } from './modules/subjects/subject.routes.js'
import { authSubjectRoutes } from './modules/auth-subject/auth-subject.routes.js'
import { authAdminRoutes } from './modules/auth-admin/auth-admin.routes.js'
import { projectRoutes } from './modules/projects/project.routes.js'
import {
  sessionRoutes,
  sessionBreakGlassRoutes,
  sessionMediaRoutes,
} from './modules/sessions/session.routes.js'
import { consentRoutes } from './modules/consent/consent.routes.js'
import {
  agentEnrollmentRoutes,
  selfEnrollmentRoutes,
} from './modules/enrollment/enrollment.routes.js'
import { handoffRoutes } from './modules/handoff/handoff.routes.js'
import { meRoutes } from './modules/me/me.routes.js'
import { joinRoutes, sessionInviteRoutes } from './modules/join/join.routes.js'
import { consentTemplateRoutes } from './modules/consentTemplates/consentTemplate.routes.js'
import { auditRoutes, accessEventRoutes } from './modules/audit/audit.routes.js'
import { dsarRoutes } from './modules/dsar/dsar.routes.js'
import { dashboardRoutes } from './modules/dashboard/dashboard.routes.js'

// The app is built here and listened to in server.js. The split exists so the
// RBAC matrix test can mount the real application — the same routers, in the same
// order, with the same guards — instead of a reconstruction of it. A test against
// a rebuilt app proves nothing about what ships.

export function createApp() {
  const app = express()
  const corsOrigins = (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)

  app.use(cors({ origin: corsOrigins, credentials: true }))
  app.use(express.json())
  app.use(cookieParser())
  app.use(requestLogger)

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  app.get('/health/deep', async (_req, res) => {
    const result = { postgres: false, qdrant: false, redis: false }

    try {
      await prisma.$queryRaw`SELECT 1`
      result.postgres = true
    } catch (err) {
      logger.warn({ err }, 'health/deep: postgres unreachable')
    }

    try {
      await qdrant.getCollections()
      result.qdrant = true
    } catch (err) {
      logger.warn({ err }, 'health/deep: qdrant unreachable')
    }

    // Redis is not optional in production: with it down the redaction, purge and
    // retention queues stop, which is silent — the API keeps answering while
    // deferred work is never retried. A probe that reports green through that is
    // worse than no probe.
    // Bounded: ioredis queues a command against a dead server and retries it,
    // so an un-raced ping turns a probe that should answer "redis: false" in a
    // millisecond into one that hangs for the length of the retry policy. A
    // health check that hangs reports nothing at all.
    try {
      const { redis } = await import('./config/redis.js')
      result.redis =
        (await Promise.race([
          redis.ping(),
          new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 1500)),
        ])) === 'PONG'
    } catch (err) {
      logger.warn({ err }, 'health/deep: redis unreachable')
    }

    const allHealthy = Object.values(result).every(Boolean)
    res.status(allHealthy ? 200 : 503).json(result)
  })

  // Mounted BEFORE subjectRoutes: that router applies requireAuth (a dev stub) and
  // owns a bare /:id, which would otherwise swallow these paths.
  app.use('/api/v1/subjects', agentEnrollmentRoutes)
  app.use('/api/v1/me', meRoutes)
  app.use('/api/v1/me', selfEnrollmentRoutes)
  app.use('/api/v1/handoffs', handoffRoutes)
  app.use('/api/v1/subjects', subjectRoutes)
  app.use('/api/v1/projects', projectRoutes)
  app.use('/api/v1/consent-templates', consentTemplateRoutes)
  app.use('/api/v1/dashboard', dashboardRoutes)
  app.use('/api/v1/dsar', dsarRoutes)
  app.use('/api/v1/audit', auditRoutes)
  app.use('/api/v1/access-events', accessEventRoutes)
  // Public — no auth middleware anywhere above it on this path, and mounted before
  // sessionRoutes' router-level requireAdminAuth can see anything.
  app.use('/api/v1/join', joinRoutes)
  // Per-route guards, mounted ahead of sessionRoutes so /:sessionId/invite is
  // matched here rather than falling through to a session handler.
  app.use('/api/v1/sessions', sessionInviteRoutes)
  // Break-glass raw media, mounted ahead of sessionRoutes: it admits dataAdmin,
  // which sessionRoutes' router-level requireRole would otherwise 403 before the
  // break-glass check ever ran.
  app.use('/api/v1/sessions', sessionBreakGlassRoutes)
  // Redacted media, mounted ahead of sessionRoutes for the same reason: it admits
  // dataOwner and dataAdmin to the derivatives, and the agent-only floor below
  // would 403 them first.
  app.use('/api/v1/sessions', sessionMediaRoutes)
  app.use('/api/v1/sessions', sessionRoutes)
  app.use('/api/v1/consent', consentRoutes)
  app.use('/auth/subject', authSubjectRoutes)
  app.use('/auth/admin', authAdminRoutes)

  app.use(errorHandler)

  return app
}

/**
 * Every route the application actually mounts, walked off the live Express
 * router stack rather than maintained by hand.
 *
 * This is what lets the RBAC test fail on an UNCLASSIFIED route: a new endpoint
 * appears here the moment it is mounted, so forgetting to classify it is a test
 * failure instead of a silent hole.
 */
export function listRoutes(app) {
  const routes = []

  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods)
          .filter((m) => m !== '_all')
          .map((m) => m.toUpperCase())
        for (const method of methods) {
          routes.push({ method, path: normalise(prefix + layer.route.path) })
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + extractPrefix(layer))
      }
    }
  }

  // Express stores a mount path as a regexp. Recovering the literal prefix from
  // it is unpleasant but beats maintaining a parallel list that can drift.
  const extractPrefix = (layer) => {
    if (layer.regexp?.fast_slash) return ''
    const source = layer.regexp?.source ?? ''
    const match = /^\^\\\/(.*?)\\\/\?\(\?=\\\/\|\$\)/.exec(source)
    if (!match) return ''
    return '/' + match[1].replace(/\\\//g, '/').replace(/\\\./g, '.')
  }

  const normalise = (p) => (p.length > 1 ? p.replace(/\/$/, '') : p)

  walk(app._router?.stack ?? app.router?.stack ?? [], '')
  return routes
}
