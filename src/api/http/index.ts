import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import type { AppServices } from '../../app.js'
import { registerErrorHandler } from './common.js'
import { registerAuthRoutes } from './authRoutes.js'
import { registerProfileRoutes } from './profileRoutes.js'
import { registerLeaderboardRoutes } from './leaderboardRoutes.js'
import { registerSocialRoutes } from './socialRoutes.js'
import { registerWordsRoutes } from './wordsRoutes.js'

export interface HttpServerOptions {
  logLevel?: string
}

/** Register all HTTP routes on a fresh Fastify instance. */
export async function createHttpServer(services: AppServices, opts: HttpServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: opts.logLevel ?? 'info' } })

  await app.register(cors, { origin: true, credentials: true })
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' })
  registerErrorHandler(app)

  app.get('/health', async () => ({ ok: true, version: '2.0.0' }))

  registerAuthRoutes(app, services)
  registerProfileRoutes(app, services)
  registerLeaderboardRoutes(app, services)
  registerSocialRoutes(app, services)
  registerWordsRoutes(app, services)

  await app.ready()
  return app
}
