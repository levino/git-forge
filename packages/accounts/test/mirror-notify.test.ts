import { describe, expect, it } from 'vitest'
import {
  authorizeSubscription,
  base64UrlDecode,
  base64UrlEncode,
  createJwksCache,
  fromUtf8,
  generateSigningKey,
  handleWellKnownRequest,
  type InstancePrincipal,
  isMirrorOf,
  MAX_NOTIFIED_REFS,
  mintInstanceToken,
  mintMirrorNotification,
  notifiedRefs,
  parseUpstreamUrl,
  type TrustedIssuer,
  utf8,
  validateCallback,
  verifyInstanceToken,
  verifyMirrorNotification,
} from '../src/index.ts'

const UPSTREAM = 'https://alpha.example'
const MIRROR = 'https://beta.example'
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0)
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

const setup = async (trusted = true) => {
  const { key } = await generateSigningKey()
  const network = (async (input: RequestInfo | URL) =>
    (new URL(String(input)).origin === UPSTREAM ? handleWellKnownRequest(new Request(String(input)), { issuer: UPSTREAM, keys: [key.publicJwk] }) : null) ??
    new Response('not found', { status: 404 })) as typeof fetch
  const jwks = createJwksCache({ fetch: network, now: () => NOW })
  const trust = async (issuer: string): Promise<TrustedIssuer | null> => (trusted && issuer === UPSTREAM ? { issuer, pinnedThumbprint: null } : null)
  const options = { audience: MIRROR, trust, jwks, now: NOW }
  const mint = (refs: Record<string, string> = { 'refs/heads/main': A }) =>
    mintMirrorNotification({ key, issuer: UPSTREAM, audience: MIRROR, repository: 'Village/Archive', refs, now: NOW })
  return { key, options, mint }
}

describe('mirror notifications', () => {
  it('carry the repository and its ref state, but no content', async () => {
    const { options, mint } = await setup()
    const result = await verifyMirrorNotification(await mint({ 'refs/heads/main': A, 'refs/tags/v1': B, 'refs/archive/x/heads/main': B }), options)
    expect(result).toEqual({
      ok: true,
      notification: expect.objectContaining({ issuer: UPSTREAM, repository: 'village/archive', refs: { 'refs/heads/main': A, 'refs/tags/v1': B } }),
    })
  })

  it('omit the refs when there are too many', () => {
    const many = Object.fromEntries(Array.from({ length: MAX_NOTIFIED_REFS + 1 }, (_, i) => [`refs/tags/t${i}`, A]))
    expect(notifiedRefs(many)).toBeNull()
  })

  it('are rejected from untrusted issuers, for other audiences and when tampered with', async () => {
    const untrusted = await setup(false)
    expect(await verifyMirrorNotification(await untrusted.mint(), untrusted.options)).toEqual({ ok: false, reason: 'unknown-issuer', detail: UPSTREAM })
    const { options, mint } = await setup()
    expect(await verifyMirrorNotification(await mint(), { ...options, audience: 'https://gamma.example' })).toMatchObject({ ok: false, reason: 'wrong-audience' })
    const [header, payload, signature] = (await mint()).split('.') as [string, string, string]
    const claims = JSON.parse(fromUtf8(base64UrlDecode(payload))) as Record<string, unknown>
    claims.refs = { 'refs/heads/main': B }
    expect(await verifyMirrorNotification(`${header}.${base64UrlEncode(utf8(JSON.stringify(claims)))}.${signature}`, options)).toMatchObject({
      ok: false,
      reason: 'bad-signature',
    })
    expect(await verifyMirrorNotification(await mint(), { ...options, now: NOW + 3600_000 })).toMatchObject({ ok: false, reason: 'expired' })
  })

  it('are not access tokens and access tokens are not notifications', async () => {
    const { key, options, mint } = await setup()
    expect(await verifyInstanceToken(await mint(), options)).toMatchObject({ ok: false, reason: 'invalid-subject' })
    const access = await mintInstanceToken({ key, issuer: UPSTREAM, audience: MIRROR, repositories: ['village/archive'], now: NOW })
    expect(await verifyMirrorNotification(access, options)).toMatchObject({ ok: false, reason: 'invalid-subject' })
  })
})

describe('mirror subscriptions', () => {
  const principal: InstancePrincipal = { kind: 'instance', issuer: MIRROR, repositories: ['village/archive'], scopes: ['git:read', 'lfs:read'], tokenId: 'x' }

  it('accept only callbacks below the subscribing issuer', () => {
    expect(authorizeSubscription(principal, 'village/archive', `${MIRROR}/api/federation/notify/backup/archive/origin`)).toBeNull()
    expect(authorizeSubscription(principal, 'village/archive', 'https://victim.example/hook')).toMatch(/below the issuer/)
    expect(validateCallback(MIRROR, 'https://beta.example.evil/hook')).toMatch(/below the issuer/)
    expect(validateCallback(MIRROR, 'https://user:pw@beta.example/hook')).toMatch(/credentials/)
  })

  it('require the repository in the verified token', () => {
    expect(authorizeSubscription(principal, 'village/other', `${MIRROR}/hook`)).toMatch(/does not name/)
    expect(authorizeSubscription({ ...principal, scopes: ['lfs:read'] }, 'village/archive', `${MIRROR}/hook`)).toMatch(/git:read/)
  })

  it('match mirror configurations to the notifying upstream', () => {
    expect(isMirrorOf('https://alpha.example/village/archive.git', UPSTREAM, 'village/archive')).toBe(true)
    expect(isMirrorOf('https://alpha.example/Village/Archive/', UPSTREAM, 'village/archive')).toBe(true)
    expect(isMirrorOf('https://alpha.example.evil/village/archive.git', UPSTREAM, 'village/archive')).toBe(false)
    expect(parseUpstreamUrl('https://alpha.example/forge/village/archive.git')).toEqual({ issuer: 'https://alpha.example/forge', repository: 'village/archive' })
    expect(() => parseUpstreamUrl('https://alpha.example/village/archive.git', 'https://other.example')).toThrow(/not below/)
  })
})
