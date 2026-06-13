import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { startTestServer } from './helpers/app.js'
import { loadFixtureWords } from './helpers/words.js'
import type { AppServices } from '../src/app.js'

let server: Awaited<ReturnType<typeof startTestServer>>

beforeEach(async () => {
  loadFixtureWords()
  server = await startTestServer()
})
afterEach(async () => {
  await server.close()
})

async function guestToken(services: AppServices, deviceKey: string): Promise<string> {
  const { accessToken } = await services.auth.guest(deviceKey)
  return accessToken
}

interface Client {
  ws: WebSocket
  next(type: string, timeoutMs?: number): Promise<any>
  send(msg: object): void
  close(): void
}

function connect(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const queue: any[] = []
  const waiters: Array<{ type: string; resolve: (v: any) => void; reject: (e: any) => void; timer: any }> = []

  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString())
    const i = waiters.findIndex(w => w.type === msg.type)
    if (i >= 0) {
      const [w] = waiters.splice(i, 1)
      clearTimeout(w!.timer)
      w!.resolve(msg)
    } else {
      queue.push(msg)
    }
  })

  const client: Client = {
    ws,
    send: msg => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
    next(type, timeoutMs = 3000) {
      const i = queue.findIndex(m => m.type === type)
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0])
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for "${type}"`)), timeoutMs)
        waiters.push({ type, resolve, reject, timer })
      })
    },
  }
  return new Promise(resolve => ws.on('open', () => resolve(client)))
}

describe('WebSocket gameplay', () => {
  it('authenticates and plays a full bot match to gameOver', async () => {
    const token = await guestToken(server.services, 'ws-device-key-1')
    const c = await connect(server.port)

    c.send({ type: 'auth', token })
    const authed = await c.next('authed')
    const myId = authed.user.userId

    c.send({ type: 'quickmatch', isSuperghost: false, language: 'en' })
    // bot fills after botFillMs -> first state has two players
    const first = await c.next('state')
    expect(first.match.players).toHaveLength(2)
    expect(first.match.players.some((p: any) => p.userId !== myId)).toBe(true)

    // Resign -> we lose, bot wins; gameOver should arrive (with a definition field present).
    c.send({ type: 'resign' })
    const over = await c.next('gameOver')
    expect(over.loserId).toBe(myId)
    expect(over).toHaveProperty('definition')
    expect(over.newRatings[myId]).toBeLessThan(1000)
    c.close()
  })

  it('rejects malformed messages and unauthenticated actions', async () => {
    const c = await connect(server.port)
    c.send({ type: 'quickmatch' }) // not authed yet
    const err1 = await c.next('error')
    expect(err1.code).toBe('UNAUTHORIZED')

    c.ws.send('not json at all')
    const err2 = await c.next('error')
    expect(err2.code).toBe('INVALID_MESSAGE')
    c.close()
  })

  it('pings receive pongs', async () => {
    const token = await guestToken(server.services, 'ws-device-key-2')
    const c = await connect(server.port)
    c.send({ type: 'auth', token })
    await c.next('authed')
    c.send({ type: 'ping' })
    expect((await c.next('pong')).type).toBe('pong')
    c.close()
  })
})
