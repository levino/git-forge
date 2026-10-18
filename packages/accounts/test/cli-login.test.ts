import { describe, expect, it } from 'vitest'
import {
  accessChoices,
  CLI_OOB_REDIRECT,
  cleanClientText,
  generateCliCode,
  generateCliRequestId,
  grantedScope,
  isCliRequestId,
  loginRateLimitFor,
  parseCliRedirect,
  parseRequestedScope,
  pkceChallenge,
  pkceMatches,
  slidingWindowDecision,
  windowStartOf,
} from '../src/index.ts'

describe('access choices', () => {
  it('offers cumulative levels up to a ceiling', () => {
    expect(accessChoices().map((choice) => choice.label)).toEqual(['read', 'write (includes read)', 'admin (includes write)'])
    expect(accessChoices('repo:write').map((choice) => choice.scope)).toEqual(['repo:read', 'repo:write'])
    expect(accessChoices('repo:read').map((choice) => choice.scope)).toEqual(['repo:read'])
  })

  it('parses requested scopes to their highest level and never grants more than requested', () => {
    expect(parseRequestedScope(null)).toBe('repo:write')
    expect(parseRequestedScope('repo:read repo:admin')).toBe('repo:admin')
    expect(parseRequestedScope('repo:root')).toBeNull()
    expect(grantedScope('repo:write', 'repo:admin')).toBe('repo:write')
    expect(grantedScope('repo:admin', 'repo:read')).toBe('repo:read')
    expect(grantedScope('repo:read', null)).toBe('repo:read')
    expect(grantedScope('repo:write', 'repo:root')).toBe('repo:write')
  })
})

describe('command line login', () => {
  it('accepts only loopback http redirects and the out-of-band marker', () => {
    expect(parseCliRedirect('http://127.0.0.1:4711/callback')).toEqual({ kind: 'loopback', uri: 'http://127.0.0.1:4711/callback' })
    expect(parseCliRedirect('http://[::1]:4711/cb')?.kind).toBe('loopback')
    expect(parseCliRedirect('http://localhost/cb')?.kind).toBe('loopback')
    expect(parseCliRedirect(CLI_OOB_REDIRECT)?.kind).toBe('oob')
    for (const bad of ['https://127.0.0.1/cb', 'http://127.0.0.2/cb', 'http://localhost.evil.example/cb', 'http://a:b@127.0.0.1/cb', 'http://127.0.0.1/cb#x', 'javascript:alert(1)', null]) {
      expect(parseCliRedirect(bad)).toBeNull()
    }
  })

  it('verifies PKCE S256 and generates short request ids and codes', async () => {
    const verifier = 'a'.repeat(43)
    const challenge = await pkceChallenge(verifier)
    expect(await pkceMatches(verifier, challenge)).toBe(true)
    expect(await pkceMatches('b'.repeat(43), challenge)).toBe(false)
    expect(await pkceMatches('short', await pkceChallenge('short'))).toBe(false)
    expect(isCliRequestId(generateCliRequestId())).toBe(true)
    expect(generateCliCode()).toMatch(/^gfc_[A-Za-z0-9_-]{32}$/)
  })

  it('strips control and format characters from client-reported text', () => {
    expect(cleanClientText('  my‮box\n\tname ', 'x')).toBe('my box name')
    expect(cleanClientText('', 'fallback')).toBe('fallback')
    expect(cleanClientText('x'.repeat(200), 'f')).toHaveLength(100)
  })
})

describe('rate limits', () => {
  const limit = { name: 't', limit: 10, windowMs: 1000 }

  it('weights the previous window by the part not yet elapsed', () => {
    expect(windowStartOf(2500, 1000)).toBe(2000)
    expect(slidingWindowDecision(limit, { previous: 10, current: 1 }, 2000).allowed).toBe(false)
    expect(slidingWindowDecision(limit, { previous: 10, current: 5 }, 2500)).toMatchObject({ allowed: true, estimate: 10 })
    const blocked = slidingWindowDecision(limit, { previous: 10, current: 6 }, 2500)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSeconds).toBe(1)
    expect(slidingWindowDecision(limit, { previous: 0, current: 11 }, 2100).retryAfterSeconds).toBe(1)
  })

  it('maps login and device endpoints to limits', () => {
    const none = new URLSearchParams()
    expect(loginRateLimitFor('POST', '/login/device/code', none)?.name).toBe('device-code')
    expect(loginRateLimitFor('POST', '/login/cli/start', none)?.name).toBe('device-code')
    expect(loginRateLimitFor('POST', '/login/cli/token', none)?.name).toBe('token')
    expect(loginRateLimitFor('POST', '/login/passkey', none)?.name).toBe('login')
    expect(loginRateLimitFor('POST', '/login/break-glass', none)?.name).toBe('break-glass')
    expect(loginRateLimitFor('GET', '/login/device', new URLSearchParams('user_code=X'))?.name).toBe('consent')
    expect(loginRateLimitFor('GET', '/login/cli/abcdefghijklmnopqrstuv', none)?.name).toBe('consent')
    expect(loginRateLimitFor('GET', '/login', none)).toBeNull()
    expect(loginRateLimitFor('GET', '/login/device', none)).toBeNull()
  })
})
