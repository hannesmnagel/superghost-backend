import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppServices } from '../../app.js'
import { publicUser } from '../../services/auth.js'
import { makeRequireAuth, userId, notFound, conflict } from './common.js'

const HANDLE_RE = /^[a-zA-Z0-9_\-]{2,24}$/
const ALLOWED_SKINS = [
  'Skin/Cowboy', 'Skin/Sailor', 'Skin/Doctor', 'Skin/Knight',
  'Skin/Engineer', 'Skin/Samurai', 'Skin/Christmas',
]

export function registerProfileRoutes(app: FastifyInstance, services: AppServices): void {
  const requireAuth = makeRequireAuth(services)
  const { users } = services.repos

  app.get('/me', { preHandler: requireAuth }, async (req) => {
    const user = await users.findById(userId(req))
    if (!user) throw notFound('User not found')
    return publicUser(user)
  })

  app.patch('/me', { preHandler: requireAuth }, async (req) => {
    const { handle, skin } = z
      .object({ handle: z.string().regex(HANDLE_RE).optional(), skin: z.string().optional() })
      .parse(req.body)

    if (skin && !ALLOWED_SKINS.includes(skin)) throw conflict('Invalid skin')
    if (handle) {
      const existing = await users.findByHandle(handle)
      if (existing && existing.id !== userId(req)) throw conflict('Handle already taken')
    }

    const user = await users.update(userId(req), {
      ...(handle && { handle }),
      ...(skin && { skin }),
    })
    const accessToken = handle ? services.tokens.signAccessToken({ sub: user.id, handle: user.handle }) : undefined
    return { ...publicUser(user), accessToken }
  })

  // Delete account — cascades identities, tokens, devices, friendships, challenges, achievements.
  app.delete('/me', { preHandler: requireAuth }, async (req) => {
    await services.auth.deleteAccount(userId(req))
    return { ok: true }
  })

  app.get('/users/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string }
    const user = await users.findById(id)
    if (!user) throw notFound('User not found')
    return publicUser(user)
  })
}
