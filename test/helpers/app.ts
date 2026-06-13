import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { createMemoryRepositories } from '../../src/data/memory.js'
import { createServices, type AppConfigValues, type AppServices } from '../../src/app.js'
import type { AppleVerifier } from '../../src/services/auth.js'
import { seedBots } from '../../src/services/botSeed.js'
import { createHttpServer } from '../../src/api/http/index.js'
import { createWsServer } from '../../src/api/ws/server.js'
import { createFakeAiService } from './ai.js'
import type { Repositories } from '../../src/data/repositories.js'

// Apple verifier that treats the identity token as the subject — handy for merge tests.
const fakeApple: AppleVerifier = async token => ({ sub: `apple-${token}` })

export function testConfig(over: Partial<AppConfigValues> = {}): AppConfigValues {
  return {
    jwtSecret: 'test-secret-key-at-least-16-chars-long',
    accessExpiresIn: '15m',
    refreshExpiresDays: 60,
    openRouterModel: 'test-model',
    aiTimeoutMs: 1000,
    openaiModerationModel: 'test-moderation',
    apnsHost: 'api.push.apple.com',
    apnsBundleId: 'com.nagel.superghost',
    turnTimeoutMs: 5000,
    botFillMs: 20,
    reconnectGraceMs: 200,
    ...over,
  }
}

export async function buildServices(over: Partial<AppConfigValues> = {}): Promise<{
  services: AppServices
  repos: Repositories & { _reset(): void }
}> {
  const repos = createMemoryRepositories()
  await seedBots(repos)
  const services = createServices({
    repos,
    appleVerifier: fakeApple,
    config: testConfig(over),
    ai: createFakeAiService(),
  })
  return { services, repos }
}

/** Boot the combined HTTP + WS server on an ephemeral port (mirrors src/index.ts wiring). */
export async function startTestServer(over: Partial<AppConfigValues> = {}): Promise<{
  services: AppServices
  repos: Repositories
  port: number
  close: () => Promise<void>
}> {
  const { services, repos } = await buildServices(over)
  const fastify = await createHttpServer(services, { logLevel: 'silent' })
  const wss = createWsServer(services)
  const httpServer: Server = createServer()
  ;(fastify as any).server = httpServer
  await fastify.ready()

  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/ws')) wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
    else socket.destroy()
  })
  httpServer.on('request', (req, res) => fastify.routing(req as any, res as any))

  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
  const port = (httpServer.address() as AddressInfo).port

  return {
    services,
    repos,
    port,
    close: async () => {
      wss.close()
      await fastify.close()
      await new Promise<void>(resolve => httpServer.close(() => resolve()))
    },
  }
}
