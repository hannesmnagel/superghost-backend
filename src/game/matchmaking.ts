import { randomBytes } from 'crypto'
import { EventEmitter } from 'events'
import { LiveGame, PlayerInfo, MatchState } from './engine.js'
import { Lang } from '../words/wordService.js'
import { config } from '../config.js'
import { botPlayerInfo, botLevelFor, isBotId, botDecide } from '../bot/bot.js'
import { db } from '../db/prisma.js'

// userId -> LiveGame
const gameByUser = new Map<string, LiveGame>()
// gameId -> LiveGame
const gameById = new Map<string, LiveGame>()
// invite code -> gameId
const codeToGame = new Map<string, string>()
// matchmaking queue keyed by "isSuperghost:lang"
const queue = new Map<string, { player: PlayerInfo; resolve: (game: LiveGame) => void }>()

function queueKey(isSuperghost: boolean, lang: Lang): string {
  return `${isSuperghost}:${lang}`
}

function generateCode(): string {
  return randomBytes(3).toString('hex').toUpperCase()
}

function generateId(): string {
  return randomBytes(16).toString('hex')
}

export function getGameByUser(userId: string): LiveGame | undefined {
  return gameByUser.get(userId)
}

export function getGameById(id: string): LiveGame | undefined {
  return gameById.get(id)
}

export function removeGame(game: LiveGame): void {
  for (const player of game.getPlayers()) {
    gameByUser.delete(player.userId)
  }
  gameById.delete(game.id)
  if (game.inviteCode) codeToGame.delete(game.inviteCode)
}

function attachGame(game: LiveGame, player: PlayerInfo): void {
  gameByUser.set(player.userId, game)
  gameById.set(game.id, game)
  if (game.inviteCode) codeToGame.set(game.inviteCode, game.id)
}

// Wire up bot move logic to a game
function wireBotToGame(game: LiveGame): void {
  game.on('yourTurn', async ({ userId }: { userId: string }) => {
    if (!isBotId(userId)) return
    const state = game.getState()
    if (state.phase === 'finished') return

    try {
      const level = (userId.split(':')[1] ?? 'medium') as 'easy' | 'medium' | 'hard'
      const move = await botDecide(
        state.word,
        state.language,
        state.isSuperghost,
        level,
        state.phase === 'challenge' ? state.challengeBy : null,
        game.id,
      )
      if (game.isFinished()) return
      game.applyMove(userId, move.action as any, { letter: move.letter, word: move.word })
    } catch (err) {
      console.error(`Bot error in ${game.id}:`, err)
    }
  })

  // Trigger initial bot move if it's the bot's turn first
  const state = game.getState()
  if (state.turnUserId && isBotId(state.turnUserId)) {
    game.emit('yourTurn', { userId: state.turnUserId, deadline: state.deadline })
  }
}

export async function quickmatch(player: PlayerInfo, isSuperghost: boolean, lang: Lang): Promise<LiveGame> {
  const existing = gameByUser.get(player.userId)
  if (existing && !existing.isFinished()) return existing

  const key = queueKey(isSuperghost, lang)
  const waiting = queue.get(key)

  if (waiting && waiting.player.userId !== player.userId) {
    queue.delete(key)
    const game = new LiveGame({ id: generateId(), isSuperghost, language: lang })
    attachGame(game, waiting.player)
    attachGame(game, player)
    game.addPlayer(waiting.player)
    game.addPlayer(player)
    waiting.resolve(game)
    return game
  }

  // Enqueue this player
  return new Promise(resolve => {
    queue.set(key, { player, resolve })

    // Schedule bot fill
    setTimeout(async () => {
      if (!queue.has(key) || queue.get(key)?.player.userId !== player.userId) return
      queue.delete(key)

      const userRecord = await db.user.findUnique({ where: { id: player.userId } }).catch(() => null)
      const humanRating = userRecord?.rating ?? player.rating
      const botLevel = botLevelFor(humanRating)
      const bot = botPlayerInfo(botLevel, humanRating)

      const game = new LiveGame({ id: generateId(), isSuperghost, language: lang, isBot: true })
      attachGame(game, player)
      gameByUser.set(bot.userId, game)
      game.addPlayer(player)
      game.addPlayer(bot)

      wireBotToGame(game)
      resolve(game)
    }, config.BOT_FILL_MS)
  })
}

export function hostGame(player: PlayerInfo, isSuperghost: boolean, lang: Lang): LiveGame {
  const existing = gameByUser.get(player.userId)
  if (existing && !existing.isFinished()) return existing

  const code = generateCode()
  const game = new LiveGame({ id: generateId(), isSuperghost, language: lang, inviteCode: code, isPrivate: true })
  attachGame(game, player)
  game.addPlayer(player)
  return game
}

export function joinByCode(player: PlayerInfo, code: string): LiveGame {
  const gameId = codeToGame.get(code.toUpperCase())
  if (!gameId) throw new Error('Game not found')
  const game = gameById.get(gameId)
  if (!game) throw new Error('Game not found')
  if (game.playerCount() >= 2) throw new Error('Game is full')
  if (game.hasPlayer(player.userId)) return game

  attachGame(game, player)
  game.addPlayer(player)
  return game
}

export function joinById(player: PlayerInfo, matchId: string): LiveGame {
  const game = gameById.get(matchId)
  if (!game) throw new Error('Game not found')
  if (!game.hasPlayer(player.userId)) throw new Error('Not a player in this game')
  return game
}
