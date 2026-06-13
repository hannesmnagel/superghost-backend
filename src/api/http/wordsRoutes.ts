import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppServices } from '../../app.js'
import { makeRequireAuth } from './common.js'

const bodySchema = z.object({
  word: z.string().min(1).max(50),
  language: z.enum(['en', 'de']).default('en'),
})

export function registerWordsRoutes(app: FastifyInstance, services: AppServices): void {
  const requireAuth = makeRequireAuth(services)

  // Is this a complete, valid word? (LLM-judged, cached.)
  app.post('/words/check', { preHandler: requireAuth }, async (req) => {
    const { word, language } = bodySchema.parse(req.body)
    const w = word.toLowerCase()
    return { word: w, isWord: await services.ai.isCompletedWord(w, language) }
  })

  // Definition for the end-of-game word screen. Public (no auth) so the app's widget/Messages
  // extensions can show definitions without a token.
  app.post('/words/define', async (req) => {
    const { word, language } = bodySchema.parse(req.body)
    const w = word.toLowerCase()
    return { word: w, definition: await services.ai.define(w, language) }
  })
}
