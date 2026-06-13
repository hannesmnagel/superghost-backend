import type { Repositories } from './data/repositories.js'
import { createTokenService, type TokenService } from './services/tokens.js'
import { createAuthService, type AuthService, type AppleVerifier } from './services/auth.js'
import { createOpenRouterAiService, type AiService } from './services/ai.js'
import { createModerationService, type ModerationService } from './services/moderation.js'
import { createApnsService, type ApnsService } from './services/apns.js'
import { MatchService } from './services/match.js'

export interface AppConfigValues {
  jwtSecret: string
  accessExpiresIn: string
  refreshExpiresDays: number
  openRouterKey?: string
  openRouterModel: string
  aiTimeoutMs: number
  openaiKey?: string
  openaiModerationModel: string
  apnsKeyP8?: string
  apnsKeyId?: string
  apnsTeamId?: string
  apnsHost: string
  apnsBundleId: string
  turnTimeoutMs: number
  botFillMs: number
  reconnectGraceMs: number
}

export interface AppServices {
  repos: Repositories
  tokens: TokenService
  auth: AuthService
  ai: AiService
  moderation: ModerationService
  apns: ApnsService
  matches: MatchService
  config: AppConfigValues
}

export interface CreateServicesDeps {
  repos: Repositories
  appleVerifier: AppleVerifier
  config: AppConfigValues
  /** Allow tests to inject a fake AiService instead of OpenRouter. */
  ai?: AiService
}

/** Wire repositories → services. The single composition point used by both prod and tests. */
export function createServices(deps: CreateServicesDeps): AppServices {
  const { repos, config } = deps
  const tokens = createTokenService(repos.auth, {
    jwtSecret: config.jwtSecret,
    accessExpiresIn: config.accessExpiresIn,
    refreshExpiresDays: config.refreshExpiresDays,
  })
  const ai =
    deps.ai ??
    createOpenRouterAiService(repos.words, {
      apiKey: config.openRouterKey,
      model: config.openRouterModel,
      timeoutMs: config.aiTimeoutMs,
    })
  const auth = createAuthService(repos, tokens, deps.appleVerifier)
  const moderation = createModerationService({
    apiKey: config.openaiKey,
    model: config.openaiModerationModel,
    fallback: text => ai.moderateText(text),
  })
  const apns = createApnsService(repos.auth, {
    keyP8: config.apnsKeyP8,
    keyId: config.apnsKeyId,
    teamId: config.apnsTeamId,
    bundleId: config.apnsBundleId,
    host: config.apnsHost,
  })
  const matches = new MatchService({
    repos,
    ai,
    config: { turnTimeoutMs: config.turnTimeoutMs, botFillMs: config.botFillMs },
  })
  return { repos, tokens, auth, ai, moderation, apns, matches, config }
}
