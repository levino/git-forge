import { describe, expect, it } from 'vitest'
import {
  createJwksCache,
  generateSigningKey,
  handleWellKnownRequest,
  type MirrorAttestation,
  mintMirrorAttestation,
  signJwt,
  type TrustedIssuer,
  verifyMirrorAttestation,
} from '../src/index.ts'

const MIRROR = 'https://beta.example'
const UPSTREAM = 'https://alpha.example'
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0)

const claims: MirrorAttestation = {
  repository: 'Village/Archive',
  checksum: 'c'.repeat(40),
  refs: 3,
  namespace: '',
  syncedAt: '2026-10-18T11:59:00.000Z',
  alarms: 0,
  pending: 1,
  deepCheck: { at: '2026-10-01T00:00:00.000Z', ok: true },
  url: `${MIRROR}/village/archive.git`,
}

const setup = async () => {
  const { key } = await generateSigningKey()
  const network = (async (input: RequestInfo | URL) =>
    (new URL(String(input)).origin === MIRROR ? handleWellKnownRequest(new Request(String(input)), { issuer: MIRROR, keys: [key.publicJwk] }) : null) ??
    new Response('not found', { status: 404 })) as typeof fetch
  const trust = async (issuer: string): Promise<TrustedIssuer | null> => (issuer === MIRROR ? { issuer, pinnedThumbprint: null } : null)
  return { key, options: { audience: UPSTREAM, trust, jwks: createJwksCache({ fetch: network, now: () => NOW }), now: NOW } }
}

describe('mirror attestations', () => {
  it('round-trip the signed ref state of a mirror', async () => {
    const { key, options } = await setup()
    const token = await mintMirrorAttestation({ key, issuer: MIRROR, audience: UPSTREAM, attestation: claims, now: NOW })
    const result = await verifyMirrorAttestation(token, options)
    expect(result).toEqual({ ok: true, attestation: { ...claims, repository: 'village/archive', issuer: MIRROR, id: expect.any(String), keyThumbprint: key.kid } })
  })

  it('reject wrong audiences, invalid claims and unsigned forgeries', async () => {
    const { key, options } = await setup()
    const token = await mintMirrorAttestation({ key, issuer: MIRROR, audience: 'https://other.example', attestation: claims, now: NOW })
    expect(await verifyMirrorAttestation(token, options)).toMatchObject({ ok: false, reason: 'wrong-audience' })
    await expect(mintMirrorAttestation({ key, issuer: MIRROR, audience: UPSTREAM, attestation: { ...claims, checksum: 'nope' } })).rejects.toThrow(/checksum/)
    await expect(mintMirrorAttestation({ key, issuer: MIRROR, audience: UPSTREAM, attestation: { ...claims, namespace: 'heads/' } })).rejects.toThrow(/namespace/)
    await expect(mintMirrorAttestation({ key, issuer: MIRROR, audience: UPSTREAM, attestation: { ...claims, url: 'https://u:p@beta.example/x.git' } })).rejects.toThrow(/url/)
    const iat = Math.floor(NOW / 1000)
    const raw = await signJwt(key, { iss: MIRROR, aud: UPSTREAM, sub: 'mirror-attestation', iat, exp: iat + 60, jti: 'x', repository: 'village/archive', checksum: 'c'.repeat(40), refs: -1, namespace: '', synced_at: claims.syncedAt, alarms: 0, pending: 0 })
    expect(await verifyMirrorAttestation(raw, options)).toMatchObject({ ok: false, reason: 'invalid-claims', detail: 'counts' })
    const other = (await generateSigningKey()).key
    const forged = await mintMirrorAttestation({ key: { ...other, kid: key.kid }, issuer: MIRROR, audience: UPSTREAM, attestation: claims, now: NOW })
    expect(await verifyMirrorAttestation(forged, options)).toMatchObject({ ok: false, reason: 'bad-signature' })
  })
})
