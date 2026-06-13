import { describe, it, expect, beforeEach, vi } from 'vitest'
import { LiveGame, PlayerInfo, EngineDeps, MatchResult } from '../src/domain/game/engine.js'
import { decide } from '../src/domain/bot/bot.js'
import { isWordLocal, loadFromWords, MIN_WORD_LEN } from '../src/domain/words/wordlist.js'
import { loadFixtureWords } from './helpers/words.js'

function player(id: string, isBot = false, botLevel?: 'easy' | 'medium' | 'hard'): PlayerInfo {
  return { userId: id, handle: id, skin: 'Skin/Cowboy', rating: 1000, isBot, ...(botLevel && { botLevel }) }
}

function makeDeps(over: Partial<EngineDeps> = {}): EngineDeps & { finished: MatchResult[] } {
  const finished: MatchResult[] = []
  const deps: EngineDeps & { finished: MatchResult[] } = {
    turnTimeoutMs: 1000,
    verifyWord: async (word, seq, lang) =>
      word.length >= MIN_WORD_LEN && word.toLowerCase().includes(seq.toLowerCase()) && isWordLocal(word, lang),
    isCompletedWord: async (seq, lang) => isWordLocal(seq, lang),
    finishMatch: async (r) => {
      finished.push(r)
      return { ratingDelta: 12, newRatings: Object.fromEntries(r.players.map(p => [p.userId, p.rating])), matchId: r.id }
    },
    finished,
    ...over,
  }
  return deps
}

function onceEvent<T = any>(game: LiveGame, name: string): Promise<T> {
  return new Promise(resolve => game.once(name, resolve))
}

function newGame(deps: EngineDeps, isSuperghost = false): LiveGame {
  return new LiveGame({ id: 'm1', isSuperghost, language: 'en', deps })
}

beforeEach(() => loadFixtureWords())

describe('engine: turn flow', () => {
  it('starts on player 0 and alternates after a legal move', async () => {
    const deps = makeDeps()
    const g = newGame(deps)
    g.addPlayer(player('p1'))
    g.addPlayer(player('p2'))
    expect(g.getState().phase).toBe('playing')
    expect(g.currentTurnUserId()).toBe('p1')

    await g.applyMove('p1', 'append', { letter: 's' })
    expect(g.getState().word).toBe('s')
    expect(g.currentTurnUserId()).toBe('p2')
  })

  it('rejects a move out of turn', async () => {
    const deps = makeDeps()
    const g = newGame(deps)
    g.addPlayer(player('p1'))
    g.addPlayer(player('p2'))
    await expect(g.applyMove('p2', 'append', { letter: 's' })).rejects.toThrow(/Not your turn/)
  })

  it('rejects prepend in Ghost mode', async () => {
    const deps = makeDeps()
    const g = newGame(deps, false)
    g.addPlayer(player('p1'))
    g.addPlayer(player('p2'))
    await expect(g.applyMove('p1', 'prepend', { letter: 's' })).rejects.toThrow(/Prepend not allowed/)
  })
})

describe('engine: completing a word loses', () => {
  it('the player who forms a real word loses and the loser gains a GHOST letter', async () => {
    const deps = makeDeps()
    const g = newGame(deps)
    g.addPlayer(player('p1'))
    g.addPlayer(player('p2'))
    const over = onceEvent(g, 'gameOver')

    // w-o-r-d : p1 w, p2 o, p1 r, p2 d -> "word" is a word -> p2 loses
    await g.applyMove('p1', 'append', { letter: 'w' })
    await g.applyMove('p2', 'append', { letter: 'o' })
    await g.applyMove('p1', 'append', { letter: 'r' })
    await g.applyMove('p2', 'append', { letter: 'd' })

    const result = await over
    expect(result.winnerId).toBe('p1')
    expect(result.loserId).toBe('p2')
    expect(result.reason).toBe('completed_word')
    expect(g.getState().ghostProgress['p2']).toBe('G')
    expect(deps.finished).toHaveLength(1)
  })
})

describe('engine: challenge resolution', () => {
  it('valid submitted word makes the challenger lose', async () => {
    const deps = makeDeps()
    const g = newGame(deps)
    g.addPlayer(player('p1'))
    g.addPlayer(player('p2'))

    await g.applyMove('p1', 'append', { letter: 'w' })
    await g.applyMove('p2', 'append', { letter: 'o' })
    await g.applyMove('p1', 'append', { letter: 'r' }) // seq "wor", p2 to move
    const over = onceEvent(g, 'gameOver')
    await g.applyMove('p2', 'challenge', {})
    expect(g.getState().phase).toBe('challenge')
    await g.applyMove('p1', 'submit', { word: 'word' }) // p1 proves it

    const r = await over
    expect(r.winnerId).toBe('p1')
    expect(r.reason).toBe('challenge_win')
  })

  it('admitting a lie makes the challenged player lose', async () => {
    const deps = makeDeps()
    const g = newGame(deps)
    g.addPlayer(player('p1'))
    g.addPlayer(player('p2'))
    await g.applyMove('p1', 'append', { letter: 'w' })
    await g.applyMove('p2', 'append', { letter: 'o' })
    await g.applyMove('p1', 'append', { letter: 'r' })
    const over = onceEvent(g, 'gameOver')
    await g.applyMove('p2', 'challenge', {})
    await g.applyMove('p1', 'lie', {})
    const r = await over
    expect(r.winnerId).toBe('p2')
    expect(r.reason).toBe('lied')
  })
})

describe('engine: resign and timeout', () => {
  it('resign hands the win to the opponent', async () => {
    const deps = makeDeps()
    const g = newGame(deps)
    g.addPlayer(player('p1'))
    g.addPlayer(player('p2'))
    const over = onceEvent(g, 'gameOver')
    await g.applyMove('p1', 'resign', {})
    const r = await over
    expect(r.winnerId).toBe('p2')
    expect(r.reason).toBe('resigned')
  })

  it('a turn timeout loses for the player on the clock', async () => {
    vi.useFakeTimers()
    try {
      const deps = makeDeps({ turnTimeoutMs: 500 })
      const g = newGame(deps)
      g.addPlayer(player('p1'))
      g.addPlayer(player('p2'))
      const over = onceEvent(g, 'gameOver')
      await vi.advanceTimersByTimeAsync(600)
      const r = await over
      expect(r.loserId).toBe('p1')
      expect(r.reason).toBe('timeout')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('engine + bot: a bot-vs-bot game terminates with a winner', () => {
  it('drives two hard bots to completion deterministically', async () => {
    loadFromWords('en', ['abcd', 'mnopq'])
    const deps = makeDeps()
    const g = newGame(deps)
    g.addPlayer(player('b1', true, 'hard'))
    g.addPlayer(player('b2', true, 'hard'))

    // Manual deterministic driver (no timers): repeatedly ask the current bot to decide.
    let guard = 0
    while (!g.isFinished() && guard++ < 50) {
      const s = g.getState()
      const actor = s.turnUserId!
      const isChallenged = s.phase === 'challenge'
      const move = decide(s.word, s.language, s.isSuperghost, 'hard', isChallenged)
      await g.applyMove(actor, move.action as any, { letter: move.letter, word: move.word })
    }

    expect(g.isFinished()).toBe(true)
    const r = deps.finished[0]!
    expect(r.winnerId).toBeTruthy()
    expect(r.loserId).toBeTruthy()
    expect(r.winnerId).not.toBe(r.loserId)
  })
})
