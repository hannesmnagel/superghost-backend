import jwt from 'jsonwebtoken'
import { createHash, randomBytes } from 'crypto'
import { config } from '../config.js'
import { db } from '../db/prisma.js'

export interface AccessTokenPayload {
  sub: string   // userId
  handle: string
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: config.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  })
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, config.JWT_SECRET) as AccessTokenPayload
}

export async function issueRefreshToken(userId: string): Promise<string> {
  const raw = randomBytes(40).toString('hex')
  const hash = createHash('sha256').update(raw).digest('hex')
  const expiresAt = new Date(Date.now() + config.JWT_REFRESH_EXPIRES_DAYS * 86400_000)

  await db.refreshToken.create({ data: { userId, tokenHash: hash, expiresAt } })
  return raw
}

export async function rotateRefreshToken(raw: string): Promise<{ userId: string; newRaw: string }> {
  const hash = createHash('sha256').update(raw).digest('hex')
  const token = await db.refreshToken.findUnique({ where: { tokenHash: hash } })

  if (!token || token.revokedAt || token.expiresAt < new Date()) {
    throw new Error('Invalid or expired refresh token')
  }

  await db.refreshToken.update({ where: { id: token.id }, data: { revokedAt: new Date() } })
  const newRaw = await issueRefreshToken(token.userId)
  return { userId: token.userId, newRaw }
}

export async function revokeRefreshToken(raw: string): Promise<void> {
  const hash = createHash('sha256').update(raw).digest('hex')
  await db.refreshToken.updateMany({ where: { tokenHash: hash }, data: { revokedAt: new Date() } })
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}
