import jwt from 'jsonwebtoken'
import { createHash, randomBytes } from 'crypto'
import type { AuthRepository } from '../data/repositories.js'

export interface AccessTokenPayload {
  sub: string // userId
  handle: string
}

export interface TokenServiceConfig {
  jwtSecret: string
  accessExpiresIn: string
  refreshExpiresDays: number
}

export interface TokenService {
  signAccessToken(payload: AccessTokenPayload): string
  verifyAccessToken(token: string): AccessTokenPayload
  issueRefreshToken(userId: string): Promise<string>
  rotateRefreshToken(raw: string): Promise<{ userId: string; newRaw: string }>
  revokeRefreshToken(raw: string): Promise<void>
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

export function createTokenService(auth: AuthRepository, cfg: TokenServiceConfig): TokenService {
  return {
    signAccessToken(payload) {
      return jwt.sign(payload, cfg.jwtSecret, { expiresIn: cfg.accessExpiresIn as jwt.SignOptions['expiresIn'] })
    },
    verifyAccessToken(token) {
      return jwt.verify(token, cfg.jwtSecret) as AccessTokenPayload
    },
    async issueRefreshToken(userId) {
      const raw = randomBytes(40).toString('hex')
      const hash = hashSecret(raw)
      const expiresAt = new Date(Date.now() + cfg.refreshExpiresDays * 86_400_000)
      await auth.createRefreshToken(userId, hash, expiresAt)
      return raw
    },
    async rotateRefreshToken(raw) {
      const hash = hashSecret(raw)
      const token = await auth.findRefreshToken(hash)
      if (!token || token.revokedAt || token.expiresAt < new Date()) {
        throw new Error('Invalid or expired refresh token')
      }
      await auth.revokeRefreshTokenById(token.id)
      const newRaw = await this.issueRefreshToken(token.userId)
      return { userId: token.userId, newRaw }
    },
    async revokeRefreshToken(raw) {
      await auth.revokeRefreshTokenByHash(hashSecret(raw))
    },
  }
}
