import { base64UrlDecode, decodeJwt, utf8 } from '@git-forge/accounts'

export type RunnerPublicKey = {
  readonly n: string
  readonly e: string
}

export type RsaParameters = {
  readonly d: string
  readonly dp: string
  readonly dq: string
  readonly exponent: string
  readonly inverseQ: string
  readonly modulus: string
  readonly p: string
  readonly q: string
}

export type RunnerKey = {
  readonly publicKey: RunnerPublicKey
  readonly rsaParameters: RsaParameters
}

const toBase64 = (base64Url: string): string => {
  let binary = ''
  for (const byte of base64UrlDecode(base64Url)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const required = (jwk: JsonWebKey, name: keyof JsonWebKey): string => {
  const value = jwk[name]
  if (typeof value !== 'string') throw new Error(`exported RSA key lacks ${name}`)
  return value
}

export const generateRunnerKey = async (): Promise<RunnerKey> => {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey
  return {
    publicKey: { n: required(jwk, 'n'), e: required(jwk, 'e') },
    rsaParameters: {
      d: toBase64(required(jwk, 'd')),
      dp: toBase64(required(jwk, 'dp')),
      dq: toBase64(required(jwk, 'dq')),
      exponent: toBase64(required(jwk, 'e')),
      inverseQ: toBase64(required(jwk, 'qi')),
      modulus: toBase64(required(jwk, 'n')),
      p: toBase64(required(jwk, 'p')),
      q: toBase64(required(jwk, 'q')),
    },
  }
}

const ALGORITHMS = {
  RS256: { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verify: { name: 'RSASSA-PKCS1-v1_5' } },
  PS256: { import: { name: 'RSA-PSS', hash: 'SHA-256' }, verify: { name: 'RSA-PSS', saltLength: 32 } },
} as const

export type AssertionCheck = {
  readonly clientId: string
  readonly audience: string
  readonly now: number
}

const CLOCK_SKEW_SECONDS = 300

export const verifyClientAssertion = async (assertion: string, publicKey: RunnerPublicKey, check: AssertionCheck): Promise<boolean> => {
  const jwt = decodeJwt(assertion)
  if (!jwt) return false
  const algorithm = ALGORITHMS[jwt.header.alg as keyof typeof ALGORITHMS]
  if (!algorithm) return false
  const { iss, sub, aud, exp, nbf } = jwt.payload
  const audiences = Array.isArray(aud) ? aud : [aud]
  const seconds = Math.floor(check.now / 1000)
  if (iss !== check.clientId || sub !== check.clientId) return false
  if (!audiences.includes(check.audience)) return false
  if (typeof exp !== 'number' || exp + CLOCK_SKEW_SECONDS < seconds) return false
  if (typeof nbf === 'number' && nbf - CLOCK_SKEW_SECONDS > seconds) return false
  const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: publicKey.n, e: publicKey.e, ext: true }, algorithm.import, false, ['verify'])
  return crypto.subtle.verify(algorithm.verify, key, jwt.signature, utf8(jwt.signingInput))
}
