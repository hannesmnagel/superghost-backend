import { createHash, randomBytes } from 'crypto'
import type { Repositories, UserRecord } from '../data/repositories.js'
import { hashSecret, type TokenService } from './tokens.js'

export interface AppleIdentity {
  sub: string
  email?: string
}
export type AppleVerifier = (identityToken: string) => Promise<AppleIdentity>

export interface PublicUser {
  userId: string
  handle: string
  skin: string
  rating: number
}

export interface AuthResult {
  accessToken: string
  refreshToken: string
  user: PublicUser
}

export function publicUser(u: UserRecord): PublicUser {
  return { userId: u.id, handle: u.handle, skin: u.skin, rating: u.rating }
}

function generateHandle(): string {
  return `ghost-${randomBytes(3).toString('hex').toUpperCase()}`
}

export class HandleTakenError extends Error {}

export interface AuthService {
  guest(deviceKey: string): Promise<AuthResult>
  apple(identityToken: string, deviceKey?: string): Promise<AuthResult>
  refresh(refreshToken: string): Promise<AuthResult>
  logout(refreshToken: string): Promise<void>
  registerDevice(userId: string, apnsToken: string): Promise<void>
  deleteAccount(userId: string): Promise<void>
}

export function createAuthService(
  repos: Repositories,
  tokens: TokenService,
  verifyApple: AppleVerifier,
): AuthService {
  async function issue(userId: string, handle: string): Promise<{ accessToken: string; refreshToken: string }> {
    return {
      accessToken: tokens.signAccessToken({ sub: userId, handle }),
      refreshToken: await tokens.issueRefreshToken(userId),
    }
  }

  async function createUniqueUser(extra?: { isBot?: boolean; botLevel?: string }): Promise<UserRecord> {
    // Retry on the (astronomically unlikely) handle collision.
    for (let i = 0; i < 5; i++) {
      try {
        return await repos.users.create({ handle: generateHandle(), ...extra })
      } catch {
        /* retry */
      }
    }
    throw new Error('Could not allocate a unique handle')
  }

  return {
    async guest(deviceKey) {
      const subject = createHash('sha256').update(deviceKey).digest('hex')
      let identity = await repos.auth.findIdentity('guest', subject)
      if (!identity) {
        const user = await createUniqueUser()
        await repos.auth.createIdentity({ userId: user.id, provider: 'guest', subject, secretHash: hashSecret(deviceKey) })
        identity = { id: '', userId: user.id, provider: 'guest', subject, secretHash: null, user }
      }
      const t = await issue(identity.userId, identity.user.handle)
      return { ...t, user: publicUser(identity.user) }
    },

    async apple(identityToken, deviceKey) {
      const apple = await verifyApple(identityToken)
      let appleIdentity = await repos.auth.findIdentity('apple', apple.sub)
      if (!appleIdentity) {
        let userId: string
        let user: UserRecord
        if (deviceKey) {
          const subject = createHash('sha256').update(deviceKey).digest('hex')
          const guest = await repos.auth.findIdentity('guest', subject)
          if (guest) {
            userId = guest.userId
            user = guest.user
          } else {
            user = await createUniqueUser()
            userId = user.id
          }
        } else {
          user = await createUniqueUser()
          userId = user.id
        }
        await repos.auth.createIdentity({ userId, provider: 'apple', subject: apple.sub })
        appleIdentity = { id: '', userId, provider: 'apple', subject: apple.sub, secretHash: null, user }
      }
      const t = await issue(appleIdentity.userId, appleIdentity.user.handle)
      return { ...t, user: publicUser(appleIdentity.user) }
    },

    async refresh(refreshToken) {
      const { userId, newRaw } = await tokens.rotateRefreshToken(refreshToken)
      const user = await repos.users.findById(userId)
      if (!user) throw new Error('User not found')
      return {
        accessToken: tokens.signAccessToken({ sub: userId, handle: user.handle }),
        refreshToken: newRaw,
        user: publicUser(user),
      }
    },

    async logout(refreshToken) {
      await tokens.revokeRefreshToken(refreshToken)
    },

    async registerDevice(userId, apnsToken) {
      await repos.auth.upsertDevice(userId, apnsToken)
    },

    async deleteAccount(userId) {
      // Relations cascade in Postgres; the memory repo mirrors that in delete().
      await repos.users.delete(userId)
    },
  }
}
