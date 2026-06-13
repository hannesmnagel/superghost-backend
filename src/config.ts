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
  APPLE_BUNDLE_ID: z.string().default('com.nagel.superghost'),
  BOT_FILL_MS: z.coerce.number().default(5000),
  TURN_TIMEOUT_MS: z.coerce.number().default(30000),
  RECONNECT_GRACE_MS: z.coerce.number().default(60000),
})

function parseConfig() {
  const result = schema.safeParse(process.env)
  if (!result.success) {
    console.error('Invalid environment configuration:')
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`)
    }
    process.exit(1)
  }
  return result.data
}

export const config = parseConfig()
