import { EventEmitter } from 'events'
import { config } from '../config.js'
import {
  isWordLocal,
  canExtend,
  extendingLetters,
  validateSubmittedWord,
  sampleWordsContaining,
  Lang,
  MIN_WORD_LEN,
} from '../words/wordService.js'
import { computeElo } from './rating.js'
import { db } from '../db/prisma.js'

export type GamePhase = 'lobby' | 'playing' | 'challenge' | 'finished'
export type EndReason = 'completed_word' | 'challenge_win' | 'lied' | 'timeout' | 'abandoned' | 'resigned'
export type Action = 'append' | 'prepend' | 'challenge' | 'submit' | 'lie' | 'resign'

export interface PlayerInfo {
  userId: string
  handle: string
  skin: string
  rating: number
}

export interface MatchState {
  id: string
  isSuperghost: boolean
  language: Lang
  word: string
  players: PlayerInfo[]
  turnUserId: string | null
  phase: GamePhase
  challengeBy: string | null
  deadline: string | null
  winnerId: string | null
  loserId: string | null
  endReason: EndReason | null
  ghostProgress: Record<string, string>
  inviteCode: string | null
}

const GHOST_WORD = 'GHOST'

export class LiveGame extends EventEmitter {
  readonly id: string
  readonly isSuperghost: boolean
  readonly language: Lang
  readonly inviteCode: string | null
  readonly isBot: boolean
  readonly isPrivate: boolean

  private word = ''
  private players: PlayerInfo[] = []
  private turnIndex = 0
  private phase: GamePhase = 'lobby'
  private challengeBy: string | null = null
  private winnerId: string | null = null
  private loserId: string | null = null
  private endReason: EndReason | null = null
  private ghostProgress: Record<string, string> = {}
  private timer: ReturnType<typeof setTimeout> | null = null
  private deadline: Date | null = null

  // Persisted move list
  private moves: Array<{ byUserId: string; action: Action; letter?: string; wordAfter: string }> = []

  constructor(opts: {
    id: string
    isSuperghost: boolean
    language: Lang
    inviteCode?: string | null
    isBot?: boolean
    isPrivate?: boolean
  }) {
    super()
    this.id = opts.id
    this.isSuperghost = opts.isSuperghost
    this.language = opts.language
    this.inviteCode = opts.inviteCode ?? null
    this.isBot = opts.isBot ?? false
    this.isPrivate = opts.isPrivate ?? false
  }

  addPlayer(player: PlayerInfo): void {
    if (this.players.length >= 2) throw new Error('Game is full')
    this.players.push(player)
    this.ghostProgress[player.userId] = ''
    if (this.players.length === 2) {
      this.startGame()
    }
  }

  replaceBot(human: PlayerInfo): void {
    const botIdx = this.players.findIndex(p => p.userId.startsWith('bot:'))
    if (botIdx === -1) return
    this.players[botIdx] = human
    this.ghostProgress[human.userId] = this.ghostProgress[this.players[botIdx]?.userId ?? ''] ?? ''
    delete this.ghostProgress['bot:medium']
  }

  private startGame(): void {
    this.phase = 'playing'
    this.turnIndex = 0
    this.word = ''
    this.setTurnTimer()
    this.emit('state', this.getState())
  }

  getState(): MatchState {
    return {
      id: this.id,
      isSuperghost: this.isSuperghost,
      language: this.language,
      word: this.word,
      players: this.players,
      turnUserId: this.phase === 'playing' || this.phase === 'challenge'
        ? this.players[this.turnIndex]?.userId ?? null
        : null,
      phase: this.phase,
      challengeBy: this.challengeBy,
      deadline: this.deadline?.toISOString() ?? null,
      winnerId: this.winnerId,
      loserId: this.loserId,
      endReason: this.endReason,
      ghostProgress: { ...this.ghostProgress },
      inviteCode: this.inviteCode,
    }
  }

  currentTurnUserId(): string | null {
    return this.players[this.turnIndex]?.userId ?? null
  }

  playerCount(): number {
    return this.players.length
  }

  getPlayers(): PlayerInfo[] {
    return this.players
  }

  isFinished(): boolean {
    return this.phase === 'finished'
  }

  hasPlayer(userId: string): boolean {
    return this.players.some(p => p.userId === userId)
  }

  applyMove(userId: string, action: Action, payload: { letter?: string; word?: string }): void {
    if (this.phase === 'finished') throw new Error('Game is finished')

    if (action === 'resign') {
      this.resolveWin(this.opponent(userId), userId, 'resigned')
      return
    }

    if (this.phase === 'challenge') {
      if (action === 'submit') {
        this.handleSubmitAfterChallenge(userId, payload.word ?? '')
      } else if (action === 'lie') {
        this.resolveWin(this.challenger()!, userId, 'lied')
      } else {
        throw new Error('Only submit or lie allowed when challenged')
      }
      return
    }

    if (this.phase !== 'playing') throw new Error('Game not in playing phase')
    if (this.players[this.turnIndex]?.userId !== userId) throw new Error('Not your turn')

    if (action === 'append' || action === 'prepend') {
      const letter = (payload.letter ?? '').toLowerCase()
      if (!letter || letter.length !== 1) throw new Error('Invalid letter')

      let newWord: string
      if (action === 'append') {
        newWord = this.word + letter
      } else {
        if (!this.isSuperghost) throw new Error('Prepend not allowed in Ghost mode')
        newWord = letter + this.word
      }

      this.moves.push({ byUserId: userId, action, letter, wordAfter: newWord })
      this.word = newWord

      // Server-side word check
      if (newWord.length >= MIN_WORD_LEN && isWordLocal(newWord, this.language)) {
        this.resolveWin(this.opponent(userId), userId, 'completed_word')
        return
      }

      this.advanceTurn()
    } else if (action === 'challenge') {
      if (this.word.length < 2) throw new Error('Word too short to challenge')
      this.challengeBy = userId
      this.phase = 'challenge'
      this.clearTimer()
      this.moves.push({ byUserId: userId, action, wordAfter: this.word })
      // Turn goes to the challenged player to respond
      this.turnIndex = 1 - this.turnIndex
      this.emit('challenged', { by: userId, state: this.getState() })
      this.setTurnTimer()
    } else {
      throw new Error('Unknown action')
    }
  }

