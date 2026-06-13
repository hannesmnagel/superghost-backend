import type { FastifyInstance } from 'fastify'
import { randomBytes, createHash } from 'crypto'
import { z } from 'zod'
import { db } from '../db/prisma.js'
import {
  signAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  hashSecret,
} from '../auth/tokens.js'
import { verifyAppleToken } from '../auth/apple.js'

function generateHandle(): string {
  const id = randomBytes(3).toString('hex').toUpperCase()
  return `ghost-${id}`
}

function userResponse(user: { id: string; handle: string; skin: string; rating: number }) {
  return { userId: user.id, handle: user.handle, skin: user.skin, rating: user.rating }
}

async function issueTokens(userId: string, handle: string) {
  const accessToken = signAccessToken({ sub: userId, handle })
  const refreshToken = await issueRefreshToken(userId)
  return { accessToken, refreshToken }
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // Guest auth — instant, no friction
  app.post('/auth/guest', async (req, reply) => {
    const schema = z.object({ deviceKey: z.string().min(8).max(256) })
    const { deviceKey } = schema.parse(req.body)

    const secretHash = hashSecret(deviceKey)
    const subject = createHash('sha256').update(deviceKey).digest('hex')

    let identity = await db.authIdentity.findUnique({
      where: { provider_subject: { provider: 'guest', subject } },
      include: { user: true },
    })

    if (!identity) {
      const user = await db.user.create({ data: { handle: generateHandle() } })
      identity = await db.authIdentity.create({
        data: { userId: user.id, provider: 'guest', subject, secretHash },
        include: { user: true },
      })
    }

    const { accessToken, refreshToken } = await issueTokens(identity.userId, identity.user.handle)
    return { accessToken, refreshToken, user: userResponse(identity.user) }
  })

  // Sign in with Apple — merges with existing guest account if deviceKey provided
  app.post('/auth/apple', async (req, reply) => {
    const schema = z.object({
      identityToken: z.string(),
      deviceKey: z.string().optional(), // present when upgrading from guest
    })
    const { identityToken, deviceKey } = schema.parse(req.body)

    const apple = await verifyAppleToken(identityToken)

    let appleIdentity = await db.authIdentity.findUnique({
      where: { provider_subject: { provider: 'apple', subject: apple.sub } },
      include: { user: true },
    })

    if (!appleIdentity) {
      // See if there's a guest account to merge into
      let userId: string

      if (deviceKey) {
        const subject = createHash('sha256').update(deviceKey).digest('hex')
        const guestIdentity = await db.authIdentity.findUnique({
          where: { provider_subject: { provider: 'guest', subject } },
        })
        userId = guestIdentity?.userId ?? (await db.user.create({ data: { handle: generateHandle() } })).id
      } else {
        userId = (await db.user.create({ data: { handle: generateHandle() } })).id
      }

      appleIdentity = await db.authIdentity.create({
        data: { userId, provider: 'apple', subject: apple.sub },
        include: { user: true },
      })
    }

    const { accessToken, refreshToken } = await issueTokens(appleIdentity.userId, appleIdentity.user.handle)
    return { accessToken, refreshToken, user: userResponse(appleIdentity.user) }
  })

  // Refresh tokens
  app.post('/auth/refresh', async (req) => {
    const schema = z.object({ refreshToken: z.string() })
    const { refreshToken } = schema.parse(req.body)

    const { userId, newRaw } = await rotateRefreshToken(refreshToken)
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } })
    const accessToken = signAccessToken({ sub: userId, handle: user.handle })
    return { accessToken, refreshToken: newRaw, user: userResponse(user) }
  })

  // Logout / revoke refresh token
  app.post('/auth/logout', async (req) => {
    const schema = z.object({ refreshToken: z.string() })
    const { refreshToken } = schema.parse(req.body)
    await revokeRefreshToken(refreshToken)
    return { ok: true }
  })

  // Register APNs device token
  app.post('/devices', { preHandler: requireAuth }, async (req) => {
    const schema = z.object({ apnsToken: z.string() })
    const { apnsToken } = schema.parse(req.body)
    const userId = (req as any).userId as string
    await db.device.upsert({
      where: { apnsToken },
      create: { userId, apnsToken },
      update: { userId },
    })
    return { ok: true }
  })
}

// Simple auth middleware — checks Bearer JWT
export async function requireAuth(req: any, reply: any): Promise<void> {
  const auth = req.headers.authorization as string | undefined
  if (!auth?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Unauthorized' })
  }
  try {
    const { verifyAccessToken } = await import('../auth/tokens.js')
    const payload = verifyAccessToken(auth.slice(7))
    req.userId = payload.sub
    req.handle = payload.handle
  } catch {
    return reply.status(401).send({ error: 'Invalid token' })
  }
}
