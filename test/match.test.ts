import { describe, it, expect, beforeEach } from 'vitest'
import { MatchService, userToPlayer } from '../src/services/match.js'
import { createMemoryRepositories } from '../src/data/memory.js'
import { seedBots } from '../src/services/botSeed.js'
import type { Repositories } from '../src/data/repositories.js'
import { LiveGame } from '../src/domain/game/engine.js'
import { loadFixtureWords } from './helpers/words.js'
import { createFakeAiService } from './helpers/ai.js'

function buildService(repos: Repositories): MatchService {
  return new MatchService({
    repos,
    ai: createFakeAiService(),
    config: { turnTimeoutMs: 5000, botFillMs: 5 },
    botDelayMs: () => 0, // act immediately in tests
  })
}

function onceEvent<T = any>(game: LiveGame, name: string): Promise<T> {
  return new Promise(resolve => game.once(name, resolve))
}

async function waitFor(cond: () => boolean, ms = 1500): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (cond()) return
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error('waitFor timed out')
}

let repos: Repositories & { _reset(): void }
let svc: MatchService

beforeEach(async () => {
  loadFixtureWords()
  repos = createMemoryRepositories()
  await seedBots(repos)
  svc = buildService(repos)
})

describe('matchmaking', () => {
  it('fills with a bot near the human rating after the timeout', async () => {
    const human = await repos.users.create({ handle: 'alice', rating: 1100 })
    const game = await svc.quickmatch(userToPlayer(human), false, 'en')

    const opp = game.getPlayers().find(p => p.userId !== human.id)!
    expect(opp.isBot).toBe(true)
    expect(Math.abs(opp.rating - 1100)).toBeLessThanOrEqual(120) // nearest persona
  })

  it('pairs two waiting humans without a bot', async () => {
    const a = await repos.users.create({ handle: 'a', rating: 1000 })
    const b = await repos.users.create({ handle: 'b', rating: 1000 })

    const pa = svc.quickmatch(userToPlayer(a), false, 'en')
    const gb = await svc.quickmatch(userToPlayer(b), false, 'en')
    const ga = await pa

    expect(ga.id).toBe(gb.id)
    expect(ga.getPlayers().some(p => p.isBot)).toBe(false)
    expect(ga.getPlayers().map(p => p.userId).sort()).toEqual([a.id, b.id].sort())
  })
})

describe('bots participate in rating (leaderboard)', () => {
  it('updates both the human and the bot rating after a game, and records the match', async () => {
    const human = await repos.users.create({ handle: 'carol', rating: 1000 })
    const game = await svc.quickmatch(userToPlayer(human), false, 'en')
    const bot = game.getPlayers().find(p => p.isBot)!
    const botBefore = (await repos.users.findById(bot.userId))!.rating

    const over = onceEvent(game, 'gameOver')
    await game.applyMove(human.id, 'resign', {}) // human loses -> bot rating rises
    const result = await over

    expect(result.winnerId).toBe(bot.userId)
    const humanAfter = (await repos.users.findById(human.id))!.rating
    const botAfter = (await repos.users.findById(bot.userId))!.rating
    expect(humanAfter).toBeLessThan(1000)
    expect(botAfter).toBeGreaterThan(botBefore)

    // Match persisted with the bot as a real opponent (not null) and flagged as a bot game.
    const matches = await repos.matches.listForUser(human.id, 10)
    expect(matches).toHaveLength(1)
    expect(matches[0]!.isBot).toBe(true)
    expect(matches[0]!.player2Id).toBe(bot.userId)
  })

  it('a stale hosting lobby does not block matchmaking (regression)', async () => {
    const human = await repos.users.create({ handle: 'erin', rating: 1000 })
    const lobby = svc.hostGame(userToPlayer(human), false, 'en')
    expect(lobby.getPhase()).toBe('lobby')
    expect(svc.getGameById(lobby.id)).toBeDefined()

    // Quickmatching must abandon the unstarted lobby, not return it forever.
    const game = await svc.quickmatch(userToPlayer(human), false, 'en')
    expect(game.id).not.toBe(lobby.id)
    expect(game.getPlayers()).toHaveLength(2) // got a real opponent (bot)
    expect(svc.getGameById(lobby.id)).toBeUndefined() // lobby torn down
  })

  it('createChallengeMatch seats both players and starts', async () => {
    const a = await repos.users.create({ handle: 'frank', rating: 1000 })
    const b = await repos.users.create({ handle: 'grace', rating: 1000 })
    const game = await svc.createChallengeMatch(a.id, b.id)
    expect(game.getPlayers().map(p => p.userId).sort()).toEqual([a.id, b.id].sort())
    expect(game.getState().phase).toBe('playing')
  })

  it('the bot actually responds with a move after the human plays (regression)', async () => {
    const human = await repos.users.create({ handle: 'dave', rating: 1000 })
    const game = await svc.quickmatch(userToPlayer(human), false, 'en')
    expect(game.currentTurnUserId()).toBe(human.id)

    await game.applyMove(human.id, 'append', { letter: 's' })
    // Bot driver must pick up the turn and extend the sequence (or end the game) on its own.
    await waitFor(() => game.getState().word.length >= 2 || game.isFinished())

    expect(game.getState().word.length).toBeGreaterThanOrEqual(2)
  })

  it('bots appear in the global leaderboard ordering', async () => {
    const top = await repos.users.topByRating(50)
    const botsOnBoard = top.filter(u => u.isBot)
    expect(botsOnBoard.length).toBeGreaterThan(0)
    // sorted descending by rating
    for (let i = 1; i < top.length; i++) expect(top[i - 1]!.rating).toBeGreaterThanOrEqual(top[i]!.rating)
  })
})
