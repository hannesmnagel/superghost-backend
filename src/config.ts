import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string(),
  JWT_SECRET: z.string().min(16),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_DAYS: z.coerce.number().default(60),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default('tencent/hy3-preview'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODERATION_MODEL: z.string().default('omni-moderation-latest'),
  APPLE_BUNDLE_ID: z.string().default('com.nagel.superghost'),
  BOT_FILL_MS: z.coerce.number().default(5000),
  TURN_TIMEOUT_MS: z.coerce.number().default(30000),
  RECONNECT_GRACE_MS: z.coerce.number().default(60000),
  AI_TIMEOUT_MS: z.coerce.number().default(12000),
})

export type AppConfig = z.infer<typeof schema>

function parseConfig(): AppConfig {
  const result = schema.safeParse(process.env)
  if (!result.success) {
    const lines = result.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`)
    const message = `Invalid environment configuration:\n${lines.join('\n')}`
    // In tests we throw (catchable) instead of killing the runner; in real runs we exit.
    if (process.env.NODE_ENV === 'test') throw new Error(message)
    console.error(message)
    process.exit(1)
  }
  return result.data
}

export const config = parseConfig()
