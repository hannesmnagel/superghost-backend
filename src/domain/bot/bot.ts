import {
  isWordLocal,
  canExtend,
  extendingLetters,
  sampleWordsContaining,
  Lang,
  MIN_WORD_LEN,
} from '../words/wordlist.js'

export type BotLevel = 'easy' | 'medium' | 'hard'

export interface BotMove {
  action: 'append' | 'prepend' | 'challenge' | 'submit' | 'lie'
  letter?: string
  word?: string
}

const SEARCH_DEPTH: Record<BotLevel, number> = { easy: 0, medium: 3, hard: 7 }
// Easy occasionally misplays: makes a wrong challenge / random move.
const BLUNDER_CHANCE: Record<BotLevel, number> = { easy: 0.25, medium: 0.05, hard: 0 }

const THINK_RANGE: Record<BotLevel, [number, number]> = {
  easy: [1200, 2800],
  medium: [800, 2000],
  hard: [500, 1500],
}

export function botThinkDelayMs(level: BotLevel, rng: () => number = Math.random): number {
  const [min, max] = THINK_RANGE[level]
  return Math.round(min + rng() * (max - min))
}

interface Candidate {
  action: 'append' | 'prepend'
  letter: string
  next: string
}

function candidateMoves(seq: string, lang: Lang, superghost: boolean): Candidate[] {
  const { append, prepend } = extendingLetters(seq, lang, superghost)
  const out: Candidate[] = []
  for (const ch of append) out.push({ action: 'append', letter: ch, next: seq + ch })
  if (superghost) for (const ch of prepend) out.push({ action: 'prepend', letter: ch, next: ch + seq })
  return out
}

/** A move is "safe" if the result is not itself a complete word and is still extendable. */
function isSafe(next: string, lang: Lang, superghost: boolean): boolean {
  if (next.length >= MIN_WORD_LEN && isWordLocal(next, lang)) return false
  return canExtend(next, lang, superghost)
}

/**
 * True if the player *to move* at `seq` is in a forced-losing position within `depth` plies.
 * A position loses if every move is unsafe, or every safe move leaves the opponent winning.
 * Memoized on (seq, superghost). Beyond `depth` we return false (unknown ≠ forced loss).
 */
function isLosing(
  seq: string,
  lang: Lang,
  superghost: boolean,
  depth: number,
  memo: Map<string, boolean>,
): boolean {
  if (depth <= 0) return false
  const key = `${seq}|${superghost ? 's' : 'g'}`
  const cached = memo.get(key)
  if (cached !== undefined) return cached

  const safe = candidateMoves(seq, lang, superghost).filter(c => isSafe(c.next, lang, superghost))
  if (safe.length === 0) {
    memo.set(key, true) // no safe move available → mover loses
    return true
  }
  let losing = true
  for (const move of safe) {
    if (isLosing(move.next, lang, superghost, depth - 1, memo)) {
      losing = false // opponent loses after this move → mover wins
      break
    }
  }
  memo.set(key, losing)
  return losing
}

/**
 * Decide a move. Pure and synchronous — the runner adds the human-feel delay.
 * `isChallenged` means the bot was challenged and must prove / concede the current sequence.
 */
export function decide(
  seq: string,
  lang: Lang,
  superghost: boolean,
  level: BotLevel,
  isChallenged: boolean,
  rng: () => number = Math.random,
): BotMove {
  if (isChallenged) {
    const samples = sampleWordsContaining(seq, lang, superghost, 25)
    const proof = samples.find(
      w => w.length >= MIN_WORD_LEN && w.toLowerCase().includes(seq.toLowerCase()) && isWordLocal(w, lang),
    )
    if (proof) return { action: 'submit', word: proof }
    return { action: 'lie' }
  }

  const candidates = candidateMoves(seq, lang, superghost)
  const safe = candidates.filter(c => isSafe(c.next, lang, superghost))

  // No safe move. If the current sequence is a genuine dead-end, challenging wins outright.
  if (safe.length === 0) {
    if (seq.length >= 2 && !canExtend(seq, lang, superghost)) return { action: 'challenge' }
    // Otherwise we're cornered: every extension completes a word. Play the least-bad one.
    if (candidates.length > 0) {
      const c = candidates[Math.floor(rng() * candidates.length)]!
      return { action: c.action, letter: c.letter }
    }
    return { action: 'challenge' }
  }

  // Easy bot occasionally blunders (random move or a wrong challenge).
  if (rng() < BLUNDER_CHANCE[level]) {
    if (rng() < 0.4 && seq.length >= 2) return { action: 'challenge' }
    const c = safe[Math.floor(rng() * safe.length)]!
    return { action: c.action, letter: c.letter }
  }

  const depth = SEARCH_DEPTH[level]
  if (depth > 0) {
    const memo = new Map<string, boolean>()
    const winning = shuffle(safe, rng).find(c => isLosing(c.next, lang, superghost, depth, memo))
    if (winning) return { action: winning.action, letter: winning.letter }
  }

  // No proven win: prefer the move that keeps the most options open for us.
  const ranked = shuffle(safe, rng).sort(
    (a, b) =>
      candidateMoves(b.next, lang, superghost).length - candidateMoves(a.next, lang, superghost).length,
  )
  const pick = ranked[0]!
  return { action: pick.action, letter: pick.letter }
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}
