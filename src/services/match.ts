import { randomBytes } from 'crypto'
import {
  LiveGame,
  PlayerInfo,
  MatchResult,
  FinishOutcome,
  EngineDeps,
} from '../domain/game/engine.js'
import { computeElo } from '../domain/game/rating.js'
import { botThinkDelayMs, BotLevel } from '../domain/bot/bot.js'
import { Lang } from '../domain/words/wordlist.js'
import type { Repositories, UserRecord } from '../data/repositories.js'
import type { AiService } from './ai.js'

export interface MatchServiceConfig {
  turnTimeoutMs: number
  botFillMs: number
}

export interface MatchServiceDeps {
  repos: Repositories
  ai: AiService
  config: MatchServiceConfig
  /** Override bot think delay (tests force 0). */
  botDelayMs?: (level: BotLevel) => number
}

function generateCode(): string {
  return randomBytes(3).toString('hex').toUpperCase()
}
function generateId(): string {
  return randomBytes(16).toString('hex')
}

export function userToPlayer(u: UserRecord): PlayerInfo {
  const p: PlayerInfo = { userId: u.id, handle: u.handle, skin: u.skin, rating: u.rating, isBot: u.isBot }
  if (u.isBot && u.botLevel) p.botLevel = u.botLevel as BotLevel
  return p
}

export class MatchService {
  private readonly gameByUser = new Map<string, LiveGame>()
  private readonly gameById = new Map<string, LiveGame>()
  private readonly codeToGame = new Map<string, string>()
  private readonly queue = new Map<string, { player: PlayerInfo; resolve: (g: LiveGame) => void }>()
  private readonly botPending = new Set<string>()

  private readonly repos: Repositories
  private readonly ai: AiService
  private readonly cfg: MatchServiceConfig
  private readonly botDelayMs: (level: BotLevel) => number

  constructor(deps: MatchServiceDeps) {
    this.repos = deps.repos
    this.ai = deps.ai
    this.cfg = deps.config
    this.botDelayMs = deps.botDelayMs ?? botThinkDelayMs
  }

  getGameByUser(userId: string): LiveGame | undefined {
    return this.gameByUser.get(userId)
  }
  getGameById(id: string): LiveGame | undefined {
    return this.gameById.get(id)
  }

  removeGame(game: LiveGame): void {
    for (const p of game.getPlayers()) this.gameByUser.delete(p.userId)
    this.gameById.delete(game.id)
    if (game.inviteCode) this.codeToGame.delete(game.inviteCode)
  }

  private engineDeps(): EngineDeps {
    return {
      turnTimeoutMs: this.cfg.turnTimeoutMs,
      verifyWord: (word, sequence, lang) => this.ai.validateSubmission(word, sequence, lang),
      isCompletedWord: (sequence, lang) => this.ai.isCompletedWord(sequence, lang),
      finishMatch: result => this.finishMatch(result),
    }
  }

  private newGame(opts: { isSuperghost: boolean; language: Lang; inviteCode?: string; isPrivate?: boolean }): LiveGame {
    return new LiveGame({
      id: generateId(),
      isSuperghost: opts.isSuperghost,
      language: opts.language,
      inviteCode: opts.inviteCode ?? null,
      isPrivate: opts.isPrivate ?? false,
      deps: this.engineDeps(),
    })
  }

  private attach(game: LiveGame, player: PlayerInfo): void {
    this.gameByUser.set(player.userId, game)
    this.gameById.set(game.id, game)
    if (game.inviteCode) this.codeToGame.set(game.inviteCode, game.id)
  }

  /** Drive bot players. Reacts to every state change and to challenges. */
  wireBots(game: LiveGame): void {
    if (!game.getPlayers().some(p => p.isBot)) return
    const handler = () => this.maybeRunBot(game)
    game.on('state', handler)
    game.on('challenged', handler)
    this.maybeRunBot(game)
  }

  private maybeRunBot(game: LiveGame): void {
    const s = game.getState()
    if (s.phase !== 'playing' && s.phase !== 'challenge') return
    const actorId = s.turnUserId
    if (!actorId) return
    const player = game.getPlayer(actorId)
    if (!player?.isBot) return

    const token = `${game.id}:${s.phase}:${s.challengeBy ?? ''}:${s.word.length}:${actorId}`
    if (this.botPending.has(token)) return
    this.botPending.add(token)

    const level: BotLevel = player.botLevel ?? 'medium'
    const run = async () => {
      this.botPending.delete(token)
      if (game.isFinished()) return
      const cur = game.getState()
      if (cur.turnUserId !== actorId) return
      const move = await this.ai.decideMove({
        sequence: cur.word,
        language: cur.language,
        isSuperghost: cur.isSuperghost,
        level,
        isChallenged: cur.phase === 'challenge',
      })
      if (game.isFinished() || game.getState().turnUserId !== actorId) return
      try {
        await game.applyMove(actorId, move.action, { letter: move.letter, word: move.word })
      } catch (err) {
        console.error(`[bot] move failed in ${game.id}:`, err)
      }
    }
    const delay = this.botDelayMs(level)
    if (delay <= 0) void run()
    else setTimeout(() => void run(), delay)
  }

