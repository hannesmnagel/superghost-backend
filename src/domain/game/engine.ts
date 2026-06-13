import { EventEmitter } from 'events'
import { Lang, MIN_WORD_LEN } from '../words/wordlist.js'

export type GamePhase = 'lobby' | 'playing' | 'challenge' | 'finished'
export type EndReason =
  | 'completed_word'
  | 'challenge_win'
  | 'lied'
  | 'timeout'
  | 'abandoned'
  | 'resigned'
export type Action = 'append' | 'prepend' | 'challenge' | 'submit' | 'lie' | 'resign'

export interface PlayerInfo {
  userId: string
  handle: string
  skin: string
  rating: number
  isBot: boolean
  botLevel?: 'easy' | 'medium' | 'hard'
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

export interface MoveRecord {
  byUserId: string
  action: Action
  letter?: string
  wordAfter: string
}

export interface MatchResult {
  id: string
  isSuperghost: boolean
  language: Lang
  isPrivate: boolean
  players: PlayerInfo[]
  winnerId: string | null
  loserId: string | null
  endReason: EndReason | null
  finalWord: string
  moves: MoveRecord[]
}

export interface FinishOutcome {
  ratingDelta: number
  newRatings: Record<string, number>
  matchId: string
}

/** Validate a word submitted to answer a challenge (LLM-judged). */
export type VerifyWordPort = (word: string, sequence: string, lang: Lang) => Promise<boolean>
/** Decide whether the current sequence is itself a completed, valid word (LLM-judged). */
export type IsCompletedWordPort = (sequence: string, lang: Lang) => Promise<boolean>
/** Persist + score a finished match. Returns rating outcome for the gameOver broadcast. */
export type FinishMatchPort = (result: MatchResult) => Promise<FinishOutcome>

export interface EngineDeps {
  verifyWord: VerifyWordPort
  isCompletedWord: IsCompletedWordPort
  finishMatch: FinishMatchPort
  turnTimeoutMs: number
}

const GHOST_WORD = 'GHOST'

export class LiveGame extends EventEmitter {
  readonly id: string
  readonly isSuperghost: boolean
  readonly language: Lang
  readonly inviteCode: string | null
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
  private moves: MoveRecord[] = []
  private finishing = false

  private readonly deps: EngineDeps

  constructor(opts: {
    id: string
    isSuperghost: boolean
    language: Lang
    inviteCode?: string | null
    isPrivate?: boolean
    deps: EngineDeps
  }) {
    super()
    this.id = opts.id
    this.isSuperghost = opts.isSuperghost
    this.language = opts.language
    this.inviteCode = opts.inviteCode ?? null
    this.isPrivate = opts.isPrivate ?? false
    this.deps = opts.deps
  }

  addPlayer(player: PlayerInfo): void {
    if (this.players.length >= 2) throw new Error('Game is full')
    if (this.players.some(p => p.userId === player.userId)) return
    this.players.push(player)
    this.ghostProgress[player.userId] = ''
    if (this.players.length === 2) this.startGame()
  }

  private startGame(): void {
    this.phase = 'playing'
    this.turnIndex = 0
    this.word = ''
    this.setTurnTimer()
    this.emit('state', this.getState())
    this.emit('yourTurn', {
      userId: this.players[this.turnIndex]?.userId,
      deadline: this.deadline?.toISOString(),
    })
  }

