import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'http'
import type { AppServices } from '../../app.js'
import type { LiveGame, PlayerInfo } from '../../domain/game/engine.js'
import { userToPlayer } from '../../services/match.js'
import * as registry from './registry.js'
import { clientMessageSchema, type ClientMessage } from './protocol.js'

// Games whose broadcast listeners are already attached (avoid duplicates without removing the
// bot driver's listeners).
const broadcastWired = new WeakSet<LiveGame>()

export function createWsServer(services: AppServices): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true })
  const { matches, repos, config } = services

  function humans(game: LiveGame): PlayerInfo[] {
    return game.getPlayers().filter(p => !p.isBot)
  }

  function broadcast(game: LiveGame, msg: object): void {
    for (const p of humans(game)) registry.send(p.userId, msg)
  }

  function wireGame(game: LiveGame): void {
    if (broadcastWired.has(game)) return
    broadcastWired.add(game)

    game.on('state', state => broadcast(game, { type: 'state', match: state }))
    game.on('challenged', ({ by, state }) => broadcast(game, { type: 'challenged', by, match: state }))
    game.on('yourTurn', ({ userId, deadline }) => {
      const p = game.getPlayer(userId)
      if (p && !p.isBot) registry.send(userId, { type: 'yourTurn', deadline })
    })
    game.on('gameOver', async data => {
      let definition: string | null = null
      if (data.word && data.word.length >= 4) {
        definition = await services.ai.define(data.word, game.language).catch(() => null)
      }
      broadcast(game, { type: 'gameOver', ...data, definition })
      matches.removeGame(game)
    })
  }

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    let authedUserId: string | null = null
    let pingInterval: ReturnType<typeof setInterval> | null = null

    const send = (msg: object) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    }
    const sendError = (code: string, message: string) => send({ type: 'error', code, message })

    async function playerFor(userId: string): Promise<PlayerInfo> {
      const u = await repos.users.findById(userId)
      if (!u) throw new Error('User not found')
      return userToPlayer(u)
    }

    ws.on('message', async raw => {
      let parsed: ClientMessage
      try {
        parsed = clientMessageSchema.parse(JSON.parse(raw.toString()))
      } catch (err) {
        return sendError('INVALID_MESSAGE', err instanceof Error ? err.message : 'Invalid message')
      }
      try {
        await handle(parsed)
      } catch (err) {
        sendError('ERROR', err instanceof Error ? err.message : 'Unknown error')
      }
    })

    async function handle(msg: ClientMessage): Promise<void> {
      if (msg.type === 'auth') {
        try {
          const payload = services.tokens.verifyAccessToken(msg.token)
          authedUserId = payload.sub
          await repos.users.touchLastSeen(authedUserId)
          registry.register(authedUserId, ws)
          pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.ping()
          }, 20_000)
          send({ type: 'authed', user: { userId: authedUserId, handle: payload.handle } })

          const existing = matches.getGameByUser(authedUserId)
          if (existing && !existing.isFinished()) {
            registry.clearDisconnectTimer(authedUserId)
            for (const opp of existing.getPlayers()) {
              if (opp.userId !== authedUserId && !opp.isBot) registry.send(opp.userId, { type: 'opponentBack' })
            }
            existing.resumeTimer()
            wireGame(existing)
            send({ type: 'state', match: existing.getState() })
          }
        } catch {
          sendError('AUTH_FAILED', 'Invalid token')
          ws.close()
        }
        return
      }

      if (!authedUserId) return sendError('UNAUTHORIZED', 'Authenticate first with {type:"auth",token}')
      const uid = authedUserId

      switch (msg.type) {
        case 'ping':
          return send({ type: 'pong' })

        case 'quickmatch': {
          send({ type: 'waiting', etaSeconds: Math.round(config.botFillMs / 1000) })
          const game = await matches.quickmatch(await playerFor(uid), msg.isSuperghost, msg.language)
          wireGame(game)
          if (game.getState().phase !== 'lobby') broadcast(game, { type: 'state', match: game.getState() })
          return
        }

        case 'host': {
          const game = matches.hostGame(await playerFor(uid), msg.isSuperghost, msg.language)
          wireGame(game)
          const code = game.inviteCode ?? ''
          send({
            type: 'waiting',
            matchId: game.id,
            inviteCode: code,
            inviteUrl: `https://superghost.hannesnagel.com/i/${code}`,
            etaSeconds: 0,
          })
          return
        }

        case 'join': {
          if (!msg.code && !msg.matchId) return sendError('BAD_REQUEST', 'Provide code or matchId')
          const player = await playerFor(uid)
          const game = msg.code ? matches.joinByCode(player, msg.code) : matches.joinById(player, msg.matchId!)
          wireGame(game)
          broadcast(game, { type: 'state', match: game.getState() })
          return
        }

        case 'resume': {
          const game = matches.getGameByUser(uid)
          if (!game || game.id !== msg.matchId || game.isFinished()) {
            return sendError('NOT_FOUND', 'No active game to resume')
          }
          registry.clearDisconnectTimer(uid)
          game.resumeTimer()
          wireGame(game)
          send({ type: 'state', match: game.getState() })
          return
        }

        case 'move': {
          const game = matches.getGameByUser(uid)
          if (!game) return sendError('NO_GAME', 'Not in a game')
          await game.applyMove(uid, msg.action, { letter: msg.letter })
          return
        }

        case 'challenge': {
          const game = matches.getGameByUser(uid)
          if (!game) return sendError('NO_GAME', 'Not in a game')
          await game.applyMove(uid, 'challenge', {})
          return
        }

        case 'submitWord': {
          const game = matches.getGameByUser(uid)
          if (!game) return sendError('NO_GAME', 'Not in a game')
          await game.applyMove(uid, 'submit', { word: msg.word })
          return
        }

        case 'admitLie': {
          const game = matches.getGameByUser(uid)
          if (!game) return sendError('NO_GAME', 'Not in a game')
          await game.applyMove(uid, 'lie', {})
          return
        }

        case 'resign': {
          const game = matches.getGameByUser(uid)
          if (!game) return sendError('NO_GAME', 'Not in a game')
          await game.applyMove(uid, 'resign', {})
          return
        }
      }
    }

    ws.on('close', () => {
      if (pingInterval) clearInterval(pingInterval)
      if (!authedUserId) return
      const uid = authedUserId
      registry.unregister(uid, ws)
      matches.cancelQueue(uid)

      const game = matches.getGameByUser(uid)
      if (!game || game.isFinished()) return

      game.pauseTimer()
      const graceUntil = new Date(Date.now() + config.reconnectGraceMs).toISOString()
      for (const p of game.getPlayers()) {
        if (p.userId !== uid && !p.isBot) registry.send(p.userId, { type: 'opponentLeft', graceUntil })
      }
      registry.setDisconnectTimer(uid, config.reconnectGraceMs, () => {
        if (!game.isFinished()) void game.applyMove(uid, 'resign', {})
      })
    })

    ws.on('error', err => console.error('WS error:', err.message))
  })

  return wss
}
