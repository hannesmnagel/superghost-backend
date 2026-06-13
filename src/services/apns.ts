import http2 from 'node:http2'
import { SignJWT, importPKCS8 } from 'jose'
import type { AuthRepository } from '../data/repositories.js'

export interface ApnsConfig {
  keyP8?: string // PEM (PKCS#8)
  keyId?: string
  teamId?: string
  bundleId: string
  host: string // primary host (e.g. api.push.apple.com)
}

export interface ApnsNotification {
  title: string
  body: string
  data?: Record<string, unknown>
}

export interface ApnsService {
  /** Send a push to all of a user's registered devices. No-op if APNs isn't configured. */
  sendToUser(userId: string, note: ApnsNotification): Promise<void>
}

const SANDBOX_HOST = 'api.sandbox.push.apple.com'

export function createApnsService(devices: AuthRepository, cfg: ApnsConfig): ApnsService {
  const enabled = !!(cfg.keyP8 && cfg.keyId && cfg.teamId)
  if (!enabled) {
    return { async sendToUser() { /* APNs not configured — no-op */ } }
  }

  let cachedToken: { jwt: string; at: number } | null = null

  async function authToken(): Promise<string> {
    // APNs provider tokens are valid up to 60 min; refresh every ~50.
    const now = Date.now()
    if (cachedToken && now - cachedToken.at < 50 * 60_000) return cachedToken.jwt
    const key = await importPKCS8(cfg.keyP8!, 'ES256')
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: cfg.keyId! })
      .setIssuer(cfg.teamId!)
      .setIssuedAt()
      .sign(key)
    cachedToken = { jwt, at: now }
    return jwt
  }

  function postOnce(host: string, token: string, deviceToken: string, payload: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const client = http2.connect(`https://${host}`)
      client.on('error', reject)
      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${token}`,
        'apns-topic': cfg.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      })
      let status = 0
      let data = ''
      req.on('response', headers => { status = Number(headers[':status']) })
      req.setEncoding('utf8')
      req.on('data', chunk => { data += chunk })
      req.on('end', () => { client.close(); resolve({ status, body: data }) })
      req.on('error', err => { client.close(); reject(err) })
      req.end(payload)
    })
  }

  return {
    async sendToUser(userId, note) {
      const tokens = await devices.devicesForUser(userId)
      if (tokens.length === 0) return
      let jwt: string
      try {
        jwt = await authToken()
      } catch (err) {
        console.error('[apns] failed to sign token:', err)
        return
      }
      const payload = JSON.stringify({
        aps: { alert: { title: note.title, body: note.body }, sound: 'default' },
        ...(note.data ?? {}),
      })

      for (const deviceToken of tokens) {
        try {
          let res = await postOnce(cfg.host, jwt, deviceToken, payload)
          // A development-build token rejected by production APNs → retry the sandbox gateway.
          if (res.status === 400 && /BadDeviceToken/.test(res.body) && cfg.host !== SANDBOX_HOST) {
            res = await postOnce(SANDBOX_HOST, jwt, deviceToken, payload)
          }
          if (res.status === 410 || (res.status === 400 && /BadDeviceToken|Unregistered/.test(res.body))) {
            await devices.deleteDevice(deviceToken) // stale token — drop it
          } else if (res.status !== 200) {
            console.warn(`[apns] push to ${deviceToken.slice(0, 8)}… → ${res.status} ${res.body}`)
          }
        } catch (err) {
          console.error('[apns] send failed:', err)
        }
      }
    },
  }
}
