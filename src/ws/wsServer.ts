import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'http'
import { verifyAccessToken } from '../auth/tokens.js'
import { db } from '../db/prisma.js'
import * as registry from './registry.js'
import {
  quickmatch,
  hostGame,
  joinByCode,
  joinById,
  getGameByUser,
  removeGame,
} from '../game/matchmaking.js'
import { config } from '../config.js'
import { Lang } from '../words/wordService.js'
import { LiveGame } from '../game/engine.js'
import { isBotId } from '../bot/bot.js'

interface AuthedSocket {
  userId: string
  handle: string
}

export function createWsServer(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true })

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    let authed: AuthedSocket | null = null
    let pingInterval: ReturnType<typeof setInterval> | null = null

    function send(msg: object): void {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    }

    function sendError(code: string, message: string): void {
      send({ type: 'error', code, message })
    }

    function broadcastState(game: LiveGame): void {
      const state = game.getState()
      for (const p of game.getPlayers()) {
        if (!isBotId(p.userId)) registry.send(p.userId, { type: 'state', match: state })
      }
    }

    function wireGame(game: LiveGame): void {
      // Avoid duplicate listeners
      game.removeAllListeners('state')
      game.removeAllListeners('challenged')
      game.removeAllListeners('yourTurn')
      game.removeAllListeners('gameOver')

      game.on('state', (state) => {
        for (const p of game.getPlayers()) {
          if (!isBotId(p.userId)) registry.send(p.userId, { type: 'state', match: state })
        }
      })

      game.on('challenged', ({ by, state }) => {
        for (const p of game.getPlayers()) {
          if (!isBotId(p.userId)) registry.send(p.userId, { type: 'challenged', by, match: state })
        }
      })

      game.on('yourTurn', ({ userId, deadline }) => {
        if (!isBotId(userId)) registry.send(userId, { type: 'yourTurn', deadline })
      })

      game.on('gameOver', (data) => {
        for (const p of game.getPlayers()) {
          if (!isBotId(p.userId)) registry.send(p.userId, { type: 'gameOver', ...data })
        }
        removeGame(game)
      })
    }

    ws.on('message', async (raw) => {
      let msg: { type: string; [k: string]: unknown }
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return sendError('INVALID_JSON', 'Invalid JSON')
      }

      try {
        await handleMessage(msg)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        sendError('ERROR', message)
      }
    })

    async function handleMessage(msg: { type: string; [k: string]: unknown }): Promise<void> {
      // Auth must be first
      if (msg.type === 'auth') {
        const token = msg.token as string
        try {
          const payload = verifyAccessToken(token)
          authed = { userId: payload.sub, handle: payload.handle }

          // Update last seen
          await db.user.update({ where: { id: authed.userId }, data: { lastSeenAt: new Date() } }).catch(() => {})

          registry.register(authed.userId, ws)

          // Start ping keepalive
          pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.ping()
          }, 20_000)

          send({ type: 'authed', user: { userId: authed.userId, handle: authed.handle } })

          // If reconnecting to an in-progress game, restore it
          const existingGame = getGameByUser(authed.userId)
          if (existingGame && !existingGame.isFinished()) {
            registry.clearDisconnectTimer(authed.userId)
            const opponents = existingGame.getPlayers().filter(p => p.userId !== authed!.userId)
            for (const opp of opponents) {
              if (!isBotId(opp.userId)) registry.send(opp.userId, { type: 'opponentBack' })
            }
            existingGame.resumeTimer()
            wireGame(existingGame)
            send({ type: 'state', match: existingGame.getState() })
          }
        } catch {
          sendError('AUTH_FAILED', 'Invalid token')
          ws.close()
        }
        return
      }

      if (!authed) return sendError('UNAUTHORIZED', 'Authenticate first with {type:"auth",token}')

      const { userId, handle } = authed

      switch (msg.type) {
        case 'ping': {
          send({ type: 'pong' })
          break
        }

        case 'quickmatch': {
          const isSuperghost = (msg.isSuperghost as boolean) ?? true
          const lang = ((msg.language as string) ?? 'en') as Lang
          const userRec = await db.user.findUnique({ where: { id: userId } })
          const player = { userId, handle, skin: userRec?.skin ?? 'Skin/Cowboy', rating: userRec?.rating ?? 1000 }

          send({ type: 'waiting', etaSeconds: config.BOT_FILL_MS / 1000 })
          const game = await quickmatch(player, isSuperghost, lang)
          wireGame(game)
          broadcastState(game)
          break
        }

        case 'host': {
          const isSuperghost = (msg.isSuperghost as boolean) ?? true
          const lang = ((msg.language as string) ?? 'en') as Lang
          const userRec = await db.user.findUnique({ where: { id: userId } })
          const player = { userId, handle, skin: userRec?.skin ?? 'Skin/Cowboy', rating: userRec?.rating ?? 1000 }

          const game = hostGame(player, isSuperghost, lang)
          wireGame(game)
          const code = game.inviteCode ?? ''
          const url = `https://superghost.hannesnagel.com/i/${code}`
          send({ type: 'waiting', matchId: game.id, inviteCode: code, inviteUrl: url, etaSeconds: 0 })
          break
        }

        case 'join': {
          const code = (msg.code as string | undefined)?.toUpperCase()
          const matchId = msg.matchId as string | undefined
          if (!code && !matchId) return sendError('BAD_REQUEST', 'Provide code or matchId')

          const userRec = await db.user.findUnique({ where: { id: userId } })
          const player = { userId, handle, skin: userRec?.skin ?? 'Skin/Cowboy', rating: userRec?.rating ?? 1000 }

          const game = code ? joinByCode(player, code) : joinById(player, matchId!)
          wireGame(game)
          broadcastState(game)
          break
        }

        case 'resume': {
          const matchId = msg.matchId as string
          const game = getGameByUser(userId)
          if (!game || game.id !== matchId || game.isFinished()) {
            return sendError('NOT_FOUND', 'No active game to resume')
          }
          registry.clearDisconnectTimer(userId)
          game.resumeTimer()
          wireGame(game)
          send({ type: 'state', match: game.getState() })
          break
        }

        case 'move': {
          const game = getGameByUser(userId)
          if (!game) return sendError('NO_GAME', 'Not in a game')
          const action = msg.action as string
          const letter = msg.letter as string | undefined
          game.applyMove(userId, action as any, { letter })
          break
        }

        case 'challenge': {
          const game = getGameByUser(userId)
          if (!game) return sendError('NO_GAME', 'Not in a game')
          game.applyMove(userId, 'challenge', {})
          break
        }

        case 'submitWord': {
          const game = getGameByUser(userId)
          if (!game) return sendError('NO_GAME', 'Not in a game')
          const word = msg.word as string
          await game.applyMove(userId, 'submit', { word })
          break
        }

        case 'admitLie': {
          const game = getGameByUser(userId)
          if (!game) return sendError('NO_GAME', 'Not in a game')
          game.applyMove(userId, 'lie', {})
          break
        }

        case 'resign': {
          const game = getGameByUser(userId)
          if (!game) return sendError('NO_GAME', 'Not in a game')
          game.applyMove(userId, 'resign', {})
          break
        }

        default:
          sendError('UNKNOWN_TYPE', `Unknown message type: ${msg.type}`)
      }
    }

    ws.on('close', () => {
      if (pingInterval) clearInterval(pingInterval)
      if (!authed) return

      const { userId } = authed
      registry.unregister(userId, ws)

      const game = getGameByUser(userId)
      if (!game || game.isFinished()) return

      // Grace period: keep game alive, notify opponent
      game.pauseTimer()
      const graceUntil = new Date(Date.now() + config.RECONNECT_GRACE_MS).toISOString()

      for (const p of game.getPlayers()) {
        if (p.userId !== userId && !isBotId(p.userId)) {
          registry.send(p.userId, { type: 'opponentLeft', graceUntil })
        }
      }

      registry.setDisconnectTimer(userId, config.RECONNECT_GRACE_MS, () => {
        // Grace expired — opponent wins
        const players = game.getPlayers()
        const opponent = players.find(p => p.userId !== userId)
        if (opponent && !game.isFinished()) {
          game.applyMove(userId, 'resign', {})
        }
      })
    })

    ws.on('error', (err) => {
      console.error('WS error:', err.message)
    })
  })

  return wss
}
