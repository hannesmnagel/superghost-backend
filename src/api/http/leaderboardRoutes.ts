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

  // Global ranked list, paginated (bots included — they hold real ratings).
  // ?limit=50&offset=0 — lets the client page through the entire leaderboard.
  app.get('/leaderboard/top', { preHandler: requireAuth }, async (req) => {
    const q = req.query as { limit?: string; offset?: string }
    const limit = Math.min(parseInt(q.limit ?? '50', 10) || 50, 100)
    const offset = Math.max(0, parseInt(q.offset ?? '0', 10) || 0)
    const rows = await users.windowByRating(offset, limit)
    return rows.map((u, i) => entry(u, offset + i + 1))
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
