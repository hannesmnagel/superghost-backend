import { describe, it, expect, beforeEach } from 'vitest'
import { decide, botThinkDelayMs } from '../src/domain/bot/bot.js'
import { loadFromWords, isWordLocal, canExtend, extendingLetters, MIN_WORD_LEN } from '../src/domain/words/wordlist.js'
import { seededRng } from './helpers/words.js'

// A tiny dictionary with a known game tree (Ghost mode, append-only):
//   "abcd"  (len 4)  -> first mover who picks 'a' wins (opponent forced to complete)
//   "mnopq" (len 5)  -> picking 'm' hands the win to the opponent
// So at the empty sequence the only winning move is 'a'.
function loadTree() {
  loadFromWords('en', ['abcd', 'mnopq'])
}

describe('bot: challenge handling (the previously-dead path)', () => {
  beforeEach(() => loadFromWords('en', ['ghost', 'ghostly', 'word', 'words', 'sword']))

  it('submits a real word when challenged on a live sequence', () => {
    const move = decide('ghos', 'en', false, 'hard', true, seededRng())
    expect(move.action).toBe('submit')
    expect(move.word).toBeDefined()
    expect(isWordLocal(move.word!, 'en')).toBe(true)
    expect(move.word!.includes('ghos')).toBe(true)
  })

  it('admits a lie when challenged on a dead-end sequence', () => {
    const move = decide('zzz', 'en', false, 'hard', true, seededRng())
    expect(move.action).toBe('lie')
  })
})

describe('bot: move selection only produces legal moves', () => {
  beforeEach(() => loadFromWords('en', ['ghost', 'ghostly', 'word', 'words', 'sword', 'string', 'street']))

  it('append letters are always valid extensions, never instant self-loss when avoidable', () => {
    const rng = seededRng(42)
    for (let i = 0; i < 50; i++) {
      const move = decide('s', 'en', false, 'medium', false, rng)
      if (move.action === 'append') {
        const { append } = extendingLetters('s', 'en', false)
        expect(append.has(move.letter!)).toBe(true)
      } else {
        expect(['challenge']).toContain(move.action)
      }
    }
  })
})

describe('bot: forced-win strategy', () => {
  beforeEach(loadTree)

  it('hard bot picks the winning branch at the root', () => {
    const move = decide('', 'en', false, 'hard', false, seededRng(7))
    expect(move.action).toBe('append')
    expect(move.letter).toBe('a') // 'a' wins; 'm' loses
  })

  it('challenges a genuine dead-end when it has no safe move', () => {
    // 'abcz' is not a prefix of any word -> nothing extends it and it is not a word.
    expect(canExtend('abcz', 'en', false)).toBe(false)
    const move = decide('abcz', 'en', false, 'hard', false, seededRng())
    expect(move.action).toBe('challenge')
  })

  it('is forced to complete a word only when every extension does', () => {
    // 'abc' can only extend with 'd' -> 'abcd' which is a word (instant loss). No safe move,
    // but the sequence IS extendable, so challenging would lose -> it must play 'd'.
    expect(canExtend('abc', 'en', false)).toBe(true)
    const move = decide('abc', 'en', false, 'hard', false, seededRng())
    expect(move.action).toBe('append')
    expect(move.letter).toBe('d')
  })
})

describe('bot: think delay', () => {
  it('returns a delay within the level range', () => {
    const d = botThinkDelayMs('medium', () => 0.5)
    expect(d).toBeGreaterThanOrEqual(800)
    expect(d).toBeLessThanOrEqual(2000)
  })
})

describe('bot: superghost prepend is considered', () => {
  beforeEach(() => loadFromWords('en', ['stable', 'table', 'tables', 'stables']))
  it('produces prepend or append moves that stay extendable', () => {
    const move = decide('tabl', 'en', true, 'medium', false, seededRng(3))
    expect(['append', 'prepend', 'challenge']).toContain(move.action)
    if (move.action === 'append' || move.action === 'prepend') {
      const next = move.action === 'append' ? 'tabl' + move.letter : move.letter + 'tabl'
      expect(canExtend(next, 'en', true) || isWordLocal(next, 'en')).toBe(true)
    }
  })
})
