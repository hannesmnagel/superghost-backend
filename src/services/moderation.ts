export interface ModerationResult {
  allowed: boolean
  reason?: string
}

export interface ModerationConfig {
  apiKey?: string
  model: string
  fetchImpl?: typeof fetch
  /** Used when the OpenAI moderation API is unavailable / rate-limited (e.g. an LLM judge). */
  fallback?: (text: string) => Promise<ModerationResult>
}

export interface ModerationService {
  /** Check user-supplied text (e.g. a handle). OpenAI moderation first, then the fallback. */
  check(text: string): Promise<ModerationResult>
}

export function createModerationService(cfg: ModerationConfig): ModerationService {
  const doFetch = cfg.fetchImpl ?? fetch

  const fallbackOrAllow = (text: string): Promise<ModerationResult> =>
    cfg.fallback ? cfg.fallback(text) : Promise.resolve({ allowed: true })

  return {
    async check(text) {
      if (cfg.apiKey) {
        try {
          const res = await doFetch('https://api.openai.com/v1/moderations', {
            method: 'POST',
            headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: cfg.model, input: text }),
          })
          const ok = (res as { ok?: boolean }).ok ?? true
          const data = (await res.json()) as {
            results?: Array<{ flagged: boolean; categories?: Record<string, boolean> }>
          }
          const result = data.results?.[0]
          if (ok && result) {
            if (!result.flagged) return { allowed: true }
            const reason = result.categories
              ? Object.entries(result.categories).filter(([, v]) => v).map(([k]) => k).join(', ')
              : 'flagged'
            return { allowed: false, reason }
          }
          // Rate-limited / error response → fall back to the LLM judge.
        } catch {
          /* fall through to fallback */
        }
      }
      return fallbackOrAllow(text)
    },
  }
}
