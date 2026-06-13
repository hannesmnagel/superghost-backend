import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppServices } from '../../app.js'
import { makeRequireAuth, userId, badRequest, forbidden, notFound } from './common.js'
import { send as wsSend } from '../ws/registry.js'
import { wireGameBroadcast } from '../ws/broadcast.js'

export function registerSocialRoutes(app: FastifyInstance, services: AppServices): void {
  const requireAuth = makeRequireAuth(services)
  const { matches, friends, challenges, achievements, users } = services.repos

  // Match history.
  app.get('/matches', { preHandler: requireAuth }, async (req) => {
    const me = userId(req)
    const limit = Math.min(parseInt((req.query as any).limit ?? '30', 10) || 30, 100)
    const list = await matches.listForUser(me, limit)

    const opponentIds = [...new Set(list.map(m => (m.player1Id === me ? m.player2Id : m.player1Id)).filter(Boolean) as string[])]
    const opponents = await users.findManyByIds(opponentIds)
    const byId = new Map(opponents.map(u => [u.id, u]))

    return list.map(m => {
      const oppId = m.player1Id === me ? m.player2Id : m.player1Id
      const opp = oppId ? byId.get(oppId) : null
      return {
        matchId: m.id,
        isBot: m.isBot,
        isSuperghost: m.isSuperghost,
        language: m.language,
        word: m.finalWord,
        won: m.winnerId === me,
        endReason: m.endReason,
        finishedAt: m.finishedAt,
        opponent: opp ? { userId: opp.id, handle: opp.handle, skin: opp.skin, rating: opp.rating, isBot: opp.isBot } : null,
      }
    })
  })

  app.get('/matches/:matchId/moves', { preHandler: requireAuth }, async (req) => {
    const me = userId(req)
    const { matchId } = req.params as { matchId: string }
    const match = await matches.findById(matchId)
    if (!match) throw notFound('Match not found')
    if (match.player1Id !== me && match.player2Id !== me) throw forbidden('Not your match')
    return matches.movesForMatch(matchId)
  })

  // Friends.
  app.get('/friends', { preHandler: requireAuth }, async (req) => {
    const me = userId(req)
    const list = await friends.listForUser(me)
    const friendIds = list.map(f => (f.aId === me ? f.bId : f.aId))
    const people = await users.findManyByIds(friendIds)
    const byId = new Map(people.map(u => [u.id, u]))
    return list.map(f => {
      const fid = f.aId === me ? f.bId : f.aId
      const u = byId.get(fid)
      return {
        friendshipId: f.id,
        status: f.status,
        friend: u ? { userId: u.id, handle: u.handle, skin: u.skin, rating: u.rating, isBot: u.isBot } : null,
      }
    })
  })

  app.post('/friends/request', { preHandler: requireAuth }, async (req) => {
    const me = userId(req)
    const { toUserId } = z.object({ toUserId: z.string() }).parse(req.body)
    if (toUserId === me) throw badRequest('Cannot friend yourself')
    const [a, b] = [me, toUserId].sort() as [string, string]
    const existing = await friends.find(a, b)
    if (existing) return { friendshipId: existing.id, status: existing.status }
    const f = await friends.create(a, b)

    // Bots accept instantly (they have no client to confirm) — keeps them indistinguishable.
    const target = await users.findById(toUserId)
    if (target?.isBot) {
      await friends.updateStatus(f.id, 'accepted')
      return { friendshipId: f.id, status: 'accepted' }
    }

    wsSend(toUserId, { type: 'friendRequest', fromUserId: me, friendshipId: f.id })
    const sender = await users.findById(me)
    void services.apns.sendToUser(toUserId, {
      title: 'New friend request',
      body: `${sender?.handle ?? 'Someone'} wants to be friends`,
      data: { kind: 'friendRequest', fromUserId: me },
    })
    return { friendshipId: f.id, status: 'pending' }
  })

  app.post('/friends/accept/:friendshipId', { preHandler: requireAuth }, async (req) => {
    const me = userId(req)
    const { friendshipId } = req.params as { friendshipId: string }
    const f = await friends.findById(friendshipId)
    if (!f) throw notFound('Friendship not found')
    if (f.aId !== me && f.bId !== me) throw forbidden('Not your friendship')
    await friends.updateStatus(friendshipId, 'accepted')
    wsSend(f.aId === me ? f.bId : f.aId, { type: 'friendAccepted', friendshipId })
    return { ok: true }
  })

  app.delete('/friends/:friendshipId', { preHandler: requireAuth }, async (req) => {
    const me = userId(req)
    const { friendshipId } = req.params as { friendshipId: string }
    const f = await friends.findById(friendshipId)
    if (!f) throw notFound('Friendship not found')
    if (f.aId !== me && f.bId !== me) throw forbidden('Not your friendship')
    await friends.delete(friendshipId)
    return { ok: true }
  })

  // Challenges (async game invites).
  app.post('/challenges', { preHandler: requireAuth }, async (req) => {
    const me = userId(req)
    const { toUserId } = z.object({ toUserId: z.string() }).parse(req.body)

    // Challenging a bot starts the match immediately (no accept step needed).
    const target = await users.findById(toUserId)
    if (target?.isBot) {
      const game = await services.matches.createChallengeMatch(me, toUserId)
      wireGameBroadcast(game, services)
      wsSend(me, { type: 'matchReady', matchId: game.id, match: game.getState() })
      return { started: true, matchId: game.id }
    }

    const c = await challenges.create(me, toUserId, new Date(Date.now() + 48 * 3600_000))
    wsSend(toUserId, { type: 'challengeReceived', challengeId: c.id, fromUserId: me })
    const challenger = await users.findById(me)
    void services.apns.sendToUser(toUserId, {
      title: 'Game challenge',
      body: `${challenger?.handle ?? 'Someone'} challenged you to a game`,
      data: { kind: 'challenge', challengeId: c.id, fromUserId: me },
    })
    return { challengeId: c.id }
  })

  app.get('/challenges', { preHandler: requireAuth }, async (req) => {
    return challenges.listPending(userId(req))
  })

  app.post('/challenges/:challengeId/accept', { preHandler: requireAuth }, async (req) => {
    const me = userId(req)
    const { challengeId } = req.params as { challengeId: string }
    const c = await challenges.findById(challengeId)
    if (!c) throw notFound('Challenge not found')
    if (c.toUserId !== me) throw forbidden('Not your challenge')
    if (c.status !== 'pending') throw badRequest('Challenge not pending')

    // Seat both players into a fresh private match and tell them to start.
    let game
    try {
      game = await services.matches.createChallengeMatch(c.fromUserId, me)
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : 'Could not start match')
    }
    await challenges.updateStatus(challengeId, 'accepted')
    wireGameBroadcast(game, services)
    const ready = { type: 'matchReady', matchId: game.id, match: game.getState() }
    wsSend(c.fromUserId, ready)
    wsSend(me, ready)
    return { ok: true, matchId: game.id }
  })

  // The sender withdraws a still-pending challenge (e.g. they left the waiting screen).
  app.post('/challenges/:challengeId/cancel', { preHandler: requireAuth }, async (req) => {
    const me = userId(req)
    const { challengeId } = req.params as { challengeId: string }
    const c = await challenges.findById(challengeId)
    if (!c) throw notFound('Challenge not found')
    if (c.fromUserId !== me) throw forbidden('Not your challenge')
    await challenges.updateStatus(challengeId, 'cancelled')
    wsSend(c.toUserId, { type: 'challengeWithdrawn', challengeId })
    return { ok: true }
  })

  app.post('/challenges/:challengeId/decline', { preHandler: requireAuth }, async (req) => {
    const me = userId(req)
    const { challengeId } = req.params as { challengeId: string }
    const c = await challenges.findById(challengeId)
    if (!c) throw notFound('Challenge not found')
    if (c.toUserId !== me) throw forbidden('Not your challenge')
    await challenges.updateStatus(challengeId, 'declined')
    wsSend(c.fromUserId, { type: 'challengeDeclined', challengeId })
    return { ok: true }
  })

  app.get('/achievements', { preHandler: requireAuth }, async (req) => {
    return achievements.listForUser(userId(req))
  })
}
