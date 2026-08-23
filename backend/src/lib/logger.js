import pino from 'pino'
import { IS_PROD } from '../config/env.js'

export const logger = pino({
  level: IS_PROD ? 'info' : 'debug',
  transport:
    IS_PROD
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true } },
})
