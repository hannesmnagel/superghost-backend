import { createRemoteJWKSet, jwtVerify } from 'jose'
import { config } from '../config.js'

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys'
const APPLE_ISSUER = 'https://appleid.apple.com'

const jwks = createRemoteJWKSet(new URL(APPLE_JWKS_URL))

export interface AppleTokenPayload {
  sub: string
  email?: string
}

export async function verifyAppleToken(identityToken: string): Promise<AppleTokenPayload> {
  const { payload } = await jwtVerify(identityToken, jwks, {
    issuer: APPLE_ISSUER,
    audience: config.APPLE_BUNDLE_ID,
  })
  if (!payload.sub) throw new Error('Missing sub in Apple token')
  return { sub: payload.sub, email: payload.email as string | undefined }
}
