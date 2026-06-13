export interface ModerationConfig {
  apiKey?: string
  model: string
  fetchImpl?: typeof fetch
}

export interface ModerationResult {
  allowed: boolean
  reason?: string
}

export interface ModerationService {
  /** Check user-supplied text (e.g. a handle) against the OpenAI moderation API. */
  check(text: string): Promise<ModerationResult>
}

export function createModerationService(cfg: ModerationConfig): ModerationService {
  const doFetch = cfg.fetchImpl ?? fetch
  return {
    async check(text) {
      if (!cfg.apiKey) return { allowed: true }
      try {
        const res = await doFetch('https://api.openai.com/v1/moderations', {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: cfg.model, input: text }),
        })
        const data = (await res.json()) as {
          results?: Array<{ flagged: boolean; categories?: Record<string, boolean> }>
        }
        const result = data.results?.[0]
        if (!result?.flagged) return { allowed: true }
        const reason = result.categories
          ? Object.entries(result.categories).filter(([, v]) => v).map(([k]) => k).join(', ')
          : 'flagged'
        return { allowed: false, reason }
      } catch {
        // Fail open: don't block legitimate users if moderation is unavailable.
        return { allowed: true }
      }
    },
  }
}
