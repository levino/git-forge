import { randomId } from './encoding.ts'
import { normalizeIssuer } from './federation.ts'
import { type OkpPublicJwk, parseVerificationJwk, verifyCompactJws } from './jose.ts'
import { importSigningKey, type PrivateJwk, signJwt } from './jwt.ts'
import { parseIdTokenClaims } from './oidc.ts'

export const BREAK_GLASS_PURPOSE = 'git-forge-break-glass'

export const MAX_BREAK_GLASS_TOKEN_SECONDS = 10 * 60

export class BreakGlassError extends Error {}

export const parseBreakGlassPublicKey = (text: string): OkpPublicJwk => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new BreakGlassError('BREAK_GLASS_PUBLIC_KEY must be an Ed25519 public JWK in JSON')
  }
  const jwk = parseVerificationJwk(value)
  if (!jwk || jwk.kty !== 'OKP') throw new BreakGlassError('BREAK_GLASS_PUBLIC_KEY must be an Ed25519 public JWK without "d"')
  return { kty: 'OKP', crv: 'Ed25519', x: jwk.x }
}

export type BreakGlassClaims = {
  readonly login: string
  readonly jti: string
  readonly exp: number
}

export type SignBreakGlassOptions = {
  readonly privateJwk: PrivateJwk
  readonly audience: string
  readonly login: string
  readonly ttlSeconds?: number
  readonly now?: number
}

export const signBreakGlassToken = async (options: SignBreakGlassOptions): Promise<string> => {
  const ttl = options.ttlSeconds ?? 5 * 60
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_BREAK_GLASS_TOKEN_SECONDS) {
    throw new BreakGlassError(`ttlSeconds must be between 1 and ${MAX_BREAK_GLASS_TOKEN_SECONDS}`)
  }
  const iat = Math.floor((options.now ?? Date.now()) / 1000)
  return signJwt(await importSigningKey(options.privateJwk), {
    purpose: BREAK_GLASS_PURPOSE,
    aud: normalizeIssuer(options.audience),
    sub: options.login,
    iat,
    exp: iat + ttl,
    jti: randomId(),
  })
}

export type VerifyBreakGlassOptions = {
  readonly publicKey: OkpPublicJwk
  readonly audience: string
  readonly now?: number
}

export const verifyBreakGlassToken = async (token: string, options: VerifyBreakGlassOptions): Promise<BreakGlassClaims> => {
  const verified = await verifyCompactJws(token.trim(), [options.publicKey])
  if (!verified || verified.header.alg !== 'EdDSA') throw new BreakGlassError('the break-glass token is not signed by the configured key')
  const claims = parseIdTokenClaims(verified.payload)
  const now = Math.floor((options.now ?? Date.now()) / 1000)
  if (claims.purpose !== BREAK_GLASS_PURPOSE) throw new BreakGlassError('not a break-glass token')
  if (claims.aud !== normalizeIssuer(options.audience)) throw new BreakGlassError('the break-glass token is for another instance')
  if (typeof claims.sub !== 'string' || claims.sub === '') throw new BreakGlassError('the break-glass token names no login')
  if (typeof claims.jti !== 'string' || claims.jti === '') throw new BreakGlassError('the break-glass token lacks a jti')
  if (typeof claims.iat !== 'number' || typeof claims.exp !== 'number') throw new BreakGlassError('the break-glass token lacks iat or exp')
  if (claims.exp - claims.iat > MAX_BREAK_GLASS_TOKEN_SECONDS) throw new BreakGlassError('the break-glass token lives too long')
  if (claims.exp <= now) throw new BreakGlassError('the break-glass token has expired')
  if (claims.iat - 60 > now) throw new BreakGlassError('the break-glass token was issued in the future')
  return { login: claims.sub, jti: claims.jti, exp: claims.exp }
}
