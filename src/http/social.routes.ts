import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../db/prisma.js'
import { requireAuth } from './auth.routes.js'
import { send as wsSend } from '../ws/registry.js'

export async function registerSocialRoutes(app: FastifyInstance): Promise<void> {
  // Match history ("who you played with")
  app.get('/matches', { preHandler: requireAuth }, async (req) => {
    const userId = (req as any).userId as string
    const limit = Math.min(parseInt((req.query as any).limit ?? '30'), 100)

    const matches = await db.match.findMany({
      where: {
        OR: [{ player1Id: userId }, { player2Id: userId }],
        finishedAt: { not: null },
      },
      orderBy: { finishedAt: 'desc' },
      take: limit,
    })

    const opponentIds = [
      ...new Set(
        matches.map(m => (m.player1Id === userId ? m.player2Id : m.player1Id)).filter(Boolean) as string[]
      ),
    ]

    const opponents = await db.user.findMany({
      where: { id: { in: opponentIds } },
      select: { id: true, handle: true, skin: true, rating: true },
    })
    const oppMap = new Map(opponents.map(u => [u.id, u]))

    return matches.map(m => {
      const opponentId = m.player1Id === userId ? m.player2Id : m.player1Id
      const opponent = opponentId ? oppMap.get(opponentId) : null
      return {
        matchId: m.id,
        isBot: m.isBot,
        isSuperghost: m.isSuperghost,
        language: m.language,
        word: m.finalWord,
        won: m.winnerId === userId,
        endReason: m.endReason,
        finishedAt: m.finishedAt,
        opponent: opponent
          ? { userId: opponent.id, handle: opponent.handle, skin: opponent.skin, rating: opponent.rating }
          : null,
      }
    })
  })

  // Get match moves (replay)
  app.get('/matches/:matchId/moves', { preHandler: requireAuth }, async (req) => {
    const { matchId } = req.params as { matchId: string }
    const userId = (req as any).userId as string
    const match = await db.match.findUniqueOrThrow({ where: { id: matchId } })
    if (match.player1Id !== userId && match.player2Id !== userId) {
      throw new Error('Not your match')
    }
    return db.move.findMany({ where: { matchId }, orderBy: { ply: 'asc' } })
  })

  // Friends
  app.get('/friends', { preHandler: requireAuth }, async (req) => {
    const userId = (req as any).userId as string
    const friendships = await db.friendship.findMany({
      where: {
        OR: [{ aId: userId }, { bId: userId }],
      },
    })

    const friendIds = friendships.map(f => (f.aId === userId ? f.bId : f.aId))
    const users = await db.user.findMany({
      where: { id: { in: friendIds } },
      select: { id: true, handle: true, skin: true, rating: true },
    })

    return friendships.map(f => ({
      friendshipId: f.id,
      status: f.status,
      friend: users.find(u => u.id === (f.aId === userId ? f.bId : f.aId)),
    }))
  })

  app.post('/friends/request', { preHandler: requireAuth }, async (req, reply) => {
    const userId = (req as any).userId as string
    const schema = z.object({ toUserId: z.string() })
    const { toUserId } = schema.parse(req.body)

    if (toUserId === userId) return reply.status(400).send({ error: 'Cannot friend yourself' })

    const [a, b] = [userId, toUserId].sort()
    const existing = await db.friendship.findUnique({ where: { aId_bId: { aId: a!, bId: b! } } })
    if (existing) return { friendshipId: existing.id, status: existing.status }

    const friendship = await db.friendship.create({ data: { aId: a!, bId: b!, status: 'pending' } })

    // Notify via WS if online
    wsSend(toUserId, { type: 'friendRequest', fromUserId: userId, friendshipId: friendship.id })

    return { friendshipId: friendship.id, status: 'pending' }
  })

  app.post('/friends/accept/:friendshipId', { preHandler: requireAuth }, async (req, reply) => {
    const userId = (req as any).userId as string
    const { friendshipId } = req.params as { friendshipId: string }

    const f = await db.friendship.findUniqueOrThrow({ where: { id: friendshipId } })
    if (f.aId !== userId && f.bId !== userId) return reply.status(403).send({ error: 'Not your friendship' })

    await db.friendship.update({ where: { id: friendshipId }, data: { status: 'accepted' } })
    const notifyId = f.aId === userId ? f.bId : f.aId
    wsSend(notifyId, { type: 'friendAccepted', friendshipId })
    return { ok: true }
  })

  app.delete('/friends/:friendshipId', { preHandler: requireAuth }, async (req, reply) => {
    const userId = (req as any).userId as string
    const { friendshipId } = req.params as { friendshipId: string }
    const f = await db.friendship.findUniqueOrThrow({ where: { id: friendshipId } })
    if (f.aId !== userId && f.bId !== userId) return reply.status(403).send({ error: 'Not your friendship' })
    await db.friendship.delete({ where: { id: friendshipId } })
    return { ok: true }
  })

  // Challenges (async game invites)
  app.post('/challenges', { preHandler: requireAuth }, async (req) => {
    const userId = (req as any).userId as string
    const schema = z.object({ toUserId: z.string() })
    const { toUserId } = schema.parse(req.body)

    const challenge = await db.challengeFrom.create({
      data: {
        fromUserId: userId,
        toUserId,
        expiresAt: new Date(Date.now() + 48 * 3600_000),
      },
    })

    wsSend(toUserId, { type: 'challengeReceived', challengeId: challenge.id, fromUserId: userId })
    return { challengeId: challenge.id }
  })

  app.get('/challenges', { preHandler: requireAuth }, async (req) => {
    const userId = (req as any).userId as string
    return db.challengeFrom.findMany({
      where: { toUserId: userId, status: 'pending', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    })
  })

  app.post('/challenges/:challengeId/accept', { preHandler: requireAuth }, async (req, reply) => {
    const userId = (req as any).userId as string
    const { challengeId } = req.params as { challengeId: string }

    const challenge = await db.challengeFrom.findUniqueOrThrow({ where: { id: challengeId } })
    if (challenge.toUserId !== userId) return reply.status(403).send({ error: 'Not your challenge' })
    if (challenge.status !== 'pending') return reply.status(400).send({ error: 'Challenge not pending' })

    await db.challengeFrom.update({ where: { id: challengeId }, data: { status: 'accepted' } })

    // Notify challenger to join — they'll start a game with host and send invite code
    wsSend(challenge.fromUserId, { type: 'challengeAccepted', challengeId, byUserId: userId })
    return { ok: true }
  })

  app.post('/challenges/:challengeId/decline', { preHandler: requireAuth }, async (req, reply) => {
    const userId = (req as any).userId as string
    const { challengeId } = req.params as { challengeId: string }
    const challenge = await db.challengeFrom.findUniqueOrThrow({ where: { id: challengeId } })
    if (challenge.toUserId !== userId) return reply.status(403).send({ error: 'Not your challenge' })
    await db.challengeFrom.update({ where: { id: challengeId }, data: { status: 'declined' } })
    wsSend(challenge.fromUserId, { type: 'challengeDeclined', challengeId })
    return { ok: true }
  })

  // Achievements
  app.get('/achievements', { preHandler: requireAuth }, async (req) => {
    const userId = (req as any).userId as string
    return db.achievement.findMany({ where: { userId }, orderBy: { unlockedAt: 'desc' } })
  })
}
