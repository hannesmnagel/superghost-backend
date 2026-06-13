import type { FastifyInstance } from 'fastify'
import type { AppServices } from '../../app.js'
import type { UserRecord } from '../../data/repositories.js'
import { makeRequireAuth, userId, notFound } from './common.js'

function entry(u: UserRecord, rank: number, meId?: string) {
  return {
    rank,
    userId: u.id,
    handle: u.handle,
    skin: u.skin,
    rating: u.rating,
    isBot: u.isBot,
    ...(meId !== undefined && { isMe: u.id === meId }),
  }
}

export function registerLeaderboardRoutes(app: FastifyInstance, services: AppServices): void {
  const requireAuth = makeRequireAuth(services)
  const { users } = services.repos

  // Global top N (bots included — they hold real ratings).
  app.get('/leaderboard/top', { preHandler: requireAuth }, async (req) => {
    const limit = Math.min(parseInt((req.query as any).limit ?? '50', 10) || 50, 100)
    const top = await users.topByRating(limit)
    return top.map((u, i) => entry(u, i + 1))
  })

  // 11-entry window centered on the calling user.
  app.get('/leaderboard', { preHandler: requireAuth }, async (req) => {
    const me = await users.findById(userId(req))
    if (!me) throw notFound('User not found')
    const windowSize = 11
    const above = await users.countWithRatingAbove(me.rating)
    const myRank = above + 1
    const skip = Math.max(0, myRank - Math.ceil(windowSize / 2))
    const window = await users.windowByRating(skip, windowSize)
    return {
      myRank,
      myRating: me.rating,
      entries: window.map((u, i) => entry(u, skip + i + 1, me.id)),
    }
  })
}
