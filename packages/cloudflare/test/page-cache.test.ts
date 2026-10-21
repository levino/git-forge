import { describe, expect, it } from 'vitest'
import { cacheApiPageCache } from '../src/page-cache.ts'

describe('cacheApiPageCache', () => {
  it('stores pages under a private host and serves them without its own cache headers', async () => {
    const cache = cacheApiPageCache(60, { cache: caches.open('pages-test') })
    const key = crypto.randomUUID()
    expect(await cache.match(key)).toBeNull()
    await cache.put(key, new Response('<p>hi</p>', { headers: { 'Content-Type': 'text/html; charset=utf-8', Vary: 'Cookie' } }))
    const hit = await cache.match(key)
    expect(hit?.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(hit?.headers.has('Cache-Control')).toBe(false)
    expect(await hit?.text()).toBe('<p>hi</p>')
  })

  it('keeps the original Cache-Control and never stores responses that set cookies', async () => {
    const cache = cacheApiPageCache(60, { cache: caches.open('pages-test') })
    const [kept, refused] = [crypto.randomUUID(), crypto.randomUUID()]
    await cache.put(kept, new Response('a', { headers: { 'Cache-Control': 'no-cache' } }))
    expect((await cache.match(kept))?.headers.get('Cache-Control')).toBe('no-cache')
    await cache.put(refused, new Response('b', { headers: { 'Set-Cookie': 'x=1' } }))
    expect(await cache.match(refused)).toBeNull()
  })
})
