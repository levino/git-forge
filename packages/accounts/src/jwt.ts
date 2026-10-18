import { base64UrlDecode, base64UrlEncode, fromUtf8, sha256, utf8 } from './encoding.ts'

export type PublicJwk = {
  readonly kty: 'OKP'
  readonly crv: 'Ed25519'
  readonly x: string
  readonly kid: string
  readonly alg: 'EdDSA'
  readonly use: 'sig'
}

export type SigningKey = {
  readonly kid: string
  readonly privateKey: CryptoKey
  readonly publicJwk: PublicJwk
}

export type PrivateJwk = {
  readonly kty: 'OKP'
  readonly crv: 'Ed25519'
  readonly x: string
  readonly d: string
}

const ED25519 = { name: 'Ed25519' } as const

export const jwkThumbprint = async (jwk: { readonly crv: string; readonly kty: string; readonly x: string }): Promise<string> =>
  base64UrlEncode(await sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })))

const publicJwkOf = async (x: string): Promise<PublicJwk> => ({
  kty: 'OKP',
  crv: 'Ed25519',
  x,
  kid: await jwkThumbprint({ crv: 'Ed25519', kty: 'OKP', x }),
  alg: 'EdDSA',
  use: 'sig',
})

export const importSigningKey = async (jwk: PrivateJwk): Promise<SigningKey> => {
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.d !== 'string' || typeof jwk.x !== 'string') {
    throw new TypeError('expected an Ed25519 private JWK')
  }
  const privateKey = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d }, ED25519, false, ['sign'])
  const publicJwk = await publicJwkOf(jwk.x)
  return { kid: publicJwk.kid, privateKey, publicJwk }
}

export const generateSigningKey = async (): Promise<{ readonly key: SigningKey; readonly privateJwk: PrivateJwk }> => {
  const pair = (await crypto.subtle.generateKey(ED25519, true, ['sign', 'verify'])) as CryptoKeyPair
  const exported = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey
  const privateJwk: PrivateJwk = { kty: 'OKP', crv: 'Ed25519', x: exported.x!, d: exported.d! }
  return { key: await importSigningKey(privateJwk), privateJwk }
}

export const isPublicJwk = (value: unknown): value is PublicJwk => {
  if (typeof value !== 'object' || value === null) return false
  const jwk = value as Record<string, unknown>
  return jwk.kty === 'OKP' && jwk.crv === 'Ed25519' && typeof jwk.x === 'string' && typeof jwk.kid === 'string' && !('d' in jwk)
}

export type JwtHeader = {
  readonly alg: string
  readonly typ?: string
  readonly kid?: string
}

export type DecodedJwt = {
  readonly header: JwtHeader
  readonly payload: Record<string, unknown>
  readonly signingInput: string
  readonly signature: Uint8Array<ArrayBuffer>
}

const encodeSegment = (value: unknown): string => base64UrlEncode(utf8(JSON.stringify(value)))

export const signJwt = async (key: SigningKey, payload: Record<string, unknown>): Promise<string> => {
  const signingInput = `${encodeSegment({ alg: 'EdDSA', typ: 'JWT', kid: key.kid })}.${encodeSegment(payload)}`
  const signature = new Uint8Array(await crypto.subtle.sign(ED25519, key.privateKey, utf8(signingInput)))
  return `${signingInput}.${base64UrlEncode(signature)}`
}

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

export const looksLikeJwt = (value: string): boolean => JWT_SHAPE.test(value)

const parseObject = (segment: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(fromUtf8(base64UrlDecode(segment)))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export const decodeJwt = (token: string): DecodedJwt | null => {
  if (!looksLikeJwt(token)) return null
  const [headerSegment, payloadSegment, signatureSegment] = token.split('.') as [string, string, string]
  const header = parseObject(headerSegment)
  const payload = parseObject(payloadSegment)
  if (!header || !payload || typeof header.alg !== 'string') return null
  if (header.kid !== undefined && typeof header.kid !== 'string') return null
  try {
    return { header: header as JwtHeader, payload, signingInput: `${headerSegment}.${payloadSegment}`, signature: base64UrlDecode(signatureSegment) }
  } catch {
    return null
  }
}

export const verifyJwtSignature = async (jwk: PublicJwk, jwt: DecodedJwt): Promise<boolean> => {
  const key = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, ED25519, false, ['verify'])
  return crypto.subtle.verify(ED25519, key, jwt.signature, utf8(jwt.signingInput))
}
