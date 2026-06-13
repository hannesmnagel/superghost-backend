import type { AiService, BotMoveContext } from '../../src/services/ai.js'
import { decide } from '../../src/domain/bot/bot.js'
import { isWordLocal, MIN_WORD_LEN } from '../../src/domain/words/wordlist.js'
import { seededRng } from './words.js'

/**
 * Offline AiService used in tests: backs the LLM ports with the local fixture dictionary and the
 * minimax bot, so the suite is deterministic and needs no network. Production uses OpenRouter.
 */
export function createFakeAiService(rng: () => number = seededRng()): AiService {
  return {
    async decideMove(ctx: BotMoveContext) {
      return decide(ctx.sequence, ctx.language, ctx.isSuperghost, ctx.level, ctx.isChallenged, rng)
    },
    async isCompletedWord(sequence, lang) {
      return isWordLocal(sequence, lang)
    },
    async validateSubmission(word, sequence, lang) {
      const w = word.toLowerCase()
      return w.length >= MIN_WORD_LEN && w.includes(sequence.toLowerCase()) && isWordLocal(w, lang)
    },
    async define(word, lang) {
      return isWordLocal(word, lang) ? `A test definition of ${word}.` : null
    },
    async moderateText(text) {
      // Deterministic fake: reject anything containing "bad".
      return text.toLowerCase().includes('bad') ? { allowed: false, reason: 'test' } : { allowed: true }
    },
  }
}
