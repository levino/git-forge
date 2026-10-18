import { base64UrlEncode, pkceChallenge, utf8 } from '../../src/index.ts'

export type MockOidcAlgorithm = 'RS256' | 'ES256' | 'EdDSA'

export type MockUser = {
  readonly sub: string
  readonly preferred_username?: string
  readonly email?: string
  readonly email_verified?: boolean
  readonly name?: string
}

type PendingCode = { readonly challenge: string; readonly nonce: string; readonly redirectUri: string; readonly user: MockUser }

export type MockOidc = {
  issuer: string
  readonly clientId: string
  readonly clientSecret: string
  user: MockUser
  claimOverrides: Record<string, unknown>
  readonly handle: (request: Request) => Promise<Response>
  readonly sign: (claims: Record<string, unknown>) => Promise<string>
  readonly tokenRequests: number
}

const KEY_PARAMS: Record<MockOidcAlgorithm, { generate: RsaHashedKeyGenParams | EcKeyGenParams | Algorithm; sign: Algorithm | EcdsaParams }> = {
  RS256: {
    generate: { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    sign: { name: 'RSASSA-PKCS1-v1_5' },
  },
  ES256: { generate: { name: 'ECDSA', namedCurve: 'P-256' }, sign: { name: 'ECDSA', hash: 'SHA-256' } },
  EdDSA: { generate: { name: 'Ed25519' }, sign: { name: 'Ed25519' } },
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export const createMockOidc = async (options: { readonly issuer?: string; readonly alg?: MockOidcAlgorithm; readonly clientSecret?: string } = {}): Promise<MockOidc> => {
  const alg = options.alg ?? 'RS256'
  const pair = (await crypto.subtle.generateKey(KEY_PARAMS[alg].generate, true, ['sign', 'verify'])) as CryptoKeyPair
  const exported = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
  const kid = `mock-${alg.toLowerCase()}`
  const publicJwk = { ...Object.fromEntries(Object.entries(exported).filter(([key]) => ['kty', 'crv', 'x', 'y', 'n', 'e'].includes(key))), kid, alg, use: 'sig' }
  const codes = new Map<string, PendingCode>()
  let tokenRequests = 0

  const sign = async (claims: Record<string, unknown>): Promise<string> => {
    const input = `${base64UrlEncode(utf8(JSON.stringify({ alg, kid, typ: 'JWT' })))}.${base64UrlEncode(utf8(JSON.stringify(claims)))}`
    const signature = new Uint8Array(await crypto.subtle.sign(KEY_PARAMS[alg].sign, pair.privateKey, utf8(input)))
    return `${input}.${base64UrlEncode(signature)}`
  }

  const mock: MockOidc = {
    issuer: options.issuer ?? 'https://id.example',
    clientId: 'forge-client',
    clientSecret: options.clientSecret ?? 'forge-secret',
    user: { sub: 'user-1', preferred_username: 'alice', email: 'alice@example.org', email_verified: true, name: 'Alice' },
    claimOverrides: {},
    sign,
    get tokenRequests() {
      return tokenRequests
    },
    handle: async (request) => {
      const url = new URL(request.url)
      const path = url.pathname.slice(new URL(mock.issuer).pathname.replace(/\/$/, '').length)
      if (path === '/.well-known/openid-configuration') {
        return json({
          issuer: mock.issuer,
          authorization_endpoint: `${mock.issuer}/authorize`,
          token_endpoint: `${mock.issuer}/token`,
          jwks_uri: `${mock.issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: [alg],
          code_challenge_methods_supported: ['S256'],
        })
      }
      if (path === '/jwks') return json({ keys: [publicJwk] })
      if (path === '/authorize') {
        const params = url.searchParams
        if (params.get('client_id') !== mock.clientId || params.get('response_type') !== 'code' || params.get('code_challenge_method') !== 'S256') {
          return json({ error: 'invalid_request' }, 400)
        }
        if (!params.get('scope')?.split(' ').includes('openid')) return json({ error: 'invalid_scope' }, 400)
        const code = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)))
        codes.set(code, { challenge: params.get('code_challenge')!, nonce: params.get('nonce')!, redirectUri: params.get('redirect_uri')!, user: mock.user })
        const target = new URL(params.get('redirect_uri')!)
        target.searchParams.set('code', code)
        target.searchParams.set('state', params.get('state')!)
        return new Response(null, { status: 302, headers: { Location: target.toString() } })
      }
      if (path === '/token' && request.method === 'POST') {
        tokenRequests++
        const form = new URLSearchParams(await request.text())
        const basic = request.headers.get('Authorization')
        const authenticated = basic === `Basic ${btoa(`${mock.clientId}:${mock.clientSecret}`)}` || (mock.clientSecret === '' && form.get('client_id') === mock.clientId)
        if (!authenticated) return json({ error: 'invalid_client' }, 401)
        const pending = codes.get(form.get('code') ?? '')
        codes.delete(form.get('code') ?? '')
        if (!pending || form.get('grant_type') !== 'authorization_code' || form.get('redirect_uri') !== pending.redirectUri) return json({ error: 'invalid_grant' }, 400)
        if ((await pkceChallenge(form.get('code_verifier') ?? '')) !== pending.challenge) return json({ error: 'invalid_grant', error_description: 'PKCE' }, 400)
        const now = Math.floor(Date.now() / 1000)
        const idToken = await sign({ iss: mock.issuer, aud: mock.clientId, iat: now, exp: now + 300, nonce: pending.nonce, ...pending.user, ...mock.claimOverrides })
        return json({ access_token: 'mock-access', token_type: 'Bearer', expires_in: 300, id_token: idToken })
      }
      return json({ error: 'not_found' }, 404)
    },
  }
  return mock
}
