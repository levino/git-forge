import { describe, expect, it } from 'vitest'
import {
  authorizationUrl,
  checkIdTokenClaims,
  createOidcProvider,
  createPkce,
  exchangeAuthorizationCode,
  isAllowedOidcUrl,
  normalizeOidcIssuer,
  OidcError,
  parseJwks,
  parseOidcMetadata,
  pkceChallenge,
  verifyIdToken,
  verifyIdTokenWith,
} from '../src/index.ts'
import { createMockOidc, type MockOidcAlgorithm } from './support/mock-oidc.ts'

const fetchFrom = (handle: (request: Request) => Promise<Response>) => (input: string, init?: RequestInit) => handle(new Request(input, init))

const claims = (overrides: Record<string, unknown> = {}) => {
  const now = Math.floor(Date.now() / 1000)
  return { iss: 'https://id.example', sub: 'user-1', aud: 'forge-client', iat: now, exp: now + 300, nonce: 'n-1', ...overrides }
}

const expected = { issuer: 'https://id.example', clientId: 'forge-client', nonce: 'n-1' }

describe('PKCE', () => {
  it('matches RFC 7636 appendix B', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
    const pkce = await createPkce()
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await pkceChallenge(pkce.verifier)).toBe(pkce.challenge)
  })
})

describe('OIDC configuration', () => {
  it('accepts https issuers and http only on loopback', () => {
    expect(normalizeOidcIssuer('https://dorf-id.example/')).toBe('https://dorf-id.example')
    expect(isAllowedOidcUrl('http://127.0.0.1:8080/x')).toBe(true)
    expect(() => normalizeOidcIssuer('http://id.example')).toThrow(OidcError)
    expect(() => normalizeOidcIssuer('https://id.example/?tenant=1')).toThrow(OidcError)
  })

  it('validates the discovery document', () => {
    const document = { issuer: 'https://id.example', authorization_endpoint: 'https://id.example/a', token_endpoint: 'https://id.example/t', jwks_uri: 'https://id.example/k' }
    expect(parseOidcMetadata('https://id.example', document).algorithms).toEqual(['RS256'])
    expect(() => parseOidcMetadata('https://other.example', document)).toThrow(/does not match/)
    expect(() => parseOidcMetadata('https://id.example', { ...document, token_endpoint: 'http://id.example/t' })).toThrow(/token_endpoint/)
    expect(() => parseOidcMetadata('https://id.example', { ...document, id_token_signing_alg_values_supported: ['HS256'] })).toThrow(/RS256/)
    expect(() => parseOidcMetadata('https://id.example', { ...document, code_challenge_methods_supported: ['plain'] })).toThrow(/PKCE/)
  })

  it('builds the authorization URL with PKCE, state and nonce', () => {
    const metadata = parseOidcMetadata('https://id.example', {
      issuer: 'https://id.example',
      authorization_endpoint: 'https://id.example/oauth/v2/authorize?prompt=login',
      token_endpoint: 'https://id.example/t',
      jwks_uri: 'https://id.example/k',
    })
    const url = new URL(
      authorizationUrl({
        metadata,
        client: { issuer: 'https://id.example', clientId: 'c', scopes: ['profile', 'email'], name: 'Dorf-ID' },
        redirectUri: 'https://forge.example/login/oidc/callback',
        state: 's',
        nonce: 'n',
        codeChallenge: 'ch',
      }),
    )
    expect(Object.fromEntries(url.searchParams)).toEqual({
      prompt: 'login',
      response_type: 'code',
      client_id: 'c',
      redirect_uri: 'https://forge.example/login/oidc/callback',
      scope: 'openid profile email',
      state: 's',
      nonce: 'n',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    })
  })
})

