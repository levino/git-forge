import { describe, expect, it } from 'vitest'
import {
  base64UrlDecode,
  base64UrlEncode,
  createJwksCache,
  decodeJwt,
  fromUtf8,
  generateSigningKey,
  handleWellKnownRequest,
  importSigningKey,
  jwkThumbprint,
  mintInstanceToken,
  normalizeIssuer,
  type PublicJwk,
  type SigningKey,
  signJwt,
  type TrustedIssuer,
  utf8,
  verifyInstanceToken,
} from '../src/index.ts'

const SOURCE = 'https://a.example'
const BACKUP = 'https://b.example'
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0)

type Instance = { issuer: string; published: PublicJwk[]; fetches: string[] }

const network = (instances: readonly Instance[]): typeof fetch =>
  (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    const instance = instances.find((candidate) => new URL(candidate.issuer).origin === url.origin)
    instance?.fetches.push(url.pathname)
    const response = instance ? handleWellKnownRequest(new Request(url), { issuer: instance.issuer, keys: instance.published }) : null
    return response ?? new Response('not found', { status: 404 })
  }) as typeof fetch

const setup = async (options: { pin?: 'own' | 'other'; trusted?: boolean } = {}) => {
  const { key } = await generateSigningKey()
  const pinned =
    options.pin === 'own' ? await jwkThumbprint(key.publicJwk) : options.pin === 'other' ? await jwkThumbprint((await generateSigningKey()).key.publicJwk) : null
  const backup: Instance = { issuer: BACKUP, published: [key.publicJwk], fetches: [] }
  let clock = NOW
  const jwks = createJwksCache({ fetch: network([backup]), now: () => clock, cacheSeconds: 300, minRefreshSeconds: 30 })
  const trust = async (issuer: string): Promise<TrustedIssuer | null> =>
    issuer === BACKUP && options.trusted !== false ? { issuer, pinnedThumbprint: pinned } : null
  const verify = (token: string, at = clock) => verifyInstanceToken(token, { audience: SOURCE, trust, jwks, now: at })
  const mint = (overrides: Partial<Parameters<typeof mintInstanceToken>[0]> = {}) =>
    mintInstanceToken({ key, issuer: BACKUP, audience: SOURCE, repositories: ['village/archive'], now: clock, ...overrides })
  return { key, backup, verify, mint, advance: (ms: number) => (clock += ms) }
}

const tamper = (token: string, change: (claims: Record<string, unknown>) => void): string => {
  const [header, payload, signature] = token.split('.') as [string, string, string]
  const claims = JSON.parse(fromUtf8(base64UrlDecode(payload))) as Record<string, unknown>
  change(claims)
  return `${header}.${base64UrlEncode(utf8(JSON.stringify(claims)))}.${signature}`
}

