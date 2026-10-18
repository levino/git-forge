import { describe, expect, it } from 'vitest'
import {
  formatScopes,
  generateToken,
  hashToken,
  LAST_USED_RESOLUTION_MS,
  parseAuthorization,
  parseScopes,
  scopeCeiling,
  shouldRecordUse,
  tokenKindOf,
  tokenStatus,
} from '../src/index.ts'

describe('tokens', () => {
  it('generates distinct high-entropy tokens and keeps only a hash', async () => {
    const a = await generateToken('personal')
    const b = await generateToken('personal')
    expect(a.token).toMatch(/^gfp_[A-Za-z0-9_-]{43}$/)
    expect(a.token).not.toBe(b.token)
    expect(a.hash).toBe(await hashToken(a.token))
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(a.hash).not.toContain(a.token.slice(4))
    expect(a.displayPrefix).toBe(a.token.slice(0, 10))
  })

  it('recognises token kinds by prefix', async () => {
    expect(tokenKindOf((await generateToken('personal')).token)).toBe('personal')
    expect(tokenKindOf((await generateToken('app')).token)).toBe('app')
    expect(tokenKindOf('gfp_short')).toBeNull()
    expect(tokenKindOf('ghp_' + 'a'.repeat(43))).toBeNull()
  })

  it.each([
    [{ expiresAt: null, revokedAt: null }, 1000, 'active'],
    [{ expiresAt: 2000, revokedAt: null }, 1999, 'active'],
    [{ expiresAt: 2000, revokedAt: null }, 2000, 'expired'],
    [{ expiresAt: 2000, revokedAt: 500 }, 1000, 'revoked'],
    [{ expiresAt: null, revokedAt: 1000 }, 1000, 'revoked'],
  ] as const)('status of %o at %d is %s', (state, now, expected) => {
    expect(tokenStatus(state, now)).toBe(expected)
  })

  it.each([
    [[], 'none'],
    [['repo:read'], 'read'],
    [['repo:read', 'repo:write'], 'write'],
    [['repo:admin'], 'admin'],
  ] as const)('scopes %o allow at most %s', (scopes, ceiling) => {
    expect(scopeCeiling(scopes)).toBe(ceiling)
  })

  it('normalises and validates scopes', () => {
    expect(formatScopes(['repo:write', 'repo:read', 'repo:write'])).toBe('repo:read repo:write')
    expect(parseScopes('repo:read bogus repo:admin')).toEqual(['repo:read', 'repo:admin'])
    expect(() => formatScopes(['repo:everything' as 'repo:read'])).toThrow(/unknown scope/)
  })

  it('throttles last-used updates', () => {
    expect(shouldRecordUse(null, 0)).toBe(true)
    expect(shouldRecordUse(1000, 1000 + LAST_USED_RESOLUTION_MS - 1)).toBe(false)
    expect(shouldRecordUse(1000, 1000 + LAST_USED_RESOLUTION_MS)).toBe(true)
  })
})

describe('parseAuthorization', () => {
  const basic = (value: string) => `Basic ${btoa(value)}`
  it.each([
    [null, { kind: 'none' }],
    ['', { kind: 'none' }],
    [basic('alice:gfp_secret'), { kind: 'secret', secret: 'gfp_secret' }],
    [basic('x-access-token:gfp_secret'), { kind: 'secret', secret: 'gfp_secret' }],
    [basic(':pass:with:colons'), { kind: 'secret', secret: 'pass:with:colons' }],
    [basic('alice:'), { kind: 'none' }],
    [basic('nocolon'), { kind: 'malformed' }],
    ['Bearer abc.def.ghi', { kind: 'secret', secret: 'abc.def.ghi' }],
    ['token gfp_x', { kind: 'secret', secret: 'gfp_x' }],
    ['Digest whatever', { kind: 'malformed' }],
    ['Basic !!!', { kind: 'malformed' }],
  ] as const)('%s', (header, expected) => {
    expect(parseAuthorization(header)).toEqual(expected)
  })
})
