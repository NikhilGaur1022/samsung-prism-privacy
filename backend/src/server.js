import 'dotenv/config'
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
import { sessionRoutes } from './modules/sessions/session.routes.js'
import { consentRoutes } from './modules/consent/consent.routes.js'

// Boot guard: refuse to start in production without real auth wired in.
// requireAuth.js is a dev-stub only — this stops it from silently shipping.
if (process.env.NODE_ENV === 'production' && process.env.AUTH_PROVIDER !== 'real') {
  logger.error('Refusing to start in production without a real auth provider configured (AUTH_PROVIDER=real).')
  process.exit(1)
}

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
  const result = { postgres: false, qdrant: false }

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

  const allHealthy = Object.values(result).every(Boolean)
  res.status(allHealthy ? 200 : 503).json(result)
})

app.use('/api/v1/subjects', subjectRoutes)
app.use('/api/v1/projects', projectRoutes)
app.use('/api/v1/sessions', sessionRoutes)
app.use('/api/v1/consent', consentRoutes)
app.use('/auth/subject', authSubjectRoutes)
app.use('/auth/admin', authAdminRoutes)

app.use(errorHandler)

const port = process.env.PORT ?? 4000
app.listen(port, () => {
  logger.info(`Prism backend listening on port ${port}`)
})
