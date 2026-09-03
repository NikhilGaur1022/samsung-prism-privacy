import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import compression from 'compression'
import cookieParser from 'cookie-parser'
import { prisma } from './config/prisma.js'
import { qdrant } from './config/qdrant.js'
import { logger } from './lib/logger.js'
import { requestLogger } from './middleware/requestLogger.js'
import { errorHandler } from './middleware/errorHandler.js'
import { installUuidParams } from './middleware/uuidParams.js'
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
import { dataTypeRoutes } from './modules/dataTypes/dataType.routes.js'
import { auditRoutes, accessEventRoutes } from './modules/audit/audit.routes.js'
import { provenanceRoutes } from './modules/provenance/provenance.routes.js'
import { dsarRoutes } from './modules/dsar/dsar.routes.js'
import { importRoutes } from './modules/import/import.routes.js'
import { dashboardRoutes } from './modules/dashboard/dashboard.routes.js'
import { recordingRoutes } from './modules/recordings/recording.routes.js'
import { videoRoutes } from './modules/videos/video.routes.js'
import { documentRoutes } from './modules/documents/document.routes.js'
import { opsRoutes } from './modules/ops/ops.routes.js'

// The app is built here and listened to in server.js. The split exists so the
// RBAC matrix test can mount the real application — the same routers, in the same
// order, with the same guards — instead of a reconstruction of it. A test against
// a rebuilt app proves nothing about what ships.

// Every router mounted below, in one place, so installUuidParams cannot miss one.
const ALL_ROUTERS = [
  accessEventRoutes,
  agentEnrollmentRoutes,
  auditRoutes,
  authAdminRoutes,
  authSubjectRoutes,
  consentRoutes,
  consentTemplateRoutes,
  dashboardRoutes,
  dataTypeRoutes,
  documentRoutes,
  dsarRoutes,
  opsRoutes,
  provenanceRoutes,
  handoffRoutes,
  importRoutes,
  joinRoutes,
  meRoutes,
  projectRoutes,
  recordingRoutes,
  selfEnrollmentRoutes,
  sessionBreakGlassRoutes,
  sessionInviteRoutes,
  sessionMediaRoutes,
  sessionRoutes,
  subjectRoutes,
  videoRoutes,
]

export function createApp() {
  const app = express()

  // Every router gets uuid validation on its id params before any of its own
  // middleware runs — in particular before logAccess, which used to write an
  // AccessEvent row for a request that the handler was about to 400. Applied
  // here, from one list, so mounting a new router is enough to inherit it.
  for (const router of ALL_ROUTERS) installUuidParams(router)
  const corsOrigins = (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)

  // How many reverse-proxy hops sit in front of this process. It must be an
  // exact hop count, never `true`: `trust proxy: true` tells Express to believe
  // the whole X-Forwarded-For chain, which lets a client prepend any address it
  // likes and both forge the IP written into the access ledger and give itself a
  // fresh rate-limit bucket per request. Default 0 — direct exposure — because
  // guessing high is the unsafe direction.
  const trustProxyHops = Number.parseInt(process.env.TRUST_PROXY_HOPS ?? '0', 10)
  app.set('trust proxy', Number.isFinite(trustProxyHops) ? trustProxyHops : 0)

  // Security headers. The API serves JSON and media bytes, never HTML, so the
  // most useful members here are nosniff, frameguard and referrer policy; CSP is
  // set to a frame-and-script-free default rather than disabled, so a response
  // that ever did render as a document cannot execute anything.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  )

  // Content-Disposition has to be named explicitly: CORS exposes only the six
  // safelisted response headers by default, so a cross-origin reader sees null
  // for everything else. Both portals sit on a different origin from the API and
  // both parse the filename out of this header when saving a package — the DSAR
  // export, the erasure review ZIP, the project export. Without it every
  // download the server carefully named `prism-erasure-review-<id>.zip` landed
  // on the client's generic fallback name instead.
  app.use(
    cors({ origin: corsOrigins, credentials: true, exposedHeaders: ['Content-Disposition'] }),
  )

  // JSON list responses are the only thing worth compressing here. Media is
  // already-compressed JPEG and export archives are already deflated, so both
  // are filtered out — running them through gzip burns CPU to make them
  // marginally larger.
  app.use(
    compression({
      filter: (req, res) => {
        const type = res.getHeader('Content-Type')
        if (typeof type === 'string' && /^(image|video|audio)\/|application\/zip/.test(type)) return false
        return compression.filter(req, res)
      },
    }),
  )

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
  // The shared data-type vocabulary both portals pick from.
  app.use('/api/v1/data-types', dataTypeRoutes)
  app.use('/api/v1/dashboard', dashboardRoutes)
  // Queue and pipeline health for operators. Read-only apart from a manual
  // reaper trigger; see modules/ops for why the DPO is admitted.
  app.use('/api/v1/ops', opsRoutes)
  app.use('/api/v1/dsar', dsarRoutes)
  // The admin-initiated inbound edge. Its own router with its own dataAdmin
  // floor — mounting it under /dsar would have inherited that router's wider
  // dpo/dataOwner floor, and asserting "this photograph is of this person" is
  // not an oversight authority.
  app.use('/api/v1/imports', importRoutes)
  app.use('/api/v1/audit', auditRoutes)
  app.use('/api/v1/provenance', provenanceRoutes)
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
  // Audio, mounted ahead of sessionRoutes for the same reason as the two above:
  // its read routes admit dataOwner and dataAdmin, and sessionRoutes' ROUTER-LEVEL
  // requireRole('collectionAgent','super_admin') runs on every request that
  // reaches that router — whether or not a route inside it matches — so mounted
  // after, those reads 403 before ever arriving here.
  app.use('/api/v1/sessions', recordingRoutes)
  // Video, mounted ahead of sessionRoutes for exactly the reason recordingRoutes
  // is. Its requireVideoEnabled gate is scoped to this router's own subpaths
  // rather than the whole mount, so with VIDEO_CAPTURE_ENABLED unset the video
  // routes 503 and every other /api/v1/sessions route falls through untouched.
  app.use('/api/v1/sessions', videoRoutes)
  // Text documents, mounted ahead of sessionRoutes for the same reason as the
  // three above. This router guards on requireAdminAuth alone, so mounted after
  // sessionRoutes every request to it would hit that router's ROUTER-LEVEL
  // requireRole('collectionAgent','super_admin') first and 403.
  app.use('/api/v1/sessions', documentRoutes)
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
