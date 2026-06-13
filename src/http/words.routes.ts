import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { isWordLocal, isWordWithAiFallback, sampleWordsContaining, canExtend, extendingLetters } from '../words/wordService.js'
import { requireAuth } from './auth.routes.js'

export async function registerWordsRoutes(app: FastifyInstance): Promise<void> {
  // Quick local word check — used by client for live validation feedback
  app.post('/words/check', { preHandler: requireAuth }, async (req) => {
    const schema = z.object({
      word: z.string().min(1).max(50),
      language: z.enum(['en', 'de']).default('en'),
      isSuperghost: z.boolean().default(true),
    })
    const { word, language, isSuperghost } = schema.parse(req.body)

    const w = word.toLowerCase()
    const isValid = isWordLocal(w, language)
    const extendable = canExtend(w, language, isSuperghost)
    const { append, prepend } = extendingLetters(w, language, isSuperghost)

    return {
      word: w,
      isWord: isValid,
      canExtend: extendable,
      appendLetters: [...append],
      prependLetters: [...prepend],
      samples: sampleWordsContaining(w, language, isSuperghost, 5),
    }
  })

  // AI-backed check for dispute resolution (slower, cached)
  app.post('/words/verify', { preHandler: requireAuth }, async (req) => {
    const schema = z.object({
      word: z.string().min(1).max(50),
      language: z.enum(['en', 'de']).default('en'),
    })
    const { word, language } = schema.parse(req.body)
    const valid = await isWordWithAiFallback(word, language)
    return { word: word.toLowerCase(), valid }
  })
}
