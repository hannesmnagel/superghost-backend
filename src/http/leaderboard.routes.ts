import type { FastifyInstance } from 'fastify'
import { db } from '../db/prisma.js'
import { requireAuth } from './auth.routes.js'

export async function registerLeaderboardRoutes(app: FastifyInstance): Promise<void> {
  // Top N globally
  app.get('/leaderboard/top', { preHandler: requireAuth }, async (req) => {
    const limit = Math.min(parseInt((req.query as any).limit ?? '50'), 100)
    const users = await db.user.findMany({
      orderBy: { rating: 'desc' },
      take: limit,
      select: { id: true, handle: true, skin: true, rating: true },
    })

    return users.map((u, i) => ({
      rank: i + 1,
      userId: u.id,
      handle: u.handle,
      skin: u.skin,
      rating: u.rating,
    }))
  })

  // 11-entry window centered on the calling user
  app.get('/leaderboard', { preHandler: requireAuth }, async (req) => {
    const userId = (req as any).userId as string
    const windowSize = 11

    const user = await db.user.findUniqueOrThrow({ where: { id: userId } })

    // Count users with higher rating to get rank
    const above = await db.user.count({ where: { rating: { gt: user.rating } } })
    const myRank = above + 1

    // Get window around the user
    const skip = Math.max(0, myRank - Math.ceil(windowSize / 2))
    const users = await db.user.findMany({
      orderBy: { rating: 'desc' },
      skip,
      take: windowSize,
      select: { id: true, handle: true, skin: true, rating: true },
    })

    return {
      myRank,
      myRating: user.rating,
      entries: users.map((u, i) => ({
        rank: skip + i + 1,
        userId: u.id,
        handle: u.handle,
        skin: u.skin,
        rating: u.rating,
        isMe: u.id === userId,
      })),
    }
  })
}
