import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { AppleVerifier } from './auth.js'

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys'
const APPLE_ISSUER = 'https://appleid.apple.com'

/** Real Sign-in-with-Apple identity-token verifier. Injected into AuthService. */
export function createAppleVerifier(bundleId: string): AppleVerifier {
  const jwks = createRemoteJWKSet(new URL(APPLE_JWKS_URL))
  return async (identityToken: string) => {
    const { payload } = await jwtVerify(identityToken, jwks, { issuer: APPLE_ISSUER, audience: bundleId })
    if (!payload.sub) throw new Error('Missing sub in Apple token')
    return { sub: payload.sub, email: payload.email as string | undefined }
  }
}
