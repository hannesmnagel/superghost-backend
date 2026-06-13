import { randomUUID, randomBytes } from 'crypto'
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

interface RefreshRow {
  id: string
  userId: string
  tokenHash: string
  expiresAt: Date
  revokedAt: Date | null
}

/** Fully in-memory Repositories — exercises the whole stack in tests with no database. */
export function createMemoryRepositories(): Repositories & { _reset(): void } {
  const users = new Map<string, UserRecord>()
  const identities: (IdentityRecord & {})[] = []
  const refreshTokens: RefreshRow[] = []
  const devices = new Map<string, string>() // apnsToken -> userId
  const matches = new Map<string, MatchInput>()
  const friendships: FriendshipRecord[] = []
  const challenges: ChallengeRecord[] = []
  const achievements: AchievementRecord[] = []
  const verdicts = new Map<string, { valid: boolean }>()

  const clone = <T>(v: T): T => ({ ...v }) as T

  return {
    _reset() {
      users.clear()
      identities.length = 0
      refreshTokens.length = 0
      devices.clear()
      matches.clear()
      friendships.length = 0
      challenges.length = 0
      achievements.length = 0
      verdicts.clear()
    },

    users: {
      async findById(id) {
        const u = users.get(id)
        return u ? clone(u) : null
      },
      async findByHandle(handle) {
        for (const u of users.values()) if (u.handle === handle) return clone(u)
        return null
      },
      async findManyByIds(ids) {
        return ids.map(id => users.get(id)).filter(Boolean).map(u => clone(u!))
      },
      async create(data) {
        const now = new Date()
        const u: UserRecord = {
          id: randomUUID(),
          handle: data.handle,
          skin: data.skin ?? 'Skin/Cowboy',
          rating: data.rating ?? 1000,
          isBot: data.isBot ?? false,
          botLevel: data.botLevel ?? null,
          createdAt: now,
          lastSeenAt: now,
        }
        if ([...users.values()].some(x => x.handle === u.handle)) throw new Error('handle taken')
        users.set(u.id, u)
        return clone(u)
      },
      async update(id, data) {
        const u = users.get(id)
        if (!u) throw new Error('user not found')
        if (data.handle && [...users.values()].some(x => x.handle === data.handle && x.id !== id)) {
          throw new Error('handle taken')
        }
        Object.assign(u, data)
        return clone(u)
      },
      async touchLastSeen(id) {
        const u = users.get(id)
        if (u) u.lastSeenAt = new Date()
      },
      async delete(id) {
        users.delete(id)
        for (let i = identities.length - 1; i >= 0; i--) if (identities[i]!.userId === id) identities.splice(i, 1)
        for (let i = refreshTokens.length - 1; i >= 0; i--) if (refreshTokens[i]!.userId === id) refreshTokens.splice(i, 1)
        for (let i = friendships.length - 1; i >= 0; i--) if (friendships[i]!.aId === id || friendships[i]!.bId === id) friendships.splice(i, 1)
        for (let i = challenges.length - 1; i >= 0; i--) if (challenges[i]!.fromUserId === id || challenges[i]!.toUserId === id) challenges.splice(i, 1)
        for (let i = achievements.length - 1; i >= 0; i--) if (achievements[i]!.userId === id) achievements.splice(i, 1)
        for (const [token, uid] of devices) if (uid === id) devices.delete(token)
      },
      async topByRating(limit) {
        return sortByRating([...users.values()]).slice(0, limit).map(clone)
      },
      async countWithRatingAbove(rating) {
        return [...users.values()].filter(u => u.rating > rating).length
      },
      async windowByRating(skip, take) {
        return sortByRating([...users.values()]).slice(skip, skip + take).map(clone)
      },
      async listBots() {
        return [...users.values()].filter(u => u.isBot).sort((a, b) => a.rating - b.rating).map(clone)
      },
    },

    auth: {
      async findIdentity(provider, subject) {
        const i = identities.find(x => x.provider === provider && x.subject === subject)
        if (!i) return null
        const u = users.get(i.userId)
        if (!u) return null
        return { ...clone(i), user: clone(u) }
      },
      async createIdentity(data) {
        const i: IdentityRecord = {
          id: randomUUID(),
          userId: data.userId,
          provider: data.provider,
          subject: data.subject,
          secretHash: data.secretHash ?? null,
        }
        identities.push(i)
        return clone(i)
      },
      async createRefreshToken(userId, tokenHash, expiresAt) {
        refreshTokens.push({ id: randomUUID(), userId, tokenHash, expiresAt, revokedAt: null })
      },
      async findRefreshToken(tokenHash) {
        const t = refreshTokens.find(x => x.tokenHash === tokenHash)
        return t ? { id: t.id, userId: t.userId, expiresAt: t.expiresAt, revokedAt: t.revokedAt } : null
      },
      async revokeRefreshTokenById(id) {
        const t = refreshTokens.find(x => x.id === id)
        if (t) t.revokedAt = new Date()
      },
      async revokeRefreshTokenByHash(tokenHash) {
        for (const t of refreshTokens) if (t.tokenHash === tokenHash) t.revokedAt = new Date()
      },
      async upsertDevice(userId, apnsToken) {
        devices.set(apnsToken, userId)
      },
    },

    matches: {
      async create(data: MatchInput) {
        matches.set(data.id, { ...data, moves: data.moves.map(m => ({ ...m })) })
        return { id: data.id }
      },
      async findById(id) {
        const m = matches.get(id)
        return m ? matchToRecord(m) : null
      },
      async listForUser(userId, limit) {
        return [...matches.values()]
          .filter(m => m.player1Id === userId || m.player2Id === userId)
          .sort((a, b) => b.finishedAt.getTime() - a.finishedAt.getTime())
          .slice(0, limit)
          .map(matchToRecord)
      },
      async movesForMatch(matchId): Promise<MoveInput[]> {
        const m = matches.get(matchId)
        return m ? m.moves.map(x => ({ ...x })) : []
      },
    },

    friends: {
      async listForUser(userId) {
        return friendships.filter(f => f.aId === userId || f.bId === userId).map(clone)
      },
      async find(aId, bId) {
        const f = friendships.find(x => x.aId === aId && x.bId === bId)
        return f ? clone(f) : null
      },
      async findById(id) {
        const f = friendships.find(x => x.id === id)
        return f ? clone(f) : null
      },
      async create(aId, bId) {
        const f: FriendshipRecord = { id: randomUUID(), aId, bId, status: 'pending' }
        friendships.push(f)
        return clone(f)
      },
      async updateStatus(id, status) {
        const f = friendships.find(x => x.id === id)
        if (f) f.status = status
      },
      async delete(id) {
        const i = friendships.findIndex(x => x.id === id)
        if (i >= 0) friendships.splice(i, 1)
      },
    },

    challenges: {
      async create(fromUserId, toUserId, expiresAt) {
        const c: ChallengeRecord = { id: randomUUID(), fromUserId, toUserId, status: 'pending', expiresAt, createdAt: new Date() }
        challenges.push(c)
        return clone(c)
      },
      async listPending(userId) {
        const now = Date.now()
        return challenges
          .filter(c => c.toUserId === userId && c.status === 'pending' && c.expiresAt.getTime() > now)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map(clone)
      },
      async findById(id) {
        const c = challenges.find(x => x.id === id)
        return c ? clone(c) : null
      },
      async updateStatus(id, status) {
        const c = challenges.find(x => x.id === id)
        if (c) c.status = status
      },
    },

    achievements: {
      async listForUser(userId): Promise<AchievementRecord[]> {
        return achievements.filter(a => a.userId === userId).map(clone)
      },
    },

    words: {
      async find(word, language) {
        const v = verdicts.get(`${word}|${language}`)
        return v ? { valid: v.valid } : null
      },
      async upsert(word, language, valid) {
        verdicts.set(`${word}|${language}`, { valid })
      },
    },
  }

  function sortByRating(list: UserRecord[]): UserRecord[] {
    return list.sort((a, b) => (b.rating - a.rating) || a.id.localeCompare(b.id))
  }

  function matchToRecord(m: MatchInput): MatchRecord {
    return {
      id: m.id,
      player1Id: m.player1Id,
      player2Id: m.player2Id,
      isBot: m.isBot,
      isSuperghost: m.isSuperghost,
      language: m.language,
      finalWord: m.finalWord,
      winnerId: m.winnerId,
      loserId: m.loserId,
      endReason: m.endReason,
      finishedAt: m.finishedAt,
    }
  }
}

/** Generates a random hex string — handy for tests seeding device keys etc. */
export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString('hex')
}