describe('instance tokens', () => {
  it('mints short-lived EdDSA JWTs with the expected claims', async () => {
    const { mint, key } = await setup()
    const token = await mint()
    const decoded = decodeJwt(token)!
    expect(decoded.header).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: key.kid })
    expect(decoded.payload).toMatchObject({ iss: BACKUP, aud: SOURCE, sub: 'instance', repositories: ['village/archive'], scope: 'git:read lfs:read' })
    expect((decoded.payload.exp as number) - (decoded.payload.iat as number)).toBe(300)
    await expect(mint({ ttlSeconds: 301 })).rejects.toThrow(/ttlSeconds/)
    await expect(mint({ repositories: [] })).rejects.toThrow(/repository/)
    await expect(mint({ repositories: ['not a repo'] })).rejects.toThrow(/invalid repository/)
  })

  it('verifies a valid token and maps it to an instance principal', async () => {
    const { mint, verify } = await setup()
    const result = await verify(await mint({ repositories: ['Village/Archive'] }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.principal).toMatchObject({ kind: 'instance', issuer: BACKUP, repositories: ['village/archive'], scopes: ['git:read', 'lfs:read'] })
  })

  it('rejects a token for another audience', async () => {
    const { mint, verify } = await setup()
    expect(await verify(await mint({ audience: 'https://c.example' }))).toMatchObject({ ok: false, reason: 'wrong-audience' })
  })

  it('rejects expired and not-yet-valid tokens, allowing small clock skew', async () => {
    const { mint, verify } = await setup()
    const token = await mint({ ttlSeconds: 60 })
    expect((await verify(token, NOW + 60_000 + 29_000)).ok).toBe(true)
    expect(await verify(token, NOW + 60_000 + 30_000)).toMatchObject({ ok: false, reason: 'expired' })
    expect(await verify(token, NOW - 31_000)).toMatchObject({ ok: false, reason: 'not-yet-valid' })
  })

  it('rejects unknown issuers without touching the network', async () => {
    const { mint, verify, backup } = await setup({ trusted: false })
    expect(await verify(await mint())).toMatchObject({ ok: false, reason: 'unknown-issuer' })
    expect(backup.fetches).toEqual([])
  })

  it('rejects tampered, unsigned and overlong tokens', async () => {
    const { mint, verify, key } = await setup()
    const token = await mint()
    expect(await verify(tamper(token, (claims) => (claims.repositories = ['village/secret'])))).toMatchObject({ ok: false, reason: 'bad-signature' })
    const [, payload] = token.split('.')
    const none = `${base64UrlEncode(utf8(JSON.stringify({ alg: 'none', kid: key.kid })))}.${payload}.`
    expect((await verify(none)).ok).toBe(false)
    const hs = `${base64UrlEncode(utf8(JSON.stringify({ alg: 'HS256', kid: key.kid })))}.${payload}.c2ln`
    expect(await verify(hs)).toMatchObject({ ok: false, reason: 'unsupported-algorithm' })
    const long = await signJwt(key, { iss: BACKUP, aud: SOURCE, sub: 'instance', iat: NOW / 1000, nbf: NOW / 1000, exp: NOW / 1000 + 3600, jti: 'x', repositories: ['village/archive'], scope: 'git:read' })
    expect(await verify(long)).toMatchObject({ ok: false, reason: 'lifetime-too-long' })
    const user = await signJwt(key, { iss: BACKUP, aud: SOURCE, sub: 'alice', iat: NOW / 1000, exp: NOW / 1000 + 60, jti: 'x', repositories: [], scope: '' })
    expect(await verify(user)).toMatchObject({ ok: false, reason: 'invalid-subject' })
    expect(await verify('garbage')).toMatchObject({ ok: false, reason: 'malformed' })
  })

  it('rejects tokens signed by a key the issuer does not publish', async () => {
    const { verify } = await setup()
    const { key: rogue } = await generateSigningKey()
    const token = await mintInstanceToken({ key: rogue, issuer: BACKUP, audience: SOURCE, repositories: ['village/archive'], now: NOW })
    expect(await verify(token)).toMatchObject({ ok: false, reason: 'unknown-key' })
  })

  it('caches the JWKS and picks up rotated keys', async () => {
    const { mint, verify, backup, advance } = await setup()
    expect((await verify(await mint())).ok).toBe(true)
    expect((await verify(await mint())).ok).toBe(true)
    expect(backup.fetches).toEqual(['/.well-known/openid-configuration', '/.well-known/jwks.json'])
    const { key: next } = await generateSigningKey()
    backup.published.push(next.publicJwk)
    advance(31_000)
    const rotated = await mintInstanceToken({ key: next, issuer: BACKUP, audience: SOURCE, repositories: ['village/archive'], now: NOW + 31_000 })
    expect((await verify(rotated)).ok).toBe(true)
    expect(backup.fetches).toHaveLength(4)
    expect((await verify(await mint({ now: NOW + 31_000 }))).ok).toBe(true)
    backup.published.shift()
    advance(301_000)
    const old = await mint({ now: NOW + 332_000 })
    expect(await verify(old)).toMatchObject({ ok: false, reason: 'unknown-key' })
    expect((await verify(await mintInstanceToken({ key: next, issuer: BACKUP, audience: SOURCE, repositories: ['village/archive'], now: NOW + 332_000 }))).ok).toBe(true)
  })

  it('limits refetches for unknown key ids', async () => {
    const { verify, backup } = await setup()
    const { key: rogue } = await generateSigningKey()
    for (let i = 0; i < 5; i++) {
      await verify(await mintInstanceToken({ key: rogue, issuer: BACKUP, audience: SOURCE, repositories: ['village/archive'], now: NOW }))
    }
    expect(backup.fetches).toHaveLength(2)
  })

  it('enforces a pinned key thumbprint', async () => {
    const other = await setup({ pin: 'other' })
    expect(await other.verify(await other.mint())).toMatchObject({ ok: false, reason: 'pinned-key-mismatch' })
    const own = await setup({ pin: 'own' })
    expect((await own.verify(await own.mint())).ok).toBe(true)
  })

  it('reports an unreachable or misconfigured issuer', async () => {
    const { key } = await generateSigningKey()
    const trust = async (issuer: string) => ({ issuer, pinnedThumbprint: null })
    const token = await mintInstanceToken({ key, issuer: BACKUP, audience: SOURCE, repositories: ['village/archive'], now: NOW })
    const offline = createJwksCache({ fetch: (async () => new Response('down', { status: 503 })) as typeof fetch })
    expect(await verifyInstanceToken(token, { audience: SOURCE, trust, jwks: offline, now: NOW })).toMatchObject({ ok: false, reason: 'jwks-unavailable' })
    const crossOrigin = createJwksCache({
      fetch: (async () => Response.json({ issuer: BACKUP, jwks_uri: 'https://evil.example/jwks.json' })) as unknown as typeof fetch,
    })
    expect(await verifyInstanceToken(token, { audience: SOURCE, trust, jwks: crossOrigin, now: NOW })).toMatchObject({
      ok: false,
      reason: 'jwks-unavailable',
      detail: expect.stringMatching(/different origin/),
    })
    const redirects: RequestInit[] = []
    const redirecting = createJwksCache({
      fetch: (async (_input: string, init: RequestInit) => {
        redirects.push(init)
        return new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } })
      }) as unknown as typeof fetch,
    })
    expect(await verifyInstanceToken(token, { audience: SOURCE, trust, jwks: redirecting, now: NOW })).toMatchObject({
      ok: false,
      reason: 'jwks-unavailable',
      detail: expect.stringMatching(/redirects/),
    })
    expect(redirects[0]?.redirect).toBe('manual')
    const plainHttp = 'http://b.example'
    const insecure = await mintInstanceToken({ key, issuer: plainHttp, audience: SOURCE, repositories: ['village/archive'], now: NOW })
    expect(await verifyInstanceToken(insecure, { audience: SOURCE, trust, jwks: createJwksCache({ fetch: network([]) }), now: NOW })).toMatchObject({
      ok: false,
      reason: 'jwks-unavailable',
      detail: expect.stringMatching(/without TLS/),
    })
  })
})

