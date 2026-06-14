// Repository interfaces — the persistence ports the service layer depends on.
// Two implementations exist: Prisma (production) and in-memory (tests).

export type BotLevel = 'easy' | 'medium' | 'hard'

export interface UserRecord {
  id: string
  handle: string
  skin: string
  rating: number
  isBot: boolean
  botLevel: string | null
  createdAt: Date
  lastSeenAt: Date
}

export interface IdentityRecord {
  id: string
  userId: string
  provider: string
  subject: string
  secretHash: string | null
}

export interface MoveInput {
  ply: number
  byUserId: string
  action: string
  letter: string | null
  wordAfter: string
}

export interface MatchInput {
  id: string
  player1Id: string
  player2Id: string | null
  isBot: boolean
  isPrivate: boolean
  isSuperghost: boolean
  language: string
  finalWord: string
  winnerId: string | null
  loserId: string | null
  endReason: string | null
  ratingP1Before: number
  ratingP2Before: number
  ratingP1After: number
  ratingP2After: number
  finishedAt: Date
  moves: MoveInput[]
}

export interface MatchRecord {
  id: string
  player1Id: string
  player2Id: string | null
  isBot: boolean
  isSuperghost: boolean
  language: string
  finalWord: string
  winnerId: string | null
  loserId: string | null
  endReason: string | null
  finishedAt: Date | null
}

export interface FriendshipRecord {
  id: string
  aId: string
  bId: string
  status: string
}

export interface ChallengeRecord {
  id: string
  fromUserId: string
  toUserId: string
  status: string
  expiresAt: Date
  createdAt: Date
}

export interface AchievementRecord {
  id: string
  userId: string
  key: string
  progress: number
  unlockedAt: Date | null
}

export interface UserRepository {
  findById(id: string): Promise<UserRecord | null>
  findByHandle(handle: string): Promise<UserRecord | null>
  findManyByIds(ids: string[]): Promise<UserRecord[]>
  create(data: { handle: string; skin?: string; rating?: number; isBot?: boolean; botLevel?: string | null }): Promise<UserRecord>
  update(id: string, data: Partial<Pick<UserRecord, 'handle' | 'skin' | 'rating'>>): Promise<UserRecord>
  touchLastSeen(id: string): Promise<void>
  delete(id: string): Promise<void>
  topByRating(limit: number): Promise<UserRecord[]>
  countWithRatingAbove(rating: number): Promise<number>
  windowByRating(skip: number, take: number): Promise<UserRecord[]>
  listBots(): Promise<UserRecord[]>
}

export interface AuthRepository {
  findIdentity(provider: string, subject: string): Promise<(IdentityRecord & { user: UserRecord }) | null>
  createIdentity(data: { userId: string; provider: string; subject: string; secretHash?: string | null }): Promise<IdentityRecord>
  createRefreshToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void>
  findRefreshToken(tokenHash: string): Promise<{ id: string; userId: string; expiresAt: Date; revokedAt: Date | null } | null>
  revokeRefreshTokenById(id: string): Promise<void>
  revokeRefreshTokenByHash(tokenHash: string): Promise<void>
  upsertDevice(userId: string, apnsToken: string): Promise<void>
  devicesForUser(userId: string): Promise<string[]>
  deleteDevice(apnsToken: string): Promise<void>
}

export interface MatchRepository {
  create(data: MatchInput): Promise<{ id: string }>
  findById(id: string): Promise<MatchRecord | null>
  listForUser(userId: string, limit: number): Promise<MatchRecord[]>
  movesForMatch(matchId: string): Promise<MoveInput[]>
}

export interface FriendRepository {
  listForUser(userId: string): Promise<FriendshipRecord[]>
  find(aId: string, bId: string): Promise<FriendshipRecord | null>
  findById(id: string): Promise<FriendshipRecord | null>
  create(aId: string, bId: string): Promise<FriendshipRecord>
  updateStatus(id: string, status: string): Promise<void>
  delete(id: string): Promise<void>
}

export interface ChallengeRepository {
  create(fromUserId: string, toUserId: string, expiresAt: Date): Promise<ChallengeRecord>
  listPending(userId: string): Promise<ChallengeRecord[]>
  findById(id: string): Promise<ChallengeRecord | null>
  updateStatus(id: string, status: string): Promise<void>
}

export interface AchievementRepository {
  listForUser(userId: string): Promise<AchievementRecord[]>
}

export interface WordVerdictRepository {
  find(word: string, language: string): Promise<{ valid: boolean; definition: string | null } | null>
  upsert(word: string, language: string, valid: boolean, reason: string, definition?: string | null): Promise<void>
}

export interface Repositories {
  users: UserRepository
  auth: AuthRepository
  matches: MatchRepository
  friends: FriendRepository
  challenges: ChallengeRepository
  achievements: AchievementRepository
  words: WordVerdictRepository
}
