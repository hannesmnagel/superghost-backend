import { describe, it, expect, beforeAll } from 'vitest'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '../data')

// Create minimal test word lists
beforeAll(() => {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(join(DATA_DIR, 'en.txt'), [
    'ghost', 'ghosts', 'ghostly', 'word', 'words', 'sword', 'swords',
    'test', 'tests', 'testing', 'string', 'strip', 'street',
    'play', 'player', 'players', 'playing',
    'blue', 'bluer', 'bluest',
    'able', 'table', 'tables', 'stable', 'stables',
  ].join('\n'))
  writeFileSync(join(DATA_DIR, 'de.txt'), [
    'haus', 'häuser', 'geist', 'geister', 'wort', 'wörter', 'spiel', 'spieler',
  ].join('\n'))
})

describe('WordService', () => {
  it('isWordLocal - en', async () => {
    const { isWordLocal, loadAll } = await import('../src/words/wordService.js')
    loadAll()
    expect(isWordLocal('ghost', 'en')).toBe(true)
    expect(isWordLocal('xyzzyq', 'en')).toBe(false)
    expect(isWordLocal('gho', 'en')).toBe(false) // too short (< MIN_WORD_LEN=4) but 'gho' is 3
    expect(isWordLocal('word', 'en')).toBe(true)
  })

  it('isWordLocal - de', async () => {
    const { isWordLocal } = await import('../src/words/wordService.js')
    expect(isWordLocal('haus', 'de')).toBe(true)
    expect(isWordLocal('xyz', 'de')).toBe(false)
  })

  it('canExtend ghost → ghostly path', async () => {
    const { canExtend } = await import('../src/words/wordService.js')
    expect(canExtend('ghos', 'en', false)).toBe(true)   // ghost, ghosts, ghostly
    expect(canExtend('zzzzz', 'en', false)).toBe(false)
  })

  it('extendingLetters for "ghos" appends t', async () => {
    const { extendingLetters } = await import('../src/words/wordService.js')
    const { append } = extendingLetters('ghos', 'en', false)
    expect(append.has('t')).toBe(true)
  })

  it('sampleWordsContaining finds real words', async () => {
    const { sampleWordsContaining } = await import('../src/words/wordService.js')
    const words = sampleWordsContaining('play', 'en', false, 10)
    expect(words.some(w => w.startsWith('play'))).toBe(true)
  })

  it('superghost prepend: reverseTrie works', async () => {
    const { canExtend } = await import('../src/words/wordService.js')
    // "table" → can prepend 's' → "stable", or append 's' → "tables"
    expect(canExtend('tabl', 'en', true)).toBe(true)
  })
})

describe('Trie', () => {
  it('basic insert and query', async () => {
    const { Trie } = await import('../src/words/trie.js')
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
  it('equal ratings give symmetric deltas', async () => {
    const { computeElo } = await import('../src/game/rating.js')
    const r = computeElo(1000, 1000)
    expect(r.delta).toBeGreaterThan(0)
    expect(r.winnerNew).toBe(1000 + r.delta)
    expect(r.loserNew).toBe(1000 - r.delta)
  })

  it('higher rated player gains less on win', async () => {
    const { computeElo } = await import('../src/game/rating.js')
    const easy = computeElo(1000, 800)  // 1000 beats 800 — expected, low gain
    const upset = computeElo(800, 1000) // 800 beats 1000 — upset, high gain
    expect(easy.delta).toBeLessThan(upset.delta)
  })
})
