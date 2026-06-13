import { describe, it, expect, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServices } from './helpers/app.js'
import { createHttpServer } from '../src/api/http/index.js'
import type { AppServices } from '../src/app.js'
import { loadFixtureWords } from './helpers/words.js'

let app: FastifyInstance
let services: AppServices

async function guest(deviceKey = 'device-key-123456') {
  const res = await app.inject({ method: 'POST', url: '/auth/guest', payload: { deviceKey } })
  return res.json() as { accessToken: string; refreshToken: string; user: any }
}
const auth = (token: string) => ({ authorization: `Bearer ${token}` })

beforeEach(async () => {
  loadFixtureWords()
  const built = await buildServices()
  services = built.services
  app = await createHttpServer(services, { logLevel: 'silent' })
})

describe('auth + account', () => {
  it('guest auth is idempotent for the same device key', async () => {
    const a = await guest('same-device-key-xyz')
    const b = await guest('same-device-key-xyz')
    expect(a.user.userId).toBe(b.user.userId)
    expect(a.user.handle).toMatch(/^ghost-/)
  })

  it('rejects an unauthenticated /me', async () => {
    const res = await app.inject({ method: 'GET', url: '/me' })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('UNAUTHORIZED')
  })

  it('GET /me returns the authed user', async () => {
    const g = await guest()
    const res = await app.inject({ method: 'GET', url: '/me', headers: auth(g.accessToken) })
    expect(res.statusCode).toBe(200)
    expect(res.json().userId).toBe(g.user.userId)
  })

  it('refresh rotates the refresh token', async () => {
    const g = await guest()
    const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: g.refreshToken } })
    expect(res.statusCode).toBe(200)
    expect(res.json().refreshToken).not.toBe(g.refreshToken)
    // old token no longer works
    const again = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: g.refreshToken } })
    expect(again.statusCode).toBeGreaterThanOrEqual(400)
  })

  it('logout revokes the refresh token', async () => {
    const g = await guest()
    const out = await app.inject({ method: 'POST', url: '/auth/logout', payload: { refreshToken: g.refreshToken } })
    expect(out.json()).toEqual({ ok: true })
    const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: g.refreshToken } })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
  })

  it('apple sign-in merges into the guest account when a device key is supplied', async () => {
    const g = await guest('merge-device-key-abc')
    const res = await app.inject({
      method: 'POST',
      url: '/auth/apple',
      payload: { identityToken: 'tok1', deviceKey: 'merge-device-key-abc' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().user.userId).toBe(g.user.userId) // same underlying user
  })

  it('DELETE /me removes the account', async () => {
    const g = await guest('delete-me-device-key')
    const del = await app.inject({ method: 'DELETE', url: '/me', headers: auth(g.accessToken) })
    expect(del.json()).toEqual({ ok: true })
    expect(await services.repos.users.findById(g.user.userId)).toBeNull()
    // a subsequent guest with the same device key gets a brand-new user
    const again = await guest('delete-me-device-key')
    expect(again.user.userId).not.toBe(g.user.userId)
  })
})

describe('profile', () => {
  it('PATCH /me updates handle and reissues a token', async () => {
    const g = await guest()
    const res = await app.inject({ method: 'PATCH', url: '/me', headers: auth(g.accessToken), payload: { handle: 'NewName' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().handle).toBe('NewName')
    expect(res.json().accessToken).toBeTruthy()
  })

  it('rejects a duplicate handle', async () => {
    const a = await guest('dev-a-123456')
    const b = await guest('dev-b-123456')
    await app.inject({ method: 'PATCH', url: '/me', headers: auth(a.accessToken), payload: { handle: 'Taken' } })
    const res = await app.inject({ method: 'PATCH', url: '/me', headers: auth(b.accessToken), payload: { handle: 'Taken' } })
    expect(res.statusCode).toBe(409)
  })
})

describe('leaderboard includes bots', () => {
  it('GET /leaderboard/top lists bot personas with an isBot flag', async () => {
    const g = await guest()
    const res = await app.inject({ method: 'GET', url: '/leaderboard/top?limit=50', headers: auth(g.accessToken) })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<{ isBot: boolean; rating: number }>
    expect(rows.some(r => r.isBot)).toBe(true)
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].rating).toBeGreaterThanOrEqual(rows[i].rating)
  })

  it('GET /leaderboard returns a window centered on the user', async () => {
    const g = await guest()
    const res = await app.inject({ method: 'GET', url: '/leaderboard', headers: auth(g.accessToken) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.myRank).toBeGreaterThan(0)
    expect(body.entries.some((e: any) => e.isMe)).toBe(true)
  })
})

describe('words (LLM-backed, faked in tests)', () => {
  it('POST /words/check judges a word', async () => {
    const g = await guest()
    const res = await app.inject({ method: 'POST', url: '/words/check', headers: auth(g.accessToken), payload: { word: 'ghost' } })
    expect(res.json()).toEqual({ word: 'ghost', isWord: true })
  })

  it('POST /words/define returns a definition for a real word', async () => {
    const g = await guest()
    const res = await app.inject({ method: 'POST', url: '/words/define', headers: auth(g.accessToken), payload: { word: 'ghost' } })
    expect(res.json().definition).toMatch(/ghost/)
  })
})
