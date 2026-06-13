import { z } from 'zod'

const lang = z.enum(['en', 'de']).default('en')

// Client -> server messages. Unknown/invalid shapes are rejected with an error frame.
export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string() }),
  z.object({ type: z.literal('quickmatch'), isSuperghost: z.boolean().default(true), language: lang }),
  z.object({ type: z.literal('host'), isSuperghost: z.boolean().default(true), language: lang }),
  z.object({ type: z.literal('join'), code: z.string().optional(), matchId: z.string().optional() }),
  z.object({ type: z.literal('move'), action: z.enum(['append', 'prepend']), letter: z.string().min(1).max(2) }),
  z.object({ type: z.literal('challenge') }),
  z.object({ type: z.literal('submitWord'), word: z.string().min(1).max(60) }),
  z.object({ type: z.literal('admitLie') }),
  z.object({ type: z.literal('resign') }),
  z.object({ type: z.literal('cancel') }),
  z.object({ type: z.literal('resume'), matchId: z.string() }),
  z.object({ type: z.literal('ping') }),
])

export type ClientMessage = z.infer<typeof clientMessageSchema>
