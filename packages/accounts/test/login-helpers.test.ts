import { describe, expect, it } from 'vitest'
import {
  BreakGlassError,
  chooseLogin,
  cookieNames,
  csrfMatches,
  csrfTokenFor,
  devicePollOutcome,
  formatCookie,
  generateSessionToken,
  generateSigningKey,
  generateUserCode,
  isSessionToken,
  loginCandidates,
  normalizeUserCode,
  parseBreakGlassPublicKey,
  parseCookies,
  safeReturnTo,
  signBreakGlassToken,
  verifyBreakGlassToken,
} from '../src/index.ts'

describe('sessions and CSRF', () => {
  it('derives a CSRF token only the session holder can compute', async () => {
    const token = generateSessionToken()
    expect(isSessionToken(token)).toBe(true)
    const csrf = await csrfTokenFor(token)
    expect(await csrfMatches(token, csrf)).toBe(true)
    expect(await csrfMatches(generateSessionToken(), csrf)).toBe(false)
    expect(await csrfMatches(token, '')).toBe(false)
    expect(await csrfMatches(token, null)).toBe(false)
  })

  it('formats secure, HttpOnly, SameSite=Lax cookies', () => {
    expect(cookieNames(true).session).toBe('__Host-gf_session')
    expect(formatCookie('__Host-gf_session', 'v', { secure: true, maxAgeSeconds: 60 })).toBe('__Host-gf_session=v; Path=/; Max-Age=60; HttpOnly; SameSite=Lax; Secure')
    expect(formatCookie('gf_session', 'v', { secure: false, maxAgeSeconds: 60 })).not.toContain('Secure')
    expect(parseCookies('a=1; gf_session=x=y; a=2')).toEqual(new Map([['a', '1'], ['gf_session', 'x=y']]))
  })

  it('only returns to local paths', () => {
    expect(safeReturnTo('/acme/site?tab=1')).toBe('/acme/site?tab=1')
    for (const value of ['//evil.example', 'https://evil.example', '/\\evil.example', 'relative', '', null]) expect(safeReturnTo(value)).toBe('/')
  })
})

describe('device flow', () => {
  it('generates and normalizes user codes', () => {
    const code = generateUserCode()
    expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/)
    expect(normalizeUserCode(code.toLowerCase().replace('-', ' '))).toBe(code)
    expect(normalizeUserCode('AAAA-BBBB')).toBeNull()
    expect(normalizeUserCode('BCDF')).toBeNull()
  })

  it('decides poll outcomes', () => {
    const base = { status: 'pending' as const, expiresAt: 10_000, intervalSeconds: 5, lastPolledAt: null }
    expect(devicePollOutcome(base, 0)).toEqual({ kind: 'authorization_pending' })
    expect(devicePollOutcome({ ...base, lastPolledAt: 0 }, 1000)).toEqual({ kind: 'slow_down', intervalSeconds: 10 })
    expect(devicePollOutcome({ ...base, status: 'approved', lastPolledAt: 0 }, 6000)).toEqual({ kind: 'approved' })
    expect(devicePollOutcome({ ...base, status: 'denied' }, 0)).toEqual({ kind: 'access_denied' })
    expect(devicePollOutcome({ ...base, status: 'consumed' }, 0)).toEqual({ kind: 'expired_token' })
    expect(devicePollOutcome(base, 10_000)).toEqual({ kind: 'expired_token' })
  })
})

describe('login names', () => {
  it('derives logins from OIDC claims and avoids taken ones', async () => {
    expect(loginCandidates({ preferredUsername: 'jörg.müller@dorf.example', email: null, name: null })).toEqual(['jorg-muller', 'user'])
    expect(loginCandidates({ preferredUsername: null, email: 'anna@x.example', name: 'Anna B' })).toEqual(['anna', 'Anna-B', 'user'])
    const taken = new Set(['anna', 'Anna-B', 'user', 'anna-2'])
    expect(await chooseLogin(['anna', 'Anna-B', 'user'], async (login) => taken.has(login))).toBe('anna-3')
  })
})

describe('break-glass tokens', () => {
  it('verifies offline-signed tokens for this instance only', async () => {
    const { privateJwk } = await generateSigningKey()
    const publicKey = parseBreakGlassPublicKey(JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: privateJwk.x }))
    const token = await signBreakGlassToken({ privateJwk, audience: 'https://forge.example', login: 'root' })
    expect(await verifyBreakGlassToken(token, { publicKey, audience: 'https://forge.example' })).toMatchObject({ login: 'root' })
    await expect(verifyBreakGlassToken(token, { publicKey, audience: 'https://other.example' })).rejects.toThrow(/another instance/)
    await expect(verifyBreakGlassToken(token, { publicKey, audience: 'https://forge.example', now: Date.now() + 3_600_000 })).rejects.toThrow(/expired/)
    const other = await generateSigningKey()
    const forged = await signBreakGlassToken({ privateJwk: other.privateJwk, audience: 'https://forge.example', login: 'root' })
    await expect(verifyBreakGlassToken(forged, { publicKey, audience: 'https://forge.example' })).rejects.toThrow(BreakGlassError)
    expect(() => parseBreakGlassPublicKey(JSON.stringify(privateJwk))).toThrow(BreakGlassError)
    await expect(signBreakGlassToken({ privateJwk, audience: 'https://forge.example', login: 'root', ttlSeconds: 3600 })).rejects.toThrow(BreakGlassError)
  })
})
