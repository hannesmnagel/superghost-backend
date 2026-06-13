import { describe, it, expect } from 'vitest'
import { createModerationService } from '../src/services/moderation.js'

function fakeFetch(body: object, ok = true) {
  return (async () => ({ ok, json: async () => body })) as unknown as typeof fetch
}
const throwingFetch = (async () => {
  throw new Error('down')
}) as unknown as typeof fetch
const rateLimited = fakeFetch({ error: { message: 'Too Many Requests' } }, false)

describe('ModerationService', () => {
  it('allows clean text', async () => {
    const m = createModerationService({ apiKey: 'k', model: 'm', fetchImpl: fakeFetch({ results: [{ flagged: false }] }) })
    expect((await m.check('CoolGhost')).allowed).toBe(true)
  })

  it('blocks flagged text and reports categories', async () => {
    const m = createModerationService({
      apiKey: 'k',
      model: 'm',
      fetchImpl: fakeFetch({ results: [{ flagged: true, categories: { harassment: true, hate: false } }] }),
    })
    const r = await m.check('something-nasty')
    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('harassment')
  })

  it('fails open with no API key (does not block users)', async () => {
    const m = createModerationService({ model: 'm' })
    expect((await m.check('anything')).allowed).toBe(true)
  })

  it('fails open on API error when no fallback', async () => {
    const m = createModerationService({ apiKey: 'k', model: 'm', fetchImpl: throwingFetch })
    expect((await m.check('anything')).allowed).toBe(true)
  })

  it('uses the LLM fallback when OpenAI is rate-limited (429)', async () => {
    const m = createModerationService({
      apiKey: 'k',
      model: 'm',
      fetchImpl: rateLimited,
      fallback: async text => (text.includes('nope') ? { allowed: false, reason: 'llm' } : { allowed: true }),
    })
    expect((await m.check('fine')).allowed).toBe(true)
    const blocked = await m.check('nope')
    expect(blocked.allowed).toBe(false)
    expect(blocked.reason).toBe('llm')
  })
})
