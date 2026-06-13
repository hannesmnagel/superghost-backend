import { describe, it, expect, beforeEach } from 'vitest'
import { createOpenRouterAiService, fallbackMove } from '../src/services/ai.js'
import { createMemoryRepositories } from '../src/data/memory.js'
import type { Repositories } from '../src/data/repositories.js'

// Build a fake `fetch` that returns a fixed assistant message, and counts calls.
function fakeFetch(content: string) {
  const calls: any[] = []
  const fn = (async (_url: any, init: any) => {
    calls.push(JSON.parse(init.body))
    return { json: async () => ({ choices: [{ message: { content } }] }) } as any
  }) as unknown as typeof fetch
  return { fn, calls }
}

const throwingFetch = (async () => {
  throw new Error('network down')
}) as unknown as typeof fetch

let repos: Repositories

beforeEach(() => {
  repos = createMemoryRepositories()
})

describe('AiService (OpenRouter) — moves', () => {
  it('parses and accepts a legal append move', async () => {
    const { fn } = fakeFetch('{"action":"append","letter":"r"}')
    const ai = createOpenRouterAiService(repos.words, { apiKey: 'k', model: 'm', timeoutMs: 1000, fetchImpl: fn })
    const move = await ai.decideMove({ sequence: 'wo', language: 'en', isSuperghost: false, level: 'hard', isChallenged: false })
    expect(move).toEqual({ action: 'append', letter: 'r' })
  })

  it('coerces prepend to append in Ghost mode', async () => {
    const { fn } = fakeFetch('{"action":"prepend","letter":"s"}')
    const ai = createOpenRouterAiService(repos.words, { apiKey: 'k', model: 'm', timeoutMs: 1000, fetchImpl: fn })
    const move = await ai.decideMove({ sequence: 'word', language: 'en', isSuperghost: false, level: 'hard', isChallenged: false })
    expect(move).toEqual({ action: 'append', letter: 's' })
  })

  it('falls back to a legal move when the model returns garbage', async () => {
    const { fn } = fakeFetch('no json here, just prose')
    const ai = createOpenRouterAiService(repos.words, { apiKey: 'k', model: 'm', timeoutMs: 1000, fetchImpl: fn })
    const move = await ai.decideMove({ sequence: 'wo', language: 'en', isSuperghost: false, level: 'easy', isChallenged: false })
    expect(['append', 'prepend', 'challenge']).toContain(move.action)
  })

  it('rejects an illegal letter and falls back', async () => {
    const { fn } = fakeFetch('{"action":"append","letter":"77"}')
    const ai = createOpenRouterAiService(repos.words, { apiKey: 'k', model: 'm', timeoutMs: 1000, fetchImpl: fn })
    const move = await ai.decideMove({ sequence: 'wo', language: 'en', isSuperghost: false, level: 'medium', isChallenged: false })
    expect(move.action).toBe('append')
    expect([...(move.letter ?? '')].length).toBe(1)
  })

  it('falls back to a move when the network throws', async () => {
    const ai = createOpenRouterAiService(repos.words, { apiKey: 'k', model: 'm', timeoutMs: 1000, fetchImpl: throwingFetch })
    const move = await ai.decideMove({ sequence: 'wo', language: 'en', isSuperghost: true, level: 'hard', isChallenged: false })
    expect(['append', 'prepend']).toContain(move.action)
  })

  it('lies when challenged and the model fails', async () => {
    const ai = createOpenRouterAiService(repos.words, { apiKey: 'k', model: 'm', timeoutMs: 1000, fetchImpl: throwingFetch })
    const move = await ai.decideMove({ sequence: 'zzz', language: 'en', isSuperghost: false, level: 'hard', isChallenged: true })
    expect(move.action).toBe('lie')
  })
})

describe('AiService (OpenRouter) — word judgement', () => {
  it('judges and caches isCompletedWord', async () => {
    const { fn, calls } = fakeFetch('{"valid":true,"reason":"a noun"}')
    const ai = createOpenRouterAiService(repos.words, { apiKey: 'k', model: 'm', timeoutMs: 1000, fetchImpl: fn })
    expect(await ai.isCompletedWord('word', 'en')).toBe(true)
    expect(await ai.isCompletedWord('word', 'en')).toBe(true) // served from cache
    expect(calls.length).toBe(1)
  })

  it('isCompletedWord returns false for short sequences without calling the model', async () => {
    const { fn, calls } = fakeFetch('{"valid":true}')
    const ai = createOpenRouterAiService(repos.words, { apiKey: 'k', model: 'm', timeoutMs: 1000, fetchImpl: fn })
    expect(await ai.isCompletedWord('wor', 'en')).toBe(false)
    expect(calls.length).toBe(0)
  })

  it('validateSubmission requires the sequence to be contained', async () => {
    const { fn } = fakeFetch('{"valid":true,"reason":"ok"}')
    const ai = createOpenRouterAiService(repos.words, { apiKey: 'k', model: 'm', timeoutMs: 1000, fetchImpl: fn })
    expect(await ai.validateSubmission('sword', 'wor', 'en')).toBe(true)
    expect(await ai.validateSubmission('apple', 'wor', 'en')).toBe(false) // doesn't contain "wor"
  })

  it('fails closed (false) on judgement errors so the game never hangs', async () => {
    const ai = createOpenRouterAiService(repos.words, { apiKey: 'k', model: 'm', timeoutMs: 1000, fetchImpl: throwingFetch })
    expect(await ai.isCompletedWord('word', 'en')).toBe(false)
    expect(await ai.validateSubmission('sword', 'wor', 'en')).toBe(false)
  })

  it('returns a definition', async () => {
    const { fn } = fakeFetch('{"definition":"a unit of language"}')
    const ai = createOpenRouterAiService(repos.words, { apiKey: 'k', model: 'm', timeoutMs: 1000, fetchImpl: fn })
    expect(await ai.define('word', 'en')).toBe('a unit of language')
  })

  it('degrades gracefully with no API key', async () => {
    const ai = createOpenRouterAiService(repos.words, { model: 'm', timeoutMs: 1000 })
    expect(await ai.isCompletedWord('word', 'en')).toBe(false)
    const move = await ai.decideMove({ sequence: 'wo', language: 'en', isSuperghost: false, level: 'hard', isChallenged: false })
    expect(move.action).toBe('append')
  })
})

describe('fallbackMove', () => {
  it('produces a legal letter for the language', () => {
    expect(fallbackMove({ sequence: 'x', language: 'en', isSuperghost: false, level: 'easy', isChallenged: false }).action).toBe('append')
    expect(fallbackMove({ sequence: 'x', language: 'en', isSuperghost: false, level: 'easy', isChallenged: true }).action).toBe('lie')
  })
})
