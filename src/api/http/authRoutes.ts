import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppServices } from '../../app.js'
import { makeRequireAuth, userId } from './common.js'

export function registerAuthRoutes(app: FastifyInstance, services: AppServices): void {
  const requireAuth = makeRequireAuth(services)

  app.post('/auth/guest', async (req) => {
    const { deviceKey } = z.object({ deviceKey: z.string().min(8).max(256) }).parse(req.body)
    return services.auth.guest(deviceKey)
  })

  app.post('/auth/apple', async (req) => {
    const { identityToken, deviceKey } = z
      .object({ identityToken: z.string(), deviceKey: z.string().optional() })
      .parse(req.body)
    return services.auth.apple(identityToken, deviceKey)
  })

  app.post('/auth/refresh', async (req) => {
    const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body)
    return services.auth.refresh(refreshToken)
  })

  app.post('/auth/logout', async (req) => {
    const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body)
    await services.auth.logout(refreshToken)
    return { ok: true }
  })

  app.post('/devices', { preHandler: requireAuth }, async (req) => {
    const { apnsToken } = z.object({ apnsToken: z.string() }).parse(req.body)
    await services.auth.registerDevice(userId(req), apnsToken)
    return { ok: true }
  })
}
