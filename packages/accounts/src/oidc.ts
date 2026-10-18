import { base64UrlEncode, fromUtf8, randomBytes, sha256 } from './encoding.ts'
import { isJwsAlgorithm, type JwsAlgorithm, parseVerificationJwk, parseCompactJws, type VerificationJwk, verifyCompactJws } from './jose.ts'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export class OidcError extends Error {}

export type OidcClientConfig = {
  readonly issuer: string
  readonly clientId: string
  readonly clientSecret?: string | undefined
  readonly scopes: readonly string[]
  readonly name: string
}

export type OidcMetadata = {
  readonly issuer: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly jwksUri: string
  readonly userinfoEndpoint: string | null
  readonly algorithms: readonly JwsAlgorithm[]
}

export const DEFAULT_OIDC_SCOPES = ['openid', 'profile', 'email'] as const

export const OIDC_CLOCK_SKEW_SECONDS = 60

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

export const isAllowedOidcUrl = (value: string): boolean => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.username || url.password || url.hash) return false
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname))
}

export const normalizeOidcIssuer = (value: string): string => {
  if (!isAllowedOidcUrl(value)) throw new OidcError(`OIDC issuer must be an https URL (http only for loopback): ${value}`)
  const url = new URL(value)
  if (url.search) throw new OidcError('OIDC issuer must not carry a query')
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

const requireUrl = (document: Record<string, unknown>, key: string): string => {
  const value = document[key]
  if (typeof value !== 'string' || !isAllowedOidcUrl(value)) throw new OidcError(`OIDC discovery document lacks a usable ${key}`)
  return value
}

export const parseOidcMetadata = (issuer: string, document: unknown): OidcMetadata => {
  if (typeof document !== 'object' || document === null) throw new OidcError('OIDC discovery document must be an object')
  const value = document as Record<string, unknown>
  if (value.issuer !== issuer) throw new OidcError(`OIDC discovery issuer ${String(value.issuer)} does not match ${issuer}`)
  const offered = Array.isArray(value.id_token_signing_alg_values_supported) ? value.id_token_signing_alg_values_supported.filter(isJwsAlgorithm) : ['RS256' as const]
  if (offered.length === 0) throw new OidcError('the OIDC provider signs ID tokens with none of RS256, ES256, EdDSA')
  const methods = value.code_challenge_methods_supported
  if (Array.isArray(methods) && !methods.includes('S256')) throw new OidcError('the OIDC provider does not support PKCE with S256')
  return {
    issuer,
    authorizationEndpoint: requireUrl(value, 'authorization_endpoint'),
    tokenEndpoint: requireUrl(value, 'token_endpoint'),
    jwksUri: requireUrl(value, 'jwks_uri'),
    userinfoEndpoint: typeof value.userinfo_endpoint === 'string' && isAllowedOidcUrl(value.userinfo_endpoint) ? value.userinfo_endpoint : null,
    algorithms: offered,
  }
}

const getJson = async (fetch: FetchLike, url: string): Promise<unknown> => {
  const response = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new OidcError(`GET ${url} answered ${response.status}`)
  try {
    return await response.json()
  } catch {
    throw new OidcError(`GET ${url} did not return JSON`)
  }
}

export const discoverOidc = async (issuer: string, fetch: FetchLike): Promise<OidcMetadata> =>
  parseOidcMetadata(issuer, await getJson(fetch, `${issuer}/.well-known/openid-configuration`))

export const parseJwks = (document: unknown): VerificationJwk[] => {
  const keys = typeof document === 'object' && document !== null ? (document as Record<string, unknown>).keys : undefined
  if (!Array.isArray(keys)) throw new OidcError('JWKS document lacks keys')
  return keys.map(parseVerificationJwk).filter((key): key is VerificationJwk => key !== null)
}

export type Pkce = {
  readonly verifier: string
  readonly challenge: string
}

export const pkceChallenge = async (verifier: string): Promise<string> => base64UrlEncode(await sha256(verifier))

export const createPkce = async (): Promise<Pkce> => {
  const verifier = base64UrlEncode(randomBytes(32))
  return { verifier, challenge: await pkceChallenge(verifier) }
}

export type AuthorizationRequest = {
  readonly metadata: OidcMetadata
  readonly client: OidcClientConfig
  readonly redirectUri: string
  readonly state: string
  readonly nonce: string
  readonly codeChallenge: string
}

export const authorizationUrl = (request: AuthorizationRequest): string => {
  const url = new URL(request.metadata.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', request.client.clientId)
  url.searchParams.set('redirect_uri', request.redirectUri)
  url.searchParams.set('scope', [...new Set(['openid', ...request.client.scopes])].join(' '))
  url.searchParams.set('state', request.state)
  url.searchParams.set('nonce', request.nonce)
  url.searchParams.set('code_challenge', request.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

const basicCredentials = (id: string, secret: string): string => {
  const encode = (value: string) => encodeURIComponent(value).replace(/%20/g, '+')
  const bytes = new TextEncoder().encode(`${encode(id)}:${encode(secret)}`)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `Basic ${btoa(binary)}`
}

export type TokenExchange = {
  readonly metadata: OidcMetadata
  readonly client: OidcClientConfig
  readonly code: string
  readonly redirectUri: string
  readonly codeVerifier: string
}

export type TokenResponse = {
  readonly idToken: string
  readonly accessToken: string | null
}

export const exchangeAuthorizationCode = async (exchange: TokenExchange, fetch: FetchLike): Promise<TokenResponse> => {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: exchange.code, redirect_uri: exchange.redirectUri, code_verifier: exchange.codeVerifier })
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
  if (exchange.client.clientSecret) headers.Authorization = basicCredentials(exchange.client.clientId, exchange.client.clientSecret)
  else body.set('client_id', exchange.client.clientId)
  const response = await fetch(exchange.metadata.tokenEndpoint, { method: 'POST', headers, body: body.toString() })
  let document: unknown
  try {
    document = await response.json()
  } catch {
    throw new OidcError(`token endpoint answered ${response.status} without JSON`)
  }
  const value = (typeof document === 'object' && document !== null ? document : {}) as Record<string, unknown>
  if (!response.ok) throw new OidcError(`token endpoint answered ${response.status}: ${String(value.error ?? 'error')}`)
  if (typeof value.id_token !== 'string') throw new OidcError('token response lacks an id_token')
  return { idToken: value.id_token, accessToken: typeof value.access_token === 'string' ? value.access_token : null }
}

export type IdTokenClaims = {
  readonly iss: string
  readonly sub: string
  readonly aud: readonly string[]
  readonly exp: number
  readonly iat: number
  readonly nonce: string | null
  readonly email: string | null
  readonly emailVerified: boolean
  readonly preferredUsername: string | null
  readonly name: string | null
}

export type IdTokenExpectations = {
  readonly issuer: string
  readonly clientId: string
  readonly nonce: string
  readonly algorithms?: readonly JwsAlgorithm[]
  readonly now?: number
  readonly clockSkewSeconds?: number
}

const optionalString = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

export const parseIdTokenClaims = (payload: Uint8Array): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(fromUtf8(payload))
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {}
  throw new OidcError('ID token payload is not a JSON object')
}

export const checkIdTokenClaims = (claims: Record<string, unknown>, expected: IdTokenExpectations): IdTokenClaims => {
  const now = Math.floor((expected.now ?? Date.now()) / 1000)
  const skew = expected.clockSkewSeconds ?? OIDC_CLOCK_SKEW_SECONDS
  if (claims.iss !== expected.issuer) throw new OidcError('ID token issuer does not match')
  if (typeof claims.sub !== 'string' || claims.sub === '' || claims.sub.length > 255) throw new OidcError('ID token lacks a subject')
  const aud = typeof claims.aud === 'string' ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud.filter((item): item is string => typeof item === 'string') : []
  if (!aud.includes(expected.clientId)) throw new OidcError('ID token is not for this client')
  if (aud.length > 1 && claims.azp !== expected.clientId) throw new OidcError('ID token azp does not name this client')
  if (claims.azp !== undefined && claims.azp !== expected.clientId) throw new OidcError('ID token azp does not name this client')
  if (typeof claims.exp !== 'number' || claims.exp + skew <= now) throw new OidcError('ID token has expired')
  if (typeof claims.iat !== 'number' || claims.iat - skew > now) throw new OidcError('ID token was issued in the future')
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf - skew > now)) throw new OidcError('ID token is not valid yet')
  if (claims.nonce !== expected.nonce) throw new OidcError('ID token nonce does not match')
  return {
    iss: claims.iss as string,
    sub: claims.sub,
    aud,
    exp: claims.exp,
    iat: claims.iat,
    nonce: optionalString(claims.nonce),
    email: optionalString(claims.email),
    emailVerified: claims.email_verified === true,
    preferredUsername: optionalString(claims.preferred_username),
    name: optionalString(claims.name),
  }
}