describe('ID token verification', () => {
  for (const alg of ['RS256', 'ES256', 'EdDSA'] as MockOidcAlgorithm[]) {
    it(`verifies ${alg} ID tokens against the JWKS`, async () => {
      const mock = await createMockOidc({ alg })
      const keys = parseJwks(await (await mock.handle(new Request('https://id.example/jwks'))).json())
      const verified = await verifyIdToken(await mock.sign(claims({ email: 'a@example.org', email_verified: true })), keys, expected)
      expect(verified).toMatchObject({ sub: 'user-1', email: 'a@example.org', emailVerified: true })
      const other = await createMockOidc({ alg })
      await expect(verifyIdToken(await other.sign(claims()), keys, expected)).rejects.toThrow(/signature/)
      await expect(verifyIdToken(await mock.sign(claims()), keys, { ...expected, algorithms: alg === 'RS256' ? ['ES256'] : ['RS256'] })).rejects.toThrow(/not accepted/)
    })
  }

  it('checks issuer, audience, azp, expiry, issue time and nonce', () => {
    expect(checkIdTokenClaims(claims(), expected).aud).toEqual(['forge-client'])
    expect(() => checkIdTokenClaims(claims({ iss: 'https://evil.example' }), expected)).toThrow(/issuer/)
    expect(() => checkIdTokenClaims(claims({ aud: 'other' }), expected)).toThrow(/client/)
    expect(() => checkIdTokenClaims(claims({ aud: ['forge-client', 'other'] }), expected)).toThrow(/azp/)
    expect(checkIdTokenClaims(claims({ aud: ['forge-client', 'other'], azp: 'forge-client' }), expected).sub).toBe('user-1')
    expect(() => checkIdTokenClaims(claims({ exp: Math.floor(Date.now() / 1000) - 120 }), expected)).toThrow(/expired/)
    expect(() => checkIdTokenClaims(claims({ iat: Math.floor(Date.now() / 1000) + 600 }), expected)).toThrow(/future/)
    expect(() => checkIdTokenClaims(claims({ nonce: 'other' }), expected)).toThrow(/nonce/)
    expect(() => checkIdTokenClaims(claims({ sub: '' }), expected)).toThrow(/subject/)
    expect(checkIdTokenClaims(claims({ email: 'a@example.org' }), expected).emailVerified).toBe(false)
  })

  it('exchanges a code with PKCE and client secret and verifies the result', async () => {
    const mock = await createMockOidc()
    const fetch = fetchFrom(mock.handle)
    const provider = createOidcProvider({ issuer: mock.issuer, clientId: mock.clientId, clientSecret: mock.clientSecret, scopes: ['openid'], name: 'Mock' }, fetch)
    const metadata = await provider.metadata()
    const pkce = await createPkce()
    const authorize = await mock.handle(
      new Request(
        authorizationUrl({ metadata, client: provider.config, redirectUri: 'https://forge.example/cb', state: 's', nonce: 'n', codeChallenge: pkce.challenge }),
      ),
    )
    const code = new URL(authorize.headers.get('Location')!).searchParams.get('code')!
    const exchange = { metadata, client: provider.config, code, redirectUri: 'https://forge.example/cb', codeVerifier: 'wrong' }
    await expect(exchangeAuthorizationCode(exchange, fetch)).rejects.toThrow(/invalid_grant/)
    const authorizeAgain = await mock.handle(
      new Request(authorizationUrl({ metadata, client: provider.config, redirectUri: 'https://forge.example/cb', state: 's', nonce: 'n', codeChallenge: pkce.challenge })),
    )
    const idToken = await exchangeAuthorizationCode(
      { ...exchange, code: new URL(authorizeAgain.headers.get('Location')!).searchParams.get('code')!, codeVerifier: pkce.verifier },
      fetch,
    )
    expect((await verifyIdTokenWith(provider, idToken, { nonce: 'n' })).preferredUsername).toBe('alice')
    await expect(verifyIdTokenWith(provider, idToken, { nonce: 'other' })).rejects.toThrow(/nonce/)
  })
})
