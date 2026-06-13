import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { config } from '../config.js'
import { registerAuthRoutes } from './auth.routes.js'
import { registerLeaderboardRoutes } from './leaderboard.routes.js'
import { registerSocialRoutes } from './social.routes.js'
import { registerWordsRoutes } from './words.routes.js'
import { registerProfileRoutes } from './profile.routes.js'

export async function createHttpServer() {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    },
  })

  await app.register(cors, {
    origin: true,
    credentials: true,
  })

  await app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
  })

  // Health check
  app.get('/health', async () => ({ ok: true, version: '2.0.0' }))

  // Routes
  await registerAuthRoutes(app)
  await registerLeaderboardRoutes(app)
  await registerSocialRoutes(app)
  await registerWordsRoutes(app)
  await registerProfileRoutes(app)

  return app
}