export const verifyIdToken = async (token: string, keys: readonly VerificationJwk[], expected: IdTokenExpectations): Promise<IdTokenClaims> => {
  const unverified = parseCompactJws(token)
  if (!unverified) throw new OidcError('ID token is not a compact JWS')
  const alg = unverified.header.alg
  if (!isJwsAlgorithm(alg) || !(expected.algorithms ?? ['RS256', 'ES256', 'EdDSA']).includes(alg)) throw new OidcError(`ID token algorithm ${String(alg)} is not accepted`)
  const verified = await verifyCompactJws(token, keys)
  if (!verified) throw new OidcError('ID token signature does not verify')
  return checkIdTokenClaims(parseIdTokenClaims(verified.payload), expected)
}

export const needsUserinfo = (claims: IdTokenClaims): boolean => claims.preferredUsername === null && claims.email === null && claims.name === null

export const mergeUserinfo = (claims: IdTokenClaims, userinfo: unknown): IdTokenClaims => {
  if (typeof userinfo !== 'object' || userinfo === null) throw new OidcError('userinfo is not a JSON object')
  const value = userinfo as Record<string, unknown>
  if (value.sub !== claims.sub) throw new OidcError('userinfo is about another subject')
  return {
    ...claims,
    email: claims.email ?? optionalString(value.email),
    emailVerified: claims.email ? claims.emailVerified : value.email_verified === true,
    preferredUsername: claims.preferredUsername ?? optionalString(value.preferred_username),
    name: claims.name ?? optionalString(value.name),
  }
}

