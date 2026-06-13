import type { PrismaClient } from '@prisma/client'
import type {
  Repositories,
  UserRecord,
  IdentityRecord,
  MatchRecord,
  MoveInput,
  MatchInput,
  FriendshipRecord,
  ChallengeRecord,
  AchievementRecord,
} from './repositories.js'

function toUser(u: any): UserRecord {
  return {
    id: u.id,
    handle: u.handle,
    skin: u.skin,
    rating: u.rating,
    isBot: u.isBot,
    botLevel: u.botLevel ?? null,
    createdAt: u.createdAt,
    lastSeenAt: u.lastSeenAt,
  }
}

function toMatch(m: any): MatchRecord {
  return {
    id: m.id,
    player1Id: m.player1Id,
    player2Id: m.player2Id ?? null,
    isBot: m.isBot,
    isSuperghost: m.isSuperghost,
    language: m.language,
    finalWord: m.finalWord,
    winnerId: m.winnerId ?? null,
    loserId: m.loserId ?? null,
    endReason: m.endReason ?? null,
    finishedAt: m.finishedAt ?? null,
  }
}

function toFriendship(f: any): FriendshipRecord {
  return { id: f.id, aId: f.aId, bId: f.bId, status: f.status }
}

function toChallenge(c: any): ChallengeRecord {
  return {
    id: c.id,
    fromUserId: c.fromUserId,
    toUserId: c.toUserId,
    status: c.status,
    expiresAt: c.expiresAt,
    createdAt: c.createdAt,
  }
}

