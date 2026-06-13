import { describe, it, expect } from 'vitest'
import { createModerationService } from '../src/services/moderation.js'

function fakeFetch(body: object) {
  return (async () => ({ json: async () => body })) as unknown as typeof fetch
}
const throwingFetch = (async () => {
  throw new Error('down')
}) as unknown as typeof fetch

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

  it('fails open on API error', async () => {
    const m = createModerationService({ apiKey: 'k', model: 'm', fetchImpl: throwingFetch })
    expect((await m.check('anything')).allowed).toBe(true)
  })
})
