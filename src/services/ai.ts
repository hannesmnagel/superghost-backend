import type { WordVerdictRepository } from '../data/repositories.js'
import type { Lang } from '../domain/words/wordlist.js'
import type { BotLevel, BotMove } from '../domain/bot/bot.js'

export interface BotMoveContext {
  sequence: string
  language: Lang
  isSuperghost: boolean
  level: BotLevel
  isChallenged: boolean
}

/**
 * The LLM is the gameplay authority: it decides bot moves, judges whether a sequence is a
 * completed word, resolves challenges, and defines words. Every method is time-boxed and has a
 * safe degradation so the game never stalls if the model is slow or unreachable.
 */
export interface AiService {
  decideMove(ctx: BotMoveContext): Promise<BotMove>
  isCompletedWord(sequence: string, lang: Lang): Promise<boolean>
  validateSubmission(word: string, sequence: string, lang: Lang): Promise<boolean>
  define(word: string, lang: Lang): Promise<string | null>
  /** Judge whether a username is acceptable (fallback for the OpenAI moderation API). */
  moderateText(text: string): Promise<{ allowed: boolean; reason?: string }>
}

export interface OpenRouterConfig {
  apiKey?: string
  model: string
  timeoutMs: number
  fetchImpl?: typeof fetch
}

const ALLOWED_EN = 'abcdefghijklmnopqrstuvwxyz'
const ALLOWED_DE = 'abcdefghijklmnopqrstuvwxyzäöüß'
// Rough English letter frequency — used only for the offline fallback move.
const FREQ = 'etaoinshrdlcumwfgypbvkjxqz'

function langName(lang: Lang): string {
  return lang === 'de' ? 'German' : 'English'
}
function allowed(lang: Lang): string {
  return lang === 'de' ? ALLOWED_DE : ALLOWED_EN
}

/** Dictionary-free emergency move when the model is unavailable. Keeps the game moving. */
export function fallbackMove(ctx: BotMoveContext): BotMove {
  if (ctx.isChallenged) return { action: 'lie' }
  const letters = allowed(ctx.language)
  const freq = ctx.language === 'de' ? FREQ + 'äöüß' : FREQ
  const letter = [...freq].find(c => letters.includes(c)) ?? 'e'
  if (ctx.isSuperghost && Math.random() < 0.3) return { action: 'prepend', letter }
  return { action: 'append', letter }
}

const LEVEL_GUIDANCE: Record<BotLevel, string> = {
  easy: 'You are a casual, beginner player. Play loosely and make occasional mistakes. Do not think many moves ahead.',
  medium: 'You are a competent player. Play reasonably well and avoid obvious blunders.',
  hard: 'You are an expert player. Play optimally to force your opponent to complete a word. Only challenge when you are confident no word contains the sequence, and always submit a valid word when challenged if one exists.',
}