  private async handleSubmitAfterChallenge(userId: string, word: string): Promise<void> {
    const valid = await validateSubmittedWord(word, this.word, this.language)
    const challenger = this.challengeBy!
    if (valid) {
      // Submitter proved the word → challenger loses
      this.moves.push({ byUserId: userId, action: 'submit', wordAfter: word })
      this.resolveWin(userId, challenger, 'challenge_win')
    } else {
      // Invalid word → submitter loses
      this.moves.push({ byUserId: userId, action: 'submit', wordAfter: word })
      this.resolveWin(challenger, userId, 'lied')
    }
  }

  private advanceTurn(): void {
    this.turnIndex = 1 - this.turnIndex
    this.setTurnTimer()
    this.emit('state', this.getState())
    this.emit('yourTurn', {
      userId: this.players[this.turnIndex]?.userId,
      deadline: this.deadline?.toISOString(),
    })
  }

  private resolveWin(winnerId: string, loserId: string, reason: EndReason): void {
    this.clearTimer()
    this.winnerId = winnerId
    this.loserId = loserId
    this.endReason = reason
    this.phase = 'finished'

    // Update ghost progress for loser
    const progress = this.ghostProgress[loserId] ?? ''
    this.ghostProgress[loserId] = GHOST_WORD.slice(0, progress.length + 1)

    this.emit('state', this.getState())
    this.persistFinishedGame().catch(console.error)
  }

  private challenger(): string | null {
    return this.challengeBy
  }

  private opponent(userId: string): string {
    return this.players.find(p => p.userId !== userId)?.userId ?? userId
  }

  private setTurnTimer(): void {
    this.clearTimer()
    this.deadline = new Date(Date.now() + config.TURN_TIMEOUT_MS)
    this.timer = setTimeout(() => {
      const timedOutUser = this.players[this.turnIndex]?.userId
      if (timedOutUser) {
        this.resolveWin(this.opponent(timedOutUser), timedOutUser, 'timeout')
      }
    }, config.TURN_TIMEOUT_MS)
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.deadline = null
  }

  pauseTimer(): void {
    this.clearTimer()
  }

  resumeTimer(): void {
    if (this.phase === 'playing' || this.phase === 'challenge') {
      this.setTurnTimer()
    }
  }

  private async persistFinishedGame(): Promise<void> {
    if (this.players.length < 2) return
    const p1 = this.players[0]!
    const p2 = this.players[1]!
    const isBot = p2.userId.startsWith('bot:') || p1.userId.startsWith('bot:')

    let ratingP1After = p1.rating
    let ratingP2After = p2.rating
    let ratingDelta = 0

    if (!isBot && this.winnerId && this.loserId) {
      const winner = this.players.find(p => p.userId === this.winnerId)!
      const loser = this.players.find(p => p.userId === this.loserId)!
      const elo = computeElo(winner.rating, loser.rating)
      ratingDelta = elo.delta
      if (this.winnerId === p1.userId) {
        ratingP1After = elo.winnerNew
        ratingP2After = elo.loserNew
      } else {
        ratingP1After = elo.loserNew
        ratingP2After = elo.winnerNew
      }

      await db.$transaction([
        db.user.update({ where: { id: this.winnerId }, data: { rating: this.winnerId === p1.userId ? ratingP1After : ratingP2After } }),
        db.user.update({ where: { id: this.loserId }, data: { rating: this.loserId === p1.userId ? ratingP1After : ratingP2After } }),
      ])
    }

    const match = await db.match.create({
      data: {
        id: this.id,
        player1Id: p1.userId,
        player2Id: isBot ? null : p2.userId,
        isBot,
        isPrivate: this.isPrivate,
        isSuperghost: this.isSuperghost,
        language: this.language,
        finalWord: this.word,
        winnerId: this.winnerId,
        loserId: this.loserId,
        endReason: this.endReason,
        ratingP1Before: p1.rating,
        ratingP2Before: p2.rating,
        ratingP1After,
        ratingP2After,
        finishedAt: new Date(),
        moves: {
          create: this.moves.map((m, i) => ({
            ply: i,
            byUserId: m.byUserId,
            action: m.action,
            letter: m.letter ?? null,
            wordAfter: m.wordAfter,
          })),
        },
      },
    })

    this.emit('gameOver', {
      winnerId: this.winnerId,
      loserId: this.loserId,
      reason: this.endReason,
      word: this.word,
      ratingDelta,
      newRatings: {
        [p1.userId]: ratingP1After,
        [p2.userId]: ratingP2After,
      },
      matchId: match.id,
    })
  }

  // Hints for challenging player (bot + word input UX)
  getSampleWords(n = 5): string[] {
    return sampleWordsContaining(this.word, this.language, this.isSuperghost, n)
  }

  getExtendingLetters(): { append: Set<string>; prepend: Set<string> } {
    return extendingLetters(this.word, this.language, this.isSuperghost)
  }
}
