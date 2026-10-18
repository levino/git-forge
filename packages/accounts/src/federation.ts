import { randomId } from './encoding.ts'
import { decodeJwt, isPublicJwk, jwkThumbprint, type PublicJwk, type SigningKey, signJwt, verifyJwtSignature } from './jwt.ts'
import type { InstancePrincipal } from './permissions.ts'

export const INSTANCE_SUBJECT = 'instance'

export const MAX_INSTANCE_TOKEN_SECONDS = 300

export const DEFAULT_CLOCK_SKEW_SECONDS = 30

export const INSTANCE_SCOPES = ['git:read', 'lfs:read'] as const

export type InstanceScope = (typeof INSTANCE_SCOPES)[number]

export const OPENID_CONFIGURATION_PATH = '/.well-known/openid-configuration'

export const JWKS_PATH = '/.well-known/jwks.json'

export const REPOSITORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

export class FederationError extends Error {}

export const normalizeIssuer = (value: string): string => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new FederationError(`invalid issuer ${value}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new FederationError(`issuer must be an http(s) URL: ${value}`)
  if (url.search || url.hash || url.username || url.password) throw new FederationError(`issuer must not carry query, fragment or credentials: ${value}`)
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

export type InstanceTokenClaims = {
  readonly iss: string
  readonly aud: string
  readonly sub: typeof INSTANCE_SUBJECT
  readonly iat: number
  readonly nbf: number
  readonly exp: number
  readonly jti: string
  readonly repositories: readonly string[]
  readonly scope: string
}

export type MintInstanceTokenOptions = {
  readonly key: SigningKey
  readonly issuer: string
  readonly audience: string
  readonly repositories: readonly string[]
  readonly scopes?: readonly InstanceScope[]
  readonly ttlSeconds?: number
  readonly now?: number
}

export const mintInstanceToken = async (options: MintInstanceTokenOptions): Promise<string> => {
  const ttl = options.ttlSeconds ?? MAX_INSTANCE_TOKEN_SECONDS
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_INSTANCE_TOKEN_SECONDS) {
    throw new FederationError(`ttlSeconds must be an integer between 1 and ${MAX_INSTANCE_TOKEN_SECONDS}`)
  }
  if (options.repositories.length === 0) throw new FederationError('at least one repository is required')
  for (const repository of options.repositories) {
    if (!REPOSITORY_NAME.test(repository)) throw new FederationError(`invalid repository ${repository}`)
  }
  const scopes = options.scopes ?? INSTANCE_SCOPES
  for (const scope of scopes) if (!INSTANCE_SCOPES.includes(scope)) throw new FederationError(`unknown scope ${scope}`)
  const iat = Math.floor((options.now ?? Date.now()) / 1000)
  const claims: InstanceTokenClaims = {
    iss: normalizeIssuer(options.issuer),
    aud: normalizeIssuer(options.audience),
    sub: INSTANCE_SUBJECT,
    iat,
    nbf: iat,
    exp: iat + ttl,
    jti: randomId(),
    repositories: options.repositories.map((repository) => repository.toLowerCase()),
    scope: [...new Set(scopes)].join(' '),
  }
  return signJwt(options.key, claims)
}

export const openidConfiguration = (issuer: string) => {
  const iss = normalizeIssuer(issuer)
  return {
    issuer: iss,
    jwks_uri: `${iss}${JWKS_PATH}`,
    subject_types_supported: ['public'],
    response_types_supported: ['id_token'],
    id_token_signing_alg_values_supported: ['EdDSA'],
    claims_supported: ['iss', 'aud', 'sub', 'iat', 'nbf', 'exp', 'jti', 'repositories', 'scope'],
    scopes_supported: [...INSTANCE_SCOPES],
  }
}

export const jwksDocument = (keys: readonly PublicJwk[]) => ({ keys: keys.map((key) => ({ ...key })) })

export type WellKnownOptions = {
  readonly issuer: string
  readonly keys: readonly PublicJwk[]
  readonly cacheSeconds?: number
}

const json = (body: unknown, cacheSeconds: number) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${cacheSeconds}`, 'Access-Control-Allow-Origin': '*' },
  })

export const handleWellKnownRequest = (request: Request, options: WellKnownOptions): Response | null => {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null
  const base = new URL(normalizeIssuer(options.issuer)).pathname.replace(/\/+$/, '')
  const path = new URL(request.url).pathname
  const cacheSeconds = options.cacheSeconds ?? 300
  if (path === `${base}${OPENID_CONFIGURATION_PATH}`) return json(openidConfiguration(options.issuer), cacheSeconds)
  if (path === `${base}${JWKS_PATH}`) return json(jwksDocument(options.keys), cacheSeconds)
  return null
}

export type TrustedIssuer = {
  readonly issuer: string
  readonly pinnedThumbprint: string | null
}

export type TrustLookup = (issuer: string) => Promise<TrustedIssuer | null>

export interface JwksSource {
  keys(issuer: string, options?: { readonly refresh?: boolean }): Promise<readonly PublicJwk[]>
}

