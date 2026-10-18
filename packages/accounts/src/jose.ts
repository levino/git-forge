import { base64UrlDecode, fromUtf8, utf8 } from './encoding.ts'

export const JWS_ALGORITHMS = ['RS256', 'ES256', 'EdDSA'] as const

export type JwsAlgorithm = (typeof JWS_ALGORITHMS)[number]

export type RsaPublicJwk = { readonly kty: 'RSA'; readonly n: string; readonly e: string; readonly kid?: string; readonly alg?: string; readonly use?: string }

export type EcPublicJwk = { readonly kty: 'EC'; readonly crv: 'P-256'; readonly x: string; readonly y: string; readonly kid?: string; readonly alg?: string; readonly use?: string }

export type OkpPublicJwk = { readonly kty: 'OKP'; readonly crv: 'Ed25519'; readonly x: string; readonly kid?: string; readonly alg?: string; readonly use?: string }

export type VerificationJwk = RsaPublicJwk | EcPublicJwk | OkpPublicJwk

export const isJwsAlgorithm = (value: unknown): value is JwsAlgorithm => typeof value === 'string' && (JWS_ALGORITHMS as readonly string[]).includes(value)

const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

export const parseVerificationJwk = (value: unknown): VerificationJwk | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const jwk = value as Record<string, unknown>
  if ('d' in jwk) return null
  const extra = {
    ...(isString(jwk.kid) ? { kid: jwk.kid } : {}),
    ...(isString(jwk.alg) ? { alg: jwk.alg } : {}),
    ...(isString(jwk.use) ? { use: jwk.use } : {}),
  }
  if (jwk.kty === 'RSA' && isString(jwk.n) && isString(jwk.e)) return { kty: 'RSA', n: jwk.n, e: jwk.e, ...extra }
  if (jwk.kty === 'EC' && jwk.crv === 'P-256' && isString(jwk.x) && isString(jwk.y)) return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ...extra }
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519' && isString(jwk.x)) return { kty: 'OKP', crv: 'Ed25519', x: jwk.x, ...extra }
  return null
}

export const algorithmOf = (jwk: VerificationJwk): JwsAlgorithm => (jwk.kty === 'RSA' ? 'RS256' : jwk.kty === 'EC' ? 'ES256' : 'EdDSA')

export const keyMatchesAlgorithm = (jwk: VerificationJwk, alg: JwsAlgorithm): boolean =>
  algorithmOf(jwk) === alg && (jwk.alg === undefined || jwk.alg === alg) && (jwk.use === undefined || jwk.use === 'sig')

type ImportAlgorithm = Parameters<typeof crypto.subtle.importKey>[2]

type VerifyAlgorithm = Parameters<typeof crypto.subtle.verify>[0]

const importParameters = (jwk: VerificationJwk): { readonly key: JsonWebKey; readonly algorithm: ImportAlgorithm } => {
  switch (jwk.kty) {
    case 'RSA':
      return { key: { kty: 'RSA', n: jwk.n, e: jwk.e }, algorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } }
    case 'EC':
      return { key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, algorithm: { name: 'ECDSA', namedCurve: 'P-256' } }
    case 'OKP':
      return { key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, algorithm: { name: 'Ed25519' } }
  }
}

const verifyParameters = (jwk: VerificationJwk): VerifyAlgorithm =>
  jwk.kty === 'RSA' ? { name: 'RSASSA-PKCS1-v1_5' } : jwk.kty === 'EC' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'Ed25519' }

export const importVerificationKey = async (jwk: VerificationJwk): Promise<CryptoKey> => {
  const { key, algorithm } = importParameters(jwk)
  return crypto.subtle.importKey('jwk', key, algorithm, false, ['verify'])
}

export const verifySignature = async (jwk: VerificationJwk, signature: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>): Promise<boolean> => {
  if (jwk.kty === 'EC' && signature.length !== 64) return false
  try {
    return await crypto.subtle.verify(verifyParameters(jwk), await importVerificationKey(jwk), signature, data)
  } catch {
    return false
  }
}

export type CompactJws = {
  readonly header: Record<string, unknown>
  readonly payload: Uint8Array<ArrayBuffer>
  readonly signingInput: Uint8Array<ArrayBuffer>
  readonly signature: Uint8Array<ArrayBuffer>
}

const COMPACT = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)\.([A-Za-z0-9_-]+)$/

export const parseCompactJws = (token: string): CompactJws | null => {
  const match = COMPACT.exec(token)
  if (!match) return null
  try {
    const header: unknown = JSON.parse(fromUtf8(base64UrlDecode(match[1]!)))
    if (typeof header !== 'object' || header === null || Array.isArray(header)) return null
    return {
      header: header as Record<string, unknown>,
      payload: base64UrlDecode(match[2]!),
      signingInput: utf8(`${match[1]}.${match[2]}`),
      signature: base64UrlDecode(match[3]!),
    }
  } catch {
    return null
  }
}

export const verifyCompactJws = async (token: string, keys: readonly VerificationJwk[]): Promise<CompactJws | null> => {
  const jws = parseCompactJws(token)
  if (!jws || !isJwsAlgorithm(jws.header.alg)) return null
  if (jws.header.crit !== undefined) return null
  const alg = jws.header.alg
  const kid = typeof jws.header.kid === 'string' ? jws.header.kid : undefined
  const candidates = keys.filter((key) => keyMatchesAlgorithm(key, alg) && (kid === undefined || key.kid === undefined || key.kid === kid))
  for (const key of candidates) if (await verifySignature(key, jws.signature, jws.signingInput)) return jws
  return null
}

export const derToRawEcdsa = (der: Uint8Array, size = 32): Uint8Array<ArrayBuffer> => {
  const fail = () => {
    throw new SyntaxError('invalid DER ECDSA signature')
  }
  let offset = 0
  const byte = () => (offset < der.length ? der[offset++]! : fail())
  const length = () => {
    const first = byte()
    if (first < 0x80) return first
    if (first !== 0x81) return fail()
    return byte()
  }
  if (byte() !== 0x30) fail()
  const total = length()
  if (offset + total !== der.length) fail()
  const integer = (): Uint8Array => {
    if (byte() !== 0x02) fail()
    const size = length()
    if (size === 0 || offset + size > der.length) fail()
    const value = der.subarray(offset, offset + size)
    offset += size
    let start = 0
    while (start < value.length - 1 && value[start] === 0) start++
    return value.subarray(start)
  }
  const r = integer()
  const s = integer()
  if (offset !== der.length || r.length > size || s.length > size) fail()
  const raw = new Uint8Array(size * 2)
  raw.set(r, size - r.length)
  raw.set(s, size * 2 - s.length)
  return raw
}