describe('instance keys and discovery', () => {
  it('round-trips a private JWK and derives the kid from the RFC 7638 thumbprint', async () => {
    const { key, privateJwk } = await generateSigningKey()
    const imported: SigningKey = await importSigningKey(privateJwk)
    expect(imported.kid).toBe(key.kid)
    expect(key.kid).toBe(await jwkThumbprint(key.publicJwk))
    expect(key.publicJwk).not.toHaveProperty('d')
  })

  it('matches the RFC 8037 test vector thumbprint', async () => {
    expect(await jwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' })).toBe(
      'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k',
    )
  })

  it('serves discovery documents under the issuer path', async () => {
    const { key } = await generateSigningKey()
    const issuer = 'https://forge.example/instance/'
    const config = handleWellKnownRequest(new Request('https://forge.example/instance/.well-known/openid-configuration'), { issuer, keys: [key.publicJwk] })
    expect(await config?.json()).toMatchObject({ issuer: 'https://forge.example/instance', jwks_uri: 'https://forge.example/instance/.well-known/jwks.json' })
    const jwks = handleWellKnownRequest(new Request('https://forge.example/instance/.well-known/jwks.json'), { issuer, keys: [key.publicJwk] })
    expect(await jwks?.json()).toEqual({ keys: [key.publicJwk] })
    expect(handleWellKnownRequest(new Request('https://forge.example/.well-known/jwks.json'), { issuer, keys: [] })).toBeNull()
    expect(normalizeIssuer('https://B.example:443/')).toBe('https://b.example')
    expect(() => normalizeIssuer('ftp://b.example')).toThrow()
  })
})
