import { describe, it, expect, beforeAll } from 'vitest'
import { loadFixtureWords } from './helpers/words.js'
import {
  isWordLocal,
  canExtend,
  extendingLetters,
  sampleWordsContaining,
} from '../src/domain/words/wordlist.js'
import { Trie } from '../src/domain/words/trie.js'
import { computeElo } from '../src/domain/game/rating.js'

beforeAll(() => loadFixtureWords())

describe('wordlist', () => {
  it('isWordLocal honours MIN_WORD_LEN and membership', () => {
    expect(isWordLocal('ghost', 'en')).toBe(true)
    expect(isWordLocal('word', 'en')).toBe(true)
    expect(isWordLocal('xyzzyq', 'en')).toBe(false)
    expect(isWordLocal('gho', 'en')).toBe(false) // too short
  })

  it('isWordLocal - de', () => {
    expect(isWordLocal('haus', 'de')).toBe(true)
    expect(isWordLocal('xyz', 'de')).toBe(false)
  })

  it('canExtend follows prefixes (ghost path)', () => {
    expect(canExtend('ghos', 'en', false)).toBe(true)
    expect(canExtend('zzzzz', 'en', false)).toBe(false)
  })

  it('extendingLetters appends t after "ghos"', () => {
    const { append } = extendingLetters('ghos', 'en', false)
    expect(append.has('t')).toBe(true)
  })

  it('superghost prepend works via reverse trie', () => {
    expect(canExtend('tabl', 'en', true)).toBe(true) // -> table/tables, stable/stables
    const { prepend } = extendingLetters('table', 'en', true)
    expect(prepend.has('s')).toBe(true) // s + table -> stable
  })

  it('sampleWordsContaining finds real words', () => {
    const words = sampleWordsContaining('play', 'en', false, 10)
    expect(words.some(w => w.startsWith('play'))).toBe(true)
  })
})

describe('Trie', () => {
  it('insert / query / prefixes', () => {
    const t = new Trie()
    t.insert('hello')
    t.insert('help')
    t.insert('world')
    expect(t.isWord('hello')).toBe(true)
    expect(t.isWord('hell')).toBe(false)
    expect(t.hasPrefix('hel')).toBe(true)
    expect(t.hasPrefix('xyz')).toBe(false)
    const next = t.nextLetters('hel')
    expect(next.has('l')).toBe(true)
    expect(next.has('p')).toBe(true)
  })
})

describe('Elo', () => {
  it('equal ratings give symmetric deltas', () => {
    const r = computeElo(1000, 1000)
    expect(r.delta).toBeGreaterThan(0)
    expect(r.winnerNew).toBe(1000 + r.delta)
    expect(r.loserNew).toBe(1000 - r.delta)
  })

  it('higher-rated winner gains less than an upset', () => {
    const easy = computeElo(1000, 800)
    const upset = computeElo(800, 1000)
    expect(easy.delta).toBeLessThan(upset.delta)
  })

  it('rating never goes below zero', () => {
    const r = computeElo(50, 10)
    expect(r.loserNew).toBeGreaterThanOrEqual(0)
  })
})