export type JwksCacheOptions = {
  readonly fetch?: typeof fetch
  readonly cacheSeconds?: number
  readonly minRefreshSeconds?: number
  readonly maxDocumentBytes?: number
  readonly allowInsecureHttp?: boolean
  readonly now?: () => number
}

type CacheEntry = {
  readonly keys: readonly PublicJwk[]
  readonly fetchedAt: number
}

const readLimited = async (response: Response, limit: number): Promise<unknown> => {
  if (!response.body) throw new FederationError('empty response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > limit) {
      await reader.cancel()
      throw new FederationError('document too large')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

export const createJwksCache = (options: JwksCacheOptions = {}): JwksSource => {
  const fetcher = options.fetch ?? ((input, init) => fetch(input, init))
  const now = options.now ?? Date.now
  const cacheMs = (options.cacheSeconds ?? 300) * 1000
  const minRefreshMs = (options.minRefreshSeconds ?? 30) * 1000
  const limit = options.maxDocumentBytes ?? 64 * 1024
  const cache = new Map<string, CacheEntry>()
  const pending = new Map<string, Promise<CacheEntry>>()

  const requireScheme = (url: URL) => {
    if (url.protocol === 'https:') return
    if (url.protocol === 'http:' && options.allowInsecureHttp) return
    throw new FederationError(`refusing to fetch ${url.href} without TLS`)
  }

  const getJson = async (url: URL): Promise<unknown> => {
    requireScheme(url)
    const response = await fetcher(url.href, { headers: { Accept: 'application/json' }, redirect: 'error' })
    if (!response.ok) throw new FederationError(`${url.href} answered ${response.status}`)
    return readLimited(response, limit)
  }

  const load = async (issuer: string): Promise<CacheEntry> => {
    const discovery = (await getJson(new URL(`${issuer}${OPENID_CONFIGURATION_PATH}`))) as Record<string, unknown> | null
    if (typeof discovery !== 'object' || discovery === null || discovery.issuer !== issuer || typeof discovery.jwks_uri !== 'string') {
      throw new FederationError(`invalid discovery document for ${issuer}`)
    }
    const jwksUri = new URL(discovery.jwks_uri)
    if (jwksUri.origin !== new URL(issuer).origin) throw new FederationError(`jwks_uri of ${issuer} is on a different origin`)
    const document = (await getJson(jwksUri)) as { keys?: unknown } | null
    if (typeof document !== 'object' || document === null || !Array.isArray(document.keys)) {
      throw new FederationError(`invalid JWKS for ${issuer}`)
    }
    return { keys: document.keys.filter(isPublicJwk), fetchedAt: now() }
  }

  const fetchOnce = (issuer: string): Promise<CacheEntry> => {
    const running = pending.get(issuer)
    if (running) return running
    const promise = load(issuer)
      .then((entry) => {
        cache.set(issuer, entry)
        return entry
      })
      .finally(() => pending.delete(issuer))
    pending.set(issuer, promise)
    return promise
  }

  return {
    keys: async (issuer, request = {}) => {
      const cached = cache.get(issuer)
      const age = cached ? now() - cached.fetchedAt : Infinity
      if (cached && age < cacheMs && !(request.refresh && age >= minRefreshMs)) return cached.keys
      return (await fetchOnce(issuer)).keys
    },
  }
}

export type VerifyFailure =
  | 'malformed'
  | 'unsupported-algorithm'
  | 'unknown-issuer'
  | 'wrong-audience'
  | 'invalid-subject'
  | 'invalid-claims'
  | 'expired'
  | 'not-yet-valid'
  | 'lifetime-too-long'
  | 'jwks-unavailable'
  | 'unknown-key'
  | 'pinned-key-mismatch'
  | 'bad-signature'

export type VerifyResult =
  | { readonly ok: true; readonly claims: InstanceTokenClaims; readonly principal: InstancePrincipal; readonly keyThumbprint: string }
  | { readonly ok: false; readonly reason: VerifyFailure; readonly detail?: string }

export type VerifyInstanceTokenOptions = {
  readonly audience: string
  readonly trust: TrustLookup
  readonly jwks: JwksSource
  readonly now?: number
  readonly clockSkewSeconds?: number
}

const fail = (reason: VerifyFailure, detail?: string): VerifyResult => (detail === undefined ? { ok: false, reason } : { ok: false, reason, detail })

const isNumericDate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const audienceMatches = (aud: unknown, audience: string): boolean => {
  const values = Array.isArray(aud) ? aud : [aud]
  return values.some((value) => {
    if (typeof value !== 'string') return false
    try {
      return normalizeIssuer(value) === audience
    } catch {
      return false
    }
  })
}

const verifySignature = async (jwk: PublicJwk, jwt: NonNullable<ReturnType<typeof decodeJwt>>): Promise<boolean> => {
  try {
    return await verifyJwtSignature(jwk, jwt)
  } catch {
    return false
  }
}

export type VerifiedFederationToken = {
  readonly issuer: string
  readonly payload: Record<string, unknown>
  readonly iat: number
  readonly nbf: number
  readonly exp: number
  readonly jti: string
  readonly keyThumbprint: string
}

export type FederationTokenCheck =
  | { readonly ok: true; readonly token: VerifiedFederationToken }
  | { readonly ok: false; readonly reason: VerifyFailure; readonly detail?: string }

const failed = (reason: VerifyFailure, detail?: string): FederationTokenCheck => (detail === undefined ? { ok: false, reason } : { ok: false, reason, detail })

export const verifyFederationToken = async (
  token: string,
  options: VerifyInstanceTokenOptions,
  subject: string,
  validate: (payload: Record<string, unknown>) => string | null,
): Promise<FederationTokenCheck> => {
  const jwt = decodeJwt(token)
  if (!jwt) return failed('malformed')
  if (jwt.header.alg !== 'EdDSA') return failed('unsupported-algorithm', jwt.header.alg)
  if (jwt.header.typ !== undefined && jwt.header.typ !== 'JWT') return failed('malformed', 'typ')
  const kid = jwt.header.kid
  if (typeof kid !== 'string') return failed('malformed', 'kid')
  const claims = jwt.payload
  if (typeof claims.iss !== 'string') return failed('malformed', 'iss')
  let issuer: string
  try {
    issuer = normalizeIssuer(claims.iss)
  } catch {
    return failed('unknown-issuer', claims.iss)
  }
  if (issuer !== claims.iss) return failed('unknown-issuer', claims.iss)
  const trusted = await options.trust(issuer)
  if (!trusted) return failed('unknown-issuer', issuer)
  if (!audienceMatches(claims.aud, normalizeIssuer(options.audience))) return failed('wrong-audience')
  if (claims.sub !== subject) return failed('invalid-subject')
  const { iat, nbf, exp, jti } = claims
  if (!isNumericDate(iat) || !isNumericDate(exp) || (nbf !== undefined && !isNumericDate(nbf))) return failed('invalid-claims', 'time')
  if (typeof jti !== 'string') return failed('invalid-claims', 'jti')
  const invalid = validate(claims)
  if (invalid !== null) return failed('invalid-claims', invalid)
  const now = (options.now ?? Date.now()) / 1000
  const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS
  const notBefore = nbf ?? iat
  if (now >= exp + skew) return failed('expired')
  if (notBefore > now + skew || iat > now + skew) return failed('not-yet-valid')
  if (exp - Math.min(notBefore, iat) > MAX_INSTANCE_TOKEN_SECONDS) return failed('lifetime-too-long')
  let keys: readonly PublicJwk[]
  let jwk: PublicJwk | undefined
  try {
    keys = await options.jwks.keys(issuer)
    jwk = keys.find((key) => key.kid === kid)
    if (!jwk) {
      keys = await options.jwks.keys(issuer, { refresh: true })
      jwk = keys.find((key) => key.kid === kid)
    }
  } catch (error) {
    return failed('jwks-unavailable', String((error as Error)?.message ?? error))
  }
  if (!jwk) return failed('unknown-key', kid)
  const keyThumbprint = await jwkThumbprint(jwk)
  if (trusted.pinnedThumbprint !== null && trusted.pinnedThumbprint !== keyThumbprint) return failed('pinned-key-mismatch')
  if (!(await verifySignature(jwk, jwt))) return failed('bad-signature')
  return { ok: true, token: { issuer, payload: claims, iat, nbf: notBefore as number, exp, jti, keyThumbprint } }
}

const validateInstanceClaims = (claims: Record<string, unknown>): string | null => {
  if (typeof claims.scope !== 'string') return 'jti/scope'
  const { repositories } = claims
  if (!Array.isArray(repositories) || !repositories.every((name) => typeof name === 'string' && REPOSITORY_NAME.test(name))) return 'repositories'
  return null
}

export const verifyInstanceToken = async (token: string, options: VerifyInstanceTokenOptions): Promise<VerifyResult> => {
  const checked = await verifyFederationToken(token, options, INSTANCE_SUBJECT, validateInstanceClaims)
  if (!checked.ok) return fail(checked.reason, checked.detail)
  const { issuer, payload, iat, nbf, exp, jti, keyThumbprint } = checked.token
  const scope = payload.scope as string
  const verified: InstanceTokenClaims = {
    iss: issuer,
    aud: normalizeIssuer(options.audience),
    sub: INSTANCE_SUBJECT,
    iat,
    nbf,
    exp,
    jti,
    repositories: (payload.repositories as string[]).map((name) => name.toLowerCase()),
    scope,
  }
  return {
    ok: true,
    claims: verified,
    keyThumbprint,
    principal: { kind: 'instance', issuer, repositories: verified.repositories, scopes: scope.split(' ').filter((item) => item.length > 0), tokenId: jti },
  }
}

export const createInstanceVerifier =
  (options: Omit<VerifyInstanceTokenOptions, 'now'> & { readonly now?: () => number }) =>
  async (token: string): Promise<InstancePrincipal | null> => {
    const result = await verifyInstanceToken(token, { ...options, now: (options.now ?? Date.now)() })
    return result.ok ? result.principal : null
  }
