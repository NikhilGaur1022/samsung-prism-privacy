import 'dotenv/config'
import { createApp } from './app.js'
import { logger } from './lib/logger.js'
import { IS_PROD } from './config/env.js'

// Boot guard: refuse to start in production without real auth wired in.
// requireAuth.js is a dev-stub only — this stops it from silently shipping.
if (IS_PROD && process.env.AUTH_PROVIDER !== 'real') {
  logger.error('Refusing to start in production without a real auth provider configured (AUTH_PROVIDER=real).')
  process.exit(1)
}

const app = createApp()
const port = process.env.PORT ?? 4000

app.listen(port, () => {
  logger.info(`Prism backend listening on port ${port}`)
})
