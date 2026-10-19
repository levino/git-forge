import { describe, expect, it } from 'vitest'
import { isPrivateHost, outboundFetch, outboundUrlError } from '../src/outbound.ts'
import { remoteRequest } from '../src/remote.ts'

describe('outbound requests', () => {
  it('recognizes private and local hosts', () => {
    for (const host of ['localhost', 'a.localhost', '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '[::1]', '[fd00::1]', '[::ffff:7f00:1]', 'box.internal', 'printer.local']) expect(isPrivateHost(host)).toBe(true)
    for (const host of ['github.com', '8.8.8.8', '172.32.0.1', '[2001:db8::1]']) expect(isPrivateHost(host)).toBe(false)
    expect(outboundUrlError('http://0x7f.1/repo.git')).toMatch(/private/)
    expect(outboundUrlError('ftp://example.com/repo.git')).toMatch(/http/)
    expect(outboundUrlError('http://127.0.0.1/repo.git', { allowPrivateHosts: true })).toBeNull()
  })

  it('re-validates every redirect hop and drops credentials on another origin', async () => {
    const seen: { url: string; authorization: string | null; method: string }[] = []
    const routes: Record<string, () => Response> = {
      'https://a.example/x': () => new Response(null, { status: 302, headers: { Location: 'https://b.example/y' } }),
      'https://b.example/y': () => new Response('ok'),
      'https://a.example/private': () => new Response(null, { status: 307, headers: { Location: 'http://169.254.169.254/latest' } }),
      'https://a.example/loop': () => new Response(null, { status: 301, headers: { Location: '/loop' } }),
    }
    const fetch = outboundFetch({
      fetch: async (request) => {
        expect(request.redirect).toBe('manual')
        seen.push({ url: request.url, authorization: request.headers.get('Authorization'), method: request.method })
        const route = routes[request.url]
        return route ? route() : new Response('missing', { status: 404 })
      },
    })
    const remote = { url: 'https://a.example', fetch, getAuthorization: async () => 'Bearer t' }
    expect(await (await remoteRequest(remote, 'https://a.example/x')).text()).toBe('ok')
    expect(seen).toEqual([
      { url: 'https://a.example/x', authorization: 'Bearer t', method: 'GET' },
      { url: 'https://b.example/y', authorization: null, method: 'GET' },
    ])
    seen.length = 0
    await expect(remoteRequest(remote, 'https://a.example/private')).rejects.toThrow(/private/)
    expect(seen.map((entry) => entry.url)).toEqual(['https://a.example/private'])
    await expect(remoteRequest(remote, 'http://localhost:1/repo.git')).rejects.toThrow(/private/)
    await expect(remoteRequest(remote, 'https://a.example/loop')).rejects.toThrow(/too many redirects/)
  })
})
