import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../db/prisma.js'
import { requireAuth } from './auth.routes.js'
import { signAccessToken } from '../auth/tokens.js'

const HANDLE_RE = /^[a-zA-Z0-9_\-]{2,24}$/
const ALLOWED_SKINS = [
  'Skin/Cowboy', 'Skin/Sailor', 'Skin/Doctor', 'Skin/Knight',
  'Skin/Engineer', 'Skin/Samurai', 'Skin/Christmas',
]

export async function registerProfileRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me', { preHandler: requireAuth }, async (req) => {
    const userId = (req as any).userId as string
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } })
    return { userId: user.id, handle: user.handle, skin: user.skin, rating: user.rating }
  })

  app.patch('/me', { preHandler: requireAuth }, async (req, reply) => {
    const userId = (req as any).userId as string
    const schema = z.object({
      handle: z.string().regex(HANDLE_RE).optional(),
      skin: z.string().optional(),
    })
    const { handle, skin } = schema.parse(req.body)

    if (skin && !ALLOWED_SKINS.includes(skin)) {
      return reply.status(400).send({ error: 'Invalid skin' })
    }
    if (handle) {
      const existing = await db.user.findUnique({ where: { handle } })
      if (existing && existing.id !== userId) {
        return reply.status(409).send({ error: 'Handle already taken' })
      }
    }

    const user = await db.user.update({
      where: { id: userId },
      data: { ...(handle && { handle }), ...(skin && { skin }) },
    })

    // Reissue access token if handle changed (it's in the JWT)
    const accessToken = handle ? signAccessToken({ sub: userId, handle: user.handle }) : undefined
    return { userId: user.id, handle: user.handle, skin: user.skin, rating: user.rating, accessToken }
  })

  // Get any public user profile
  app.get('/users/:userId', { preHandler: requireAuth }, async (req) => {
    const { userId } = req.params as { userId: string }
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } })
    return { userId: user.id, handle: user.handle, skin: user.skin, rating: user.rating }
  })
}