  getState(): MatchState {
    return {
      id: this.id,
      isSuperghost: this.isSuperghost,
      language: this.language,
      word: this.word,
      players: this.players,
      turnUserId:
        this.phase === 'playing' || this.phase === 'challenge'
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

  getPlayer(userId: string): PlayerInfo | undefined {
    return this.players.find(p => p.userId === userId)
  }

  isFinished(): boolean {
    return this.phase === 'finished'
  }

  getPhase(): GamePhase {
    return this.phase
  }

  hasPlayer(userId: string): boolean {
    return this.players.some(p => p.userId === userId)
  }

  async applyMove(userId: string, action: Action, payload: { letter?: string; word?: string }): Promise<void> {
    if (this.phase === 'finished') throw new Error('Game is finished')

    if (action === 'resign') {
      await this.resolveWin(this.opponent(userId), userId, 'resigned')
      return
    }

    if (this.phase === 'challenge') {
      if (this.players[this.turnIndex]?.userId !== userId) throw new Error('Not your turn to respond')
      if (action === 'submit') {
        await this.handleSubmitAfterChallenge(userId, payload.word ?? '')
      } else if (action === 'lie') {
        await this.resolveWin(this.challengeBy!, userId, 'lied')
      } else {
        throw new Error('Only submit or lie allowed when challenged')
      }
      return
    }

    if (this.phase !== 'playing') throw new Error('Game not in playing phase')
    if (this.players[this.turnIndex]?.userId !== userId) throw new Error('Not your turn')

    if (action === 'append' || action === 'prepend') {
      const letter = (payload.letter ?? '').toLowerCase()
      if (!letter || [...letter].length !== 1) throw new Error('Invalid letter')

      let newWord: string
      if (action === 'append') {
        newWord = this.word + letter
      } else {
        if (!this.isSuperghost) throw new Error('Prepend not allowed in Ghost mode')
        newWord = letter + this.word
      }

      this.moves.push({ byUserId: userId, action, letter, wordAfter: newWord })
      this.word = newWord

      if (newWord.length >= MIN_WORD_LEN && (await this.deps.isCompletedWord(newWord, this.language))) {
        await this.resolveWin(this.opponent(userId), userId, 'completed_word')
        return
      }
      this.advanceTurn()
    } else if (action === 'challenge') {
      if (this.word.length < 2) throw new Error('Word too short to challenge')
      this.challengeBy = userId
      this.phase = 'challenge'
      this.clearTimer()
      this.moves.push({ byUserId: userId, action, wordAfter: this.word })
      this.turnIndex = 1 - this.turnIndex // challenged player must respond
      this.setTurnTimer()
      this.emit('challenged', { by: userId, state: this.getState() })
    } else {
      throw new Error('Unknown action')
    }
  }

  private async handleSubmitAfterChallenge(userId: string, word: string): Promise<void> {
    const challenger = this.challengeBy!
    const valid = await this.deps.verifyWord(word, this.word, this.language)
    this.moves.push({ byUserId: userId, action: 'submit', wordAfter: word })
    if (valid) {
      await this.resolveWin(userId, challenger, 'challenge_win')
    } else {
      await this.resolveWin(challenger, userId, 'lied')
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

  private async resolveWin(winnerId: string, loserId: string, reason: EndReason): Promise<void> {
    if (this.phase === 'finished') return
    this.clearTimer()
    this.winnerId = winnerId
    this.loserId = loserId
    this.endReason = reason
    this.phase = 'finished'

    const progress = this.ghostProgress[loserId] ?? ''
    this.ghostProgress[loserId] = GHOST_WORD.slice(0, progress.length + 1)

    this.emit('state', this.getState())
    await this.persistFinishedGame()
  }

  private opponent(userId: string): string {
    return this.players.find(p => p.userId !== userId)?.userId ?? userId
  }

  private setTurnTimer(): void {
    this.clearTimer()
    this.deadline = new Date(Date.now() + this.deps.turnTimeoutMs)
    this.timer = setTimeout(() => {
      const timedOutUser = this.players[this.turnIndex]?.userId
      if (timedOutUser) {
        void this.resolveWin(this.opponent(timedOutUser), timedOutUser, 'timeout')
      }
    }, this.deps.turnTimeoutMs)
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
    if (this.phase === 'playing' || this.phase === 'challenge') this.setTurnTimer()
  }

  private async persistFinishedGame(): Promise<void> {
    if (this.finishing || this.players.length < 2) return
    this.finishing = true

    const result: MatchResult = {
      id: this.id,
      isSuperghost: this.isSuperghost,
      language: this.language,
      isPrivate: this.isPrivate,
      players: this.players,
      winnerId: this.winnerId,
      loserId: this.loserId,
      endReason: this.endReason,
      finalWord: this.word,
      moves: this.moves,
    }

    let outcome: FinishOutcome
    try {
      outcome = await this.deps.finishMatch(result)
    } catch (err) {
      console.error(`[engine] finishMatch failed for ${this.id}:`, err)
      outcome = {
        ratingDelta: 0,
        newRatings: Object.fromEntries(this.players.map(p => [p.userId, p.rating])),
        matchId: this.id,
      }
    }

    this.emit('gameOver', {
      winnerId: this.winnerId,
      loserId: this.loserId,
      reason: this.endReason,
      word: this.word,
      ratingDelta: outcome.ratingDelta,
      newRatings: outcome.newRatings,
      matchId: outcome.matchId,
    })
  }
}
