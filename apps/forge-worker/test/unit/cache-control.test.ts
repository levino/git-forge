import { describe, expect, it } from 'vitest'
import { cacheControlled } from '../../src/cache-control.ts'

const control = (request: RequestInit, headers: Record<string, string>, sharedCache = true) =>
  cacheControlled(new Request('https://forge.example/a/b', request), new Response('x', { headers }), sharedCache).headers.get('Cache-Control')

describe('cacheControlled', () => {
  it('keeps no dynamic response cacheable by a shared cache for signed-in requests', () => {
    expect(control({}, {})).toBe('private, no-store')
    expect(control({}, { 'Cache-Control': 'public, max-age=60' })).toBe('public, max-age=60')
    expect(control({ headers: { Authorization: 'Bearer t' } }, { 'Cache-Control': 'public, max-age=31536000, immutable' })).toBe('private, max-age=31536000, immutable')
    expect(control({ headers: { Cookie: '__Host-gf_session=s' } }, { 'Cache-Control': 'public, s-maxage=300' })).toBe('private, no-store')
    expect(control({}, { 'Cache-Control': 'public, max-age=60', 'Set-Cookie': 'a=b' })).toBe('private, max-age=60')
    expect(control({ headers: { Authorization: 'Bearer t' } }, { 'Cache-Control': 'no-cache, max-age=0, must-revalidate' })).toBe('no-cache, max-age=0, must-revalidate')
    expect(control({ headers: { Authorization: 'Bearer t' } }, { 'Cache-Control': 'public, max-age=60' }, false)).toBe('public, max-age=60')
  })
})
