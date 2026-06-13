import { createServer } from 'http'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { config } from './config.js'
import { db } from './db/prisma.js'
import { createPrismaRepositories } from './data/prisma.js'
import { createServices, type AppConfigValues } from './app.js'
import { createAppleVerifier } from './services/apple.js'
import { seedBots } from './services/botSeed.js'
import { createHttpServer } from './api/http/index.js'
import { createWsServer } from './api/ws/server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function appConfig(): AppConfigValues {
  return {
    jwtSecret: config.JWT_SECRET,
    accessExpiresIn: config.JWT_ACCESS_EXPIRES_IN,
    refreshExpiresDays: config.JWT_REFRESH_EXPIRES_DAYS,
    openRouterKey: config.OPENROUTER_API_KEY,
    openRouterModel: config.OPENROUTER_MODEL,
    aiTimeoutMs: config.AI_TIMEOUT_MS,
    turnTimeoutMs: config.TURN_TIMEOUT_MS,
    botFillMs: config.BOT_FILL_MS,
    reconnectGraceMs: config.RECONNECT_GRACE_MS,
  }
}

async function main(): Promise<void> {
  console.log('[boot] Connecting to database...')
  await db.$connect()

  const repos = createPrismaRepositories(db)

  console.log('[boot] Seeding bot personas...')
  await seedBots(repos)

  const services = createServices({
    repos,
    appleVerifier: createAppleVerifier(config.APPLE_BUNDLE_ID),
    config: appConfig(),
  })
  if (!config.OPENROUTER_API_KEY) {
    console.warn('[boot] OPENROUTER_API_KEY not set — bots and word checks will use degraded fallbacks.')
  }

  console.log('[boot] Starting HTTP + WebSocket server...')
  const fastify = await createHttpServer(services, {
    logLevel: config.NODE_ENV === 'production' ? 'info' : 'debug',
  })
  const wss = createWsServer(services)

  const httpServer = createServer()
  fastify.server = httpServer as any
  await fastify.ready()

  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/ws')) {
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
    } else {
      socket.destroy()
    }
  })

  // Apple App Site Association — lets the iOS app claim https invite links (universal links).
  const AASA = JSON.stringify({
    applinks: {
      apps: [],
      details: [{ appID: 'X5933694SW.com.nagel.superghost', paths: ['/i/*'] }],
    },
  })

  httpServer.on('request', (req, res) => {
    if (req.url === '/.well-known/apple-app-site-association' || req.url === '/apple-app-site-association') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(AASA)
      return
    }
    if (req.url?.startsWith('/i/')) {
      try {
        const html = readFileSync(join(__dirname, '../Public/join.html'), 'utf8')
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(html)
      } catch {
        res.writeHead(404)
        res.end()
      }
      return
    }
    fastify.routing(req as any, res as any)
  })

  httpServer.listen(config.PORT, '0.0.0.0', () => {
    console.log(`[boot] Superghost backend v2 listening on :${config.PORT} (${config.NODE_ENV})`)
  })

  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
      console.log(`[shutdown] ${sig} received`)
      wss.close()
      await fastify.close()
      await db.$disconnect()
      process.exit(0)
    })
  }
}

main().catch(err => {
  console.error('[boot] Fatal:', err)
  process.exit(1)
})
