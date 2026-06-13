import { LiveGame, PlayerInfo } from '../game/engine.js'
import {
  isWordLocal,
  canExtend,
  extendingLetters,
  sampleWordsContaining,
  Lang,
  MIN_WORD_LEN,
} from '../words/wordService.js'

export type BotLevel = 'easy' | 'medium' | 'hard'

const BOT_ID_PREFIX = 'bot:'
const BOT_NAMES: Record<BotLevel, string> = {
  easy: 'Ghost-Bot',
  medium: 'GhostMaster',
  hard: 'SuperGhost',
}

export function botPlayerInfo(level: BotLevel, rating = 1000): PlayerInfo {
  return {
    userId: `${BOT_ID_PREFIX}${level}`,
    handle: BOT_NAMES[level],
    skin: 'Skin/Samurai',
    rating,
  }
}

export function isBotId(userId: string): boolean {
  return userId.startsWith(BOT_ID_PREFIX)
}

function botLevelForRating(rating: number): BotLevel {
  if (rating < 900) return 'easy'
  if (rating < 1300) return 'medium'
  return 'hard'
}

export function botLevelFor(humanRating: number): BotLevel {
  return botLevelForRating(humanRating)
}

// Delay to make bot feel human
function thinkDelay(level: BotLevel): Promise<void> {
  const ranges: Record<BotLevel, [number, number]> = {
    easy: [1200, 2800],
    medium: [800, 2000],
    hard: [500, 1500],
  }
  const [min, max] = ranges[level]
  const ms = min + Math.random() * (max - min)
  return new Promise(r => setTimeout(r, ms))
}

// Simple memoized win/lose evaluator over trie (depth-limited)
// Returns true if the current player (to move) is in a LOSING position
// i.e., every continuation forces them to complete a word eventually
const memo = new Map<string, boolean>()
function isLosingPosition(
  seq: string,
  lang: Lang,
  superghost: boolean,
  depth: number,
): boolean {
  if (depth <= 0) return false
  const key = `${seq}:${lang}:${superghost ? 's' : 'g'}:${depth}`
  if (memo.has(key)) return memo.get(key)!

  const { append, prepend } = extendingLetters(seq, lang, superghost)
  const allLetters = [...append, ...(superghost ? prepend : [])]

  if (allLetters.length === 0) {
    // No extensions — opponent is stuck (will need to challenge or lose)
    memo.set(key, false)
    return false
  }

  // If every child puts the OPPONENT in a losing position, we're in a winning position
  let allChildrenLosing = true
  for (const ch of allLetters) {
    const appendChild = seq + ch
    const prependChild = ch + seq
    const child = allLetters.includes(ch) && append.has(ch) ? appendChild : prependChild
    if (!isLosingPosition(child, lang, superghost, depth - 1)) {
      allChildrenLosing = false
      break
    }
  }

  // If all children are losing for the opponent, we're winning (not losing)
  const result = !allChildrenLosing
  memo.set(key, result)
  return result
}

export async function botDecide(
  word: string,
  lang: Lang,
  isSuperghost: boolean,
  level: BotLevel,
  challengedBy: string | null,
  _gameId: string,
): Promise<{ action: 'append' | 'prepend' | 'challenge' | 'submit' | 'lie'; letter?: string; word?: string }> {
  await thinkDelay(level)

  // Respond to challenge
  if (challengedBy !== null) {
    const samples = sampleWordsContaining(word, lang, isSuperghost, 20)
    for (const candidate of samples) {
      if (candidate.toLowerCase().includes(word.toLowerCase()) && isWordLocal(candidate, lang)) {
        return { action: 'submit', word: candidate }
      }
    }
    return { action: 'lie' }
  }

  const { append, prepend } = extendingLetters(word, lang, isSuperghost)
  const depth = level === 'easy' ? 0 : level === 'medium' ? 3 : 6

  // Try to find a move that puts the opponent in a losing position
  const allPossible: Array<{ action: 'append' | 'prepend'; letter: string; newWord: string }> = []
  for (const ch of append) {
    allPossible.push({ action: 'append', letter: ch, newWord: word + ch })
  }
  if (isSuperghost) {
    for (const ch of prepend) {
      allPossible.push({ action: 'prepend', letter: ch, newWord: ch + word })
    }
  }

  if (allPossible.length === 0) {
    // No valid extension: challenge (if easy, sometimes wrong)
    if (level === 'easy' && Math.random() < 0.3 && canExtend(word, lang, isSuperghost)) {
      // Easy bot sometimes incorrectly challenges — just pick any append
      const anyLetter = 'abcdefghijklmnopqrstuvwxyz'.split('').find(ch => {
        const t = word + ch
        return canExtend(t, lang, isSuperghost) && !isWordLocal(t, lang)
      })
      if (anyLetter) return { action: 'append', letter: anyLetter }
    }
    return { action: 'challenge' }
  }

  // Shuffle to add variety
  shuffleArray(allPossible)

  if (depth > 0) {
    // Find a move that loses for opponent (winning for us)
    for (const move of allPossible) {
      if (isLosingPosition(move.newWord, lang, isSuperghost, depth)) {
        return { action: move.action, letter: move.letter }
      }
    }
  }

  // Just pick a valid non-word move (easy: random, medium/hard: first valid)
  const safe = allPossible.filter(m => !isWordLocal(m.newWord, lang))
  if (safe.length > 0) {
    return { action: safe[0]!.action, letter: safe[0]!.letter }
  }

  // All moves complete a word — lose gracefully
  return { action: 'append', letter: allPossible[0]!.letter }
}

function shuffleArray<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
}