  async quickmatch(player: PlayerInfo, isSuperghost: boolean, lang: Lang): Promise<LiveGame> {
    const existing = this.gameByUser.get(player.userId)
    if (existing && !existing.isFinished()) return existing

    const key = `${isSuperghost}:${lang}`
    const waiting = this.queue.get(key)
    if (waiting && waiting.player.userId !== player.userId) {
      this.queue.delete(key)
      const game = this.newGame({ isSuperghost, language: lang })
      this.attach(game, waiting.player)
      this.attach(game, player)
      game.addPlayer(waiting.player)
      game.addPlayer(player)
      waiting.resolve(game)
      return game
    }

    return new Promise<LiveGame>(resolve => {
      this.queue.set(key, { player, resolve })
      setTimeout(() => void this.fillWithBot(key, player, isSuperghost, lang, resolve), this.cfg.botFillMs)
    })
  }

  private async fillWithBot(
    key: string,
    player: PlayerInfo,
    isSuperghost: boolean,
    lang: Lang,
    resolve: (g: LiveGame) => void,
  ): Promise<void> {
    if (this.queue.get(key)?.player.userId !== player.userId) return
    this.queue.delete(key)

    const bot = await this.pickBot(player.rating)
    if (!bot) {
      // No bot available — leave the player queued for a human; re-enqueue.
      this.queue.set(key, { player, resolve })
      return
    }

    const game = this.newGame({ isSuperghost, language: lang })
    this.attach(game, player)
    this.attach(game, bot)
    this.wireBots(game)
    game.addPlayer(player)
    game.addPlayer(bot)
    resolve(game)
  }

  /** Pick the idle bot whose rating is closest to the target. */
  private async pickBot(targetRating: number): Promise<PlayerInfo | null> {
    const bots = await this.repos.users.listBots()
    const idle = bots
      .filter(b => {
        const g = this.gameByUser.get(b.id)
        return !g || g.isFinished()
      })
      .sort((a, b) => Math.abs(a.rating - targetRating) - Math.abs(b.rating - targetRating))
    const chosen = idle[0]
    return chosen ? userToPlayer(chosen) : null
  }

  hostGame(player: PlayerInfo, isSuperghost: boolean, lang: Lang): LiveGame {
    const existing = this.gameByUser.get(player.userId)
    if (existing && !existing.isFinished()) return existing
    const game = this.newGame({ isSuperghost, language: lang, inviteCode: generateCode(), isPrivate: true })
    this.attach(game, player)
    game.addPlayer(player)
    return game
  }

  joinByCode(player: PlayerInfo, code: string): LiveGame {
    const gameId = this.codeToGame.get(code.toUpperCase())
    const game = gameId ? this.gameById.get(gameId) : undefined
    if (!game) throw new Error('Game not found')
    if (game.hasPlayer(player.userId)) return game
    if (game.playerCount() >= 2) throw new Error('Game is full')
    this.attach(game, player)
    game.addPlayer(player)
    return game
  }

  joinById(player: PlayerInfo, matchId: string): LiveGame {
    const game = this.gameById.get(matchId)
    if (!game) throw new Error('Game not found')
    if (!game.hasPlayer(player.userId)) throw new Error('Not a player in this game')
    return game
  }

  cancelQueue(userId: string): void {
    for (const [key, entry] of this.queue) if (entry.player.userId === userId) this.queue.delete(key)
  }

  private async finishMatch(result: MatchResult): Promise<FinishOutcome> {
    const p1 = result.players[0]!
    const p2 = result.players[1]!
    const eitherBot = p1.isBot || p2.isBot

    let ratingP1After = p1.rating
    let ratingP2After = p2.rating
    let delta = 0

    if (result.winnerId && result.loserId) {
      const winner = result.players.find(p => p.userId === result.winnerId)!
      const loser = result.players.find(p => p.userId === result.loserId)!
      const elo = computeElo(winner.rating, loser.rating)
      delta = elo.delta
      if (result.winnerId === p1.userId) {
        ratingP1After = elo.winnerNew
        ratingP2After = elo.loserNew
      } else {
        ratingP1After = elo.loserNew
        ratingP2After = elo.winnerNew
      }
      // Both players are real User rows (bots included) → ratings drift for everyone.
      await this.repos.users.update(p1.userId, { rating: ratingP1After })
      await this.repos.users.update(p2.userId, { rating: ratingP2After })
    }

    await this.repos.matches.create({
      id: result.id,
      player1Id: p1.userId,
      player2Id: p2.userId,
      isBot: eitherBot,
      isPrivate: result.isPrivate,
      isSuperghost: result.isSuperghost,
      language: result.language,
      finalWord: result.finalWord,
      winnerId: result.winnerId,
      loserId: result.loserId,
      endReason: result.endReason,
      ratingP1Before: p1.rating,
      ratingP2Before: p2.rating,
      ratingP1After,
      ratingP2After,
      finishedAt: new Date(),
      moves: result.moves.map((m, i) => ({
        ply: i,
        byUserId: m.byUserId,
        action: m.action,
        letter: m.letter ?? null,
        wordAfter: m.wordAfter,
      })),
    })

    return {
      ratingDelta: delta,
      newRatings: { [p1.userId]: ratingP1After, [p2.userId]: ratingP2After },
      matchId: result.id,
    }
  }
}
