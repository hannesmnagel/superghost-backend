import type { Repositories } from '../data/repositories.js'
import type { BotLevel } from '../domain/bot/bot.js'

export interface BotPersona {
  handle: string
  skin: string
  rating: number
  level: BotLevel
}

// A pool of bot personas spread across the rating range so the leaderboard feels populated.
// Ratings drift over time from real outcomes (these are only the seed values).
export const BOT_PERSONAS: BotPersona[] = [
  { handle: 'Whisper', skin: 'Skin/Sailor', rating: 720, level: 'easy' },
  { handle: 'Sprout', skin: 'Skin/Cowboy', rating: 780, level: 'easy' },
  { handle: 'Pebble', skin: 'Skin/Doctor', rating: 850, level: 'easy' },
  { handle: 'Drift', skin: 'Skin/Engineer', rating: 920, level: 'easy' },
  { handle: 'Echo', skin: 'Skin/Knight', rating: 990, level: 'medium' },
  { handle: 'Cinder', skin: 'Skin/Samurai', rating: 1050, level: 'medium' },
  { handle: 'Quill', skin: 'Skin/Sailor', rating: 1120, level: 'medium' },
  { handle: 'Specter', skin: 'Skin/Doctor', rating: 1190, level: 'medium' },
  { handle: 'Mirage', skin: 'Skin/Engineer', rating: 1260, level: 'medium' },
  { handle: 'Phantom', skin: 'Skin/Knight', rating: 1330, level: 'hard' },
  { handle: 'Wraith', skin: 'Skin/Samurai', rating: 1400, level: 'hard' },
  { handle: 'Revenant', skin: 'Skin/Cowboy', rating: 1470, level: 'hard' },
  { handle: 'Banshee', skin: 'Skin/Doctor', rating: 1540, level: 'hard' },
  { handle: 'Eidolon', skin: 'Skin/Knight', rating: 1600, level: 'hard' },
  { handle: 'Lich', skin: 'Skin/Samurai', rating: 1660, level: 'hard' },
]

/** Idempotently ensure every bot persona exists as a User row. */
export async function seedBots(repos: Repositories): Promise<void> {
  for (const p of BOT_PERSONAS) {
    const existing = await repos.users.findByHandle(p.handle)
    if (existing) continue
    await repos.users.create({
      handle: p.handle,
      skin: p.skin,
      rating: p.rating,
      isBot: true,
      botLevel: p.level,
    })
  }
}
