import type { AppServices } from '../../app.js'
import type { LiveGame } from '../../domain/game/engine.js'
import * as registry from './registry.js'

// Games whose broadcast listeners are already attached (idempotent across reconnects, and
// across the WS and HTTP entry points that may both wire the same game).
const wired = new WeakSet<LiveGame>()

/**
 * Wire a LiveGame's events to the connected human players' sockets. Centralized here so any
 * code that creates a game (matchmaking over WS, or challenge-accept over HTTP) broadcasts the
 * same way. Bots have no socket and are skipped.
 */
export function wireGameBroadcast(game: LiveGame, services: AppServices): void {
  if (wired.has(game)) return
  wired.add(game)

  const broadcast = (msg: object) => {
    for (const p of game.getPlayers()) if (!p.isBot) registry.send(p.userId, msg)
  }

  game.on('state', state => broadcast({ type: 'state', match: state }))
  game.on('challenged', ({ by, state }) => broadcast({ type: 'challenged', by, match: state }))
  game.on('yourTurn', ({ userId, deadline }) => {
    const p = game.getPlayer(userId)
    if (p && !p.isBot) registry.send(userId, { type: 'yourTurn', deadline })
  })
  game.on('gameOver', async data => {
    let definition: string | null = null
    if (data.word && data.word.length >= 4) {
      definition = await services.ai.define(data.word, game.language).catch(() => null)
    }
    broadcast({ type: 'gameOver', ...data, definition })
    services.matches.removeGame(game)
  })
}