export function createOpenRouterAiService(words: WordVerdictRepository, cfg: OpenRouterConfig): AiService {
  const doFetch = cfg.fetchImpl ?? fetch

  async function chat(system: string, user: string): Promise<string> {
    if (!cfg.apiKey) throw new Error('No OpenRouter API key configured')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
    try {
      const res = await doFetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          // `tencent/hy3-preview` is a reasoning model: leave reasoning on and it returns the
          // answer in `reasoning` with `content` null (and burns the token budget before emitting
          // content). Disable it so `content` is produced directly and fast.
          reasoning: { enabled: false },
          max_tokens: 200,
          temperature: 0.4,
        }),
        signal: controller.signal,
      })
      const data = (await res.json()) as {
        choices?: Array<{ message: { content: string | null; reasoning?: string | null } }>
      }
      const message = data.choices?.[0]?.message
      return (message?.content ?? message?.reasoning ?? '').trim()
    } finally {
      clearTimeout(timer)
    }
  }

  function parseJson<T>(raw: string): T | null {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return null
    try {
      return JSON.parse(m[0]) as T
    } catch {
      return null
    }
  }

  async function cachedValidity(key: string, lang: Lang, compute: () => Promise<{ valid: boolean; reason: string }>): Promise<boolean> {
    const cached = await words.find(key, lang)
    if (cached) return cached.valid
    const result = await compute()
    await words.upsert(key, lang, result.valid, result.reason).catch(() => {})
    return result.valid
  }

  return {
    async decideMove(ctx) {
      const mode = ctx.isSuperghost
        ? 'Superghost: you may add a letter to either the FRONT or the BACK of the sequence.'
        : 'Ghost: you may add a letter only to the BACK (end) of the sequence.'
      const system = `You are playing the word game ${ctx.isSuperghost ? 'Superghost' : 'Ghost'} in ${langName(ctx.language)}. ${LEVEL_GUIDANCE[ctx.level]}
Rules: players alternate adding ONE letter. ${mode} If after your move the sequence spells a complete valid ${langName(ctx.language)} word of 4+ letters, you LOSE. You must always keep the sequence as the beginning/part of some real word; if you cannot, you may instead "challenge" the opponent (you win if no real word contains the sequence). If you are challenged you must prove a real word that contains the sequence ("submit") or concede ("lie").
Respond ONLY with compact JSON, no prose.`
      let user: string
      if (ctx.isChallenged) {
        user = `You were challenged on the sequence "${ctx.sequence}". If a real ${langName(ctx.language)} word of 4+ letters contains "${ctx.sequence}", respond {"action":"submit","word":"THEWORD"}. Otherwise respond {"action":"lie"}.`
      } else {
        user = `Current sequence: "${ctx.sequence}". Choose your move. Options: {"action":"append","letter":"x"}${ctx.isSuperghost ? ', {"action":"prepend","letter":"x"}' : ''}, or {"action":"challenge"}. The letter must be a single ${langName(ctx.language)} letter.`
      }

      try {
        const raw = await chat(system, user)
        const parsed = parseJson<{ action: string; letter?: string; word?: string }>(raw)
        if (parsed) {
          const sanitized = sanitizeMove(parsed, ctx)
          if (sanitized) return sanitized
        }
      } catch {
        /* fall through */
      }
      return fallbackMove(ctx)
    },

    async isCompletedWord(sequence, lang) {
      if (sequence.length < 4) return false
      try {
        return await cachedValidity(sequence.toLowerCase(), lang, async () => {
          const raw = await chat(
            `You judge ${langName(lang)} words. Respond ONLY with JSON.`,
            `Is "${sequence}" a complete, valid ${langName(lang)} dictionary word (not a proper noun or abbreviation)? Respond {"valid":true|false,"reason":"brief"}.`,
          )
          return parseJson<{ valid: boolean; reason: string }>(raw) ?? { valid: false, reason: 'unparseable' }
        })
      } catch {
        return false // fail open: move stands, opponent can challenge
      }
    },

    async validateSubmission(word, sequence, lang) {
      const w = word.toLowerCase()
      if (w.length < 4 || !w.includes(sequence.toLowerCase())) return false
      try {
        return await cachedValidity(w, lang, async () => {
          const raw = await chat(
            `You judge ${langName(lang)} words. Respond ONLY with JSON.`,
            `Is "${w}" a complete, valid ${langName(lang)} dictionary word (not a proper noun or abbreviation)? Respond {"valid":true|false,"reason":"brief"}.`,
          )
          return parseJson<{ valid: boolean; reason: string }>(raw) ?? { valid: false, reason: 'unparseable' }
        })
      } catch {
        return false
      }
    },

    async moderateText(text) {
      try {
        const raw = await chat(
          'You moderate public usernames for a word game. Respond ONLY with JSON.',
          `Is "${text}" acceptable as a public username? Reject it if it contains slurs, hate, harassment, sexual content, threats, or self-harm. Respond {"allowed":true|false,"reason":"brief"}.`,
        )
        const parsed = parseJson<{ allowed: boolean; reason?: string }>(raw)
        if (!parsed || typeof parsed.allowed !== 'boolean') return { allowed: true }
        return { allowed: parsed.allowed, reason: parsed.reason }
      } catch {
        return { allowed: true } // fail open
      }
    },

    async define(word, lang) {
      try {
        const raw = await chat(
          `You are a concise ${langName(lang)} dictionary. Respond ONLY with JSON.`,
          `Define "${word}" in one short sentence. Respond {"definition":"..."} or {"definition":null} if it is not a real word.`,
        )
        const parsed = parseJson<{ definition: string | null }>(raw)
        return parsed?.definition ?? null
      } catch {
        return null
      }
    },
  }
}

/** Ensure an LLM-proposed move is structurally legal (single allowed letter, right end). */
function sanitizeMove(
  parsed: { action: string; letter?: string; word?: string },
  ctx: BotMoveContext,
): BotMove | null {
  const letters = allowed(ctx.language)
  if (ctx.isChallenged) {
    if (parsed.action === 'submit' && parsed.word && parsed.word.toLowerCase().includes(ctx.sequence.toLowerCase())) {
      return { action: 'submit', word: parsed.word.toLowerCase() }
    }
    if (parsed.action === 'lie') return { action: 'lie' }
    return { action: 'lie' }
  }
  if (parsed.action === 'challenge') return { action: 'challenge' }
  if (parsed.action === 'append' || parsed.action === 'prepend') {
    const letter = (parsed.letter ?? '').toLowerCase()
    if ([...letter].length !== 1 || !letters.includes(letter)) return null
    if (parsed.action === 'prepend' && !ctx.isSuperghost) return { action: 'append', letter }
    return { action: parsed.action, letter }
  }
  return null
}
