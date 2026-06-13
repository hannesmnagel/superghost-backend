import { createServer } from 'http'
import { createHttpServer } from './http/server.js'
import { createWsServer } from './ws/wsServer.js'
import { loadAll } from './words/wordService.js'
import { db } from './db/prisma.js'
import { config } from './config.js'

async function main() {
  console.log('[boot] Loading word lists...')
  loadAll()

  console.log('[boot] Connecting to database...')
  await db.$connect()

  console.log('[boot] Starting HTTP server...')
  const fastify = await createHttpServer()
  const wss = createWsServer()

  // Share one HTTP server between Fastify and ws
  const httpServer = createServer()

  // Fastify handles all HTTP
  fastify.server = httpServer as any
  await fastify.ready()

  // WebSocket upgrade
  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/ws')) {
      wss.handleUpgrade(req, socket, head, ws => {
        wss.emit('connection', ws, req)
      })
    } else {
      socket.destroy()
    }
  })

  // Serve invite deep-link pages
  httpServer.on('request', (req, res) => {
    if (req.url?.startsWith('/i/')) {
      // Serve join.html for invite codes
      import('fs').then(({ readFileSync }) => {
        import('path').then(({ join, dirname }) => {
          import('url').then(({ fileURLToPath }) => {
            const __dirname = dirname(fileURLToPath(import.meta.url))
            const html = readFileSync(join(__dirname, '../Public/join.html'), 'utf8')
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end(html)
          })
        })
      }).catch(() => {
        res.writeHead(404)
        res.end()
      })
      return
    }
    // Everything else goes through Fastify
    fastify.routing(req as any, res as any)
  })

  httpServer.listen(config.PORT, '0.0.0.0', () => {
    console.log(`[boot] Superghost backend v2 listening on :${config.PORT}`)
    console.log(`[boot] Environment: ${config.NODE_ENV}`)
  })

  // Graceful shutdown
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