export function createPrismaRepositories(db: PrismaClient): Repositories {
  return {
    users: {
      async findById(id) {
        const u = await db.user.findUnique({ where: { id } })
        return u ? toUser(u) : null
      },
      async findByHandle(handle) {
        const u = await db.user.findUnique({ where: { handle } })
        return u ? toUser(u) : null
      },
      async findManyByIds(ids) {
        if (ids.length === 0) return []
        const us = await db.user.findMany({ where: { id: { in: ids } } })
        return us.map(toUser)
      },
      async create(data) {
        const u = await db.user.create({ data })
        return toUser(u)
      },
      async update(id, data) {
        const u = await db.user.update({ where: { id }, data })
        return toUser(u)
      },
      async touchLastSeen(id) {
        await db.user.update({ where: { id }, data: { lastSeenAt: new Date() } }).catch(() => {})
      },
      async delete(id) {
        await db.user.delete({ where: { id } })
      },
      async topByRating(limit) {
        const us = await db.user.findMany({ orderBy: { rating: 'desc' }, take: limit })
        return us.map(toUser)
      },
      async countWithRatingAbove(rating) {
        return db.user.count({ where: { rating: { gt: rating } } })
      },
      async windowByRating(skip, take) {
        const us = await db.user.findMany({ orderBy: { rating: 'desc' }, skip, take })
        return us.map(toUser)
      },
      async listBots() {
        const us = await db.user.findMany({ where: { isBot: true }, orderBy: { rating: 'asc' } })
        return us.map(toUser)
      },
    },

    auth: {
      async findIdentity(provider, subject) {
        const i = await db.authIdentity.findUnique({
          where: { provider_subject: { provider, subject } },
          include: { user: true },
        })
        if (!i) return null
        return {
          id: i.id,
          userId: i.userId,
          provider: i.provider,
          subject: i.subject,
          secretHash: i.secretHash ?? null,
          user: toUser(i.user),
        }
      },
      async createIdentity(data) {
        const i = await db.authIdentity.create({
          data: { userId: data.userId, provider: data.provider, subject: data.subject, secretHash: data.secretHash ?? null },
        })
        return { id: i.id, userId: i.userId, provider: i.provider, subject: i.subject, secretHash: i.secretHash ?? null } as IdentityRecord
      },
      async createRefreshToken(userId, tokenHash, expiresAt) {
        await db.refreshToken.create({ data: { userId, tokenHash, expiresAt } })
      },
      async findRefreshToken(tokenHash) {
        const t = await db.refreshToken.findUnique({ where: { tokenHash } })
        return t ? { id: t.id, userId: t.userId, expiresAt: t.expiresAt, revokedAt: t.revokedAt ?? null } : null
      },
      async revokeRefreshTokenById(id) {
        await db.refreshToken.update({ where: { id }, data: { revokedAt: new Date() } })
      },
      async revokeRefreshTokenByHash(tokenHash) {
        await db.refreshToken.updateMany({ where: { tokenHash }, data: { revokedAt: new Date() } })
      },
      async upsertDevice(userId, apnsToken) {
        await db.device.upsert({ where: { apnsToken }, create: { userId, apnsToken }, update: { userId } })
      },
    },

    matches: {
      async create(data: MatchInput) {
        const m = await db.match.create({
          data: {
            id: data.id,
            player1Id: data.player1Id,
            player2Id: data.player2Id,
            isBot: data.isBot,
            isPrivate: data.isPrivate,
            isSuperghost: data.isSuperghost,
            language: data.language,
            finalWord: data.finalWord,
            winnerId: data.winnerId,
            loserId: data.loserId,
            endReason: data.endReason,
            ratingP1Before: data.ratingP1Before,
            ratingP2Before: data.ratingP2Before,
            ratingP1After: data.ratingP1After,
            ratingP2After: data.ratingP2After,
            finishedAt: data.finishedAt,
            moves: { create: data.moves },
          },
        })
        return { id: m.id }
      },
      async findById(id) {
        const m = await db.match.findUnique({ where: { id } })
        return m ? toMatch(m) : null
      },
      async listForUser(userId, limit) {
        const ms = await db.match.findMany({
          where: { OR: [{ player1Id: userId }, { player2Id: userId }], finishedAt: { not: null } },
          orderBy: { finishedAt: 'desc' },
          take: limit,
        })
        return ms.map(toMatch)
      },
      async movesForMatch(matchId): Promise<MoveInput[]> {
        const moves = await db.move.findMany({ where: { matchId }, orderBy: { ply: 'asc' } })
        return moves.map(m => ({ ply: m.ply, byUserId: m.byUserId, action: m.action, letter: m.letter ?? null, wordAfter: m.wordAfter }))
      },
    },

    friends: {
      async listForUser(userId) {
        const fs = await db.friendship.findMany({ where: { OR: [{ aId: userId }, { bId: userId }] } })
        return fs.map(toFriendship)
      },
      async find(aId, bId) {
        const f = await db.friendship.findUnique({ where: { aId_bId: { aId, bId } } })
        return f ? toFriendship(f) : null
      },
      async findById(id) {
        const f = await db.friendship.findUnique({ where: { id } })
        return f ? toFriendship(f) : null
      },
      async create(aId, bId) {
        const f = await db.friendship.create({ data: { aId, bId, status: 'pending' } })
        return toFriendship(f)
      },
      async updateStatus(id, status) {
        await db.friendship.update({ where: { id }, data: { status } })
      },
      async delete(id) {
        await db.friendship.delete({ where: { id } })
      },
    },

    challenges: {
      async create(fromUserId, toUserId, expiresAt) {
        const c = await db.challengeFrom.create({ data: { fromUserId, toUserId, expiresAt } })
        return toChallenge(c)
      },
      async listPending(userId) {
        const cs = await db.challengeFrom.findMany({
          where: { toUserId: userId, status: 'pending', expiresAt: { gt: new Date() } },
          orderBy: { createdAt: 'desc' },
        })
        return cs.map(toChallenge)
      },
      async findById(id) {
        const c = await db.challengeFrom.findUnique({ where: { id } })
        return c ? toChallenge(c) : null
      },
      async updateStatus(id, status) {
        await db.challengeFrom.update({ where: { id }, data: { status } })
      },
    },

    achievements: {
      async listForUser(userId): Promise<AchievementRecord[]> {
        const as = await db.achievement.findMany({ where: { userId }, orderBy: { unlockedAt: 'desc' } })
        return as.map(a => ({ id: a.id, userId: a.userId, key: a.key, progress: a.progress, unlockedAt: a.unlockedAt ?? null }))
      },
    },

    words: {
      async find(word, language) {
        const v = await db.wordVerdict.findUnique({ where: { word_language: { word, language } } })
        return v ? { valid: v.valid } : null
      },
      async upsert(word, language, valid, reason) {
        await db.wordVerdict.upsert({
          where: { word_language: { word, language } },
          create: { word, language, valid, reason },
          update: { valid, reason },
        })
      },
    },
  }
}
