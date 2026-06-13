import { loadFromWords } from '../../src/domain/words/wordlist.js'

// A small, predictable English fixture used across domain tests.
export const EN_WORDS = [
  'ghost', 'ghosts', 'ghostly', 'word', 'words', 'sword', 'swords',
  'test', 'tests', 'testing', 'string', 'strip', 'street',
  'play', 'player', 'players', 'playing',
  'able', 'table', 'tables', 'stable', 'stables',
]

export const DE_WORDS = ['haus', 'häuser', 'geist', 'geister', 'wort', 'wörter', 'spiel', 'spieler']

export function loadFixtureWords(): void {
  loadFromWords('en', EN_WORDS)
  loadFromWords('de', DE_WORDS)
}

/** Deterministic linear-congruential RNG so bot decisions are reproducible in tests. */
export function seededRng(seed = 1): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}