export const fetchUserinfo = async (metadata: OidcMetadata, accessToken: string, fetch: FetchLike): Promise<unknown> => {
  if (!metadata.userinfoEndpoint) throw new OidcError('the provider has no userinfo endpoint')
  const response = await fetch(metadata.userinfoEndpoint, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } })
  if (!response.ok) throw new OidcError(`userinfo answered ${response.status}`)
  try {
    return await response.json()
  } catch {
    throw new OidcError('userinfo did not return JSON')
  }
}

export type OidcProvider = {
  readonly config: OidcClientConfig
  readonly metadata: () => Promise<OidcMetadata>
  readonly keys: (refresh: boolean) => Promise<VerificationJwk[]>
}

export const OIDC_CACHE_MS = 10 * 60 * 1000

export const OIDC_KEY_REFRESH_MS = 60 * 1000

export const createOidcProvider = (config: OidcClientConfig, fetch: FetchLike, now: () => number = Date.now): OidcProvider => {
  let metadata: { value: Promise<OidcMetadata>; at: number } | null = null
  let keys: { value: Promise<VerificationJwk[]>; at: number } | null = null
  const loadMetadata = () => {
    if (!metadata || now() - metadata.at > OIDC_CACHE_MS) {
      const value = discoverOidc(config.issuer, fetch)
      metadata = { value, at: now() }
      value.catch(() => {
        metadata = null
      })
    }
    return metadata.value
  }
  return {
    config,
    metadata: loadMetadata,
    keys: async (refresh) => {
      const stale = !keys || now() - keys.at > OIDC_CACHE_MS || (refresh && now() - keys.at > OIDC_KEY_REFRESH_MS)
      if (stale) {
        const uri = (await loadMetadata()).jwksUri
        const value = getJson(fetch, uri).then(parseJwks)
        keys = { value, at: now() }
        value.catch(() => {
          keys = null
        })
      }
      return keys!.value
    },
  }
}

export const verifyIdTokenWith = async (provider: OidcProvider, token: string, expected: Omit<IdTokenExpectations, 'issuer' | 'clientId' | 'algorithms'>): Promise<IdTokenClaims> => {
  const metadata = await provider.metadata()
  const options = { ...expected, issuer: metadata.issuer, clientId: provider.config.clientId, algorithms: metadata.algorithms }
  try {
    return await verifyIdToken(token, await provider.keys(false), options)
  } catch (error) {
    if (!(error instanceof OidcError) || error.message !== 'ID token signature does not verify') throw error
    return verifyIdToken(token, await provider.keys(true), options)
  }
}
