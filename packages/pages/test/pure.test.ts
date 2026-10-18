import { describe, expect, it } from 'vitest'
import { normalizeSitePath, isPagesUrl, isUserSiteRepository, matchPagesHost, PagesConfigError, pagesContentType, pagesUrl, parsePagesHosts, resolvePagesPath, serializeManifest, type Manifest } from '../src/index.ts'

const oid = (n: number) => n.toString(16).padStart(64, '0')

const manifest = (paths: string[]): Manifest => ({ version: 1, files: Object.fromEntries(paths.map((path, i) => [path, { oid: oid(i + 1), size: i }])) })

describe('pages hosts', () => {
  const hosts = parsePagesHosts('{owner}.pages.example.org', '{"docs.example.com": "acme/handbook"}')!

  it('parses the pattern and custom domains', () => {
    expect(hosts.scheme).toBe('https')
    expect(hosts.ownerSuffix).toBe('pages.example.org')
    expect(parsePagesHosts('http://{owner}.pages.localhost:8787', undefined)).toMatchObject({ scheme: 'http', ownerSuffix: 'pages.localhost:8787' })
    expect(parsePagesHosts('', '')).toBeNull()
    expect(() => parsePagesHosts('pages.example.org', undefined)).toThrow(PagesConfigError)
    expect(() => parsePagesHosts(undefined, '{"x.example.com": "nope"}')).toThrow(PagesConfigError)
    expect(() => parsePagesHosts('{owner}.pages.example.org', '{"a.pages.example.org": "a/b"}')).toThrow(PagesConfigError)
  })

  it('matches owner hosts and custom domains, case-insensitively', () => {
    expect(matchPagesHost(hosts, 'Alice.pages.example.org')).toEqual({ kind: 'owner', owner: 'alice', host: 'alice.pages.example.org' })
    expect(matchPagesHost(hosts, 'docs.example.com')).toEqual({ kind: 'domain', repo: { owner: 'acme', name: 'handbook' }, host: 'docs.example.com' })
    expect(matchPagesHost(hosts, 'a.b.pages.example.org')).toBeNull()
    expect(matchPagesHost(hosts, 'pages.example.org')).toBeNull()
    expect(matchPagesHost(hosts, 'forge.example.org')).toBeNull()
    expect(matchPagesHost(null, 'alice.pages.example.org')).toBeNull()
  })

  it('builds site URLs for project, user and custom-domain sites', () => {
    expect(pagesUrl(hosts, { owner: 'Alice', name: 'blog' })).toBe('https://alice.pages.example.org/blog/')
    expect(pagesUrl(hosts, { owner: 'alice', name: 'alice.pages.example.org' })).toBe('https://alice.pages.example.org/')
    expect(isUserSiteRepository(hosts, { owner: 'alice', name: 'alice.pages.example.org' })).toBe(true)
    expect(pagesUrl(hosts, { owner: 'acme', name: 'handbook' })).toBe('https://docs.example.com/')
    expect(pagesUrl(hosts, { owner: 'under_score', name: 'x' })).toBeNull()
    expect(isPagesUrl(hosts, new URL('https://alice.pages.example.org/blog/'))).toBe(true)
    expect(isPagesUrl(hosts, new URL('http://alice.pages.example.org/blog/'))).toBe(false)
    expect(isPagesUrl(hosts, new URL('https://evil.example.net/'))).toBe(false)
  })
})

describe('resolvePagesPath', () => {
  const site = manifest(['index.html', 'about.html', 'docs/index.html', 'img/logo.png', '404.html', 'a b.txt'])

  it('serves files, index pages and extensionless HTML', () => {
    expect(resolvePagesPath(site, '')).toMatchObject({ kind: 'file', path: 'index.html' })
    expect(resolvePagesPath(site, 'img/logo.png')).toMatchObject({ kind: 'file', path: 'img/logo.png' })
    expect(resolvePagesPath(site, 'about')).toMatchObject({ kind: 'file', path: 'about.html' })
    expect(resolvePagesPath(site, 'docs/')).toMatchObject({ kind: 'file', path: 'docs/index.html' })
    expect(resolvePagesPath(site, 'a%20b.txt')).toMatchObject({ kind: 'file', path: 'a b.txt' })
  })

  it('redirects directories without a trailing slash', () => {
    expect(resolvePagesPath(site, 'docs')).toEqual({ kind: 'redirect', location: 'docs/' })
  })

  it('falls back to 404.html and refuses traversal', () => {
    expect(resolvePagesPath(site, 'missing')).toMatchObject({ kind: 'not-found', page: { path: '404.html' } })
    expect(resolvePagesPath(site, 'img/logo.png/')).toMatchObject({ kind: 'not-found' })
    expect(resolvePagesPath(site, '../secret')).toMatchObject({ kind: 'not-found' })
    expect(resolvePagesPath(site, '%E0%A4%A')).toMatchObject({ kind: 'not-found' })
    expect(resolvePagesPath(manifest(['index.html']), 'x')).toEqual({ kind: 'not-found', page: null })
  })
})

describe('manifest and content types', () => {
  it('normalizes archive paths and refuses traversal', () => {
    expect(normalizeSitePath('./a//b/./c.html')).toBe('a/b/c.html')
    expect(normalizeSitePath('./')).toBeNull()
    expect(normalizeSitePath('../etc/passwd')).toBeNull()
    expect(normalizeSitePath('a/../../b')).toBeNull()
  })

  it('serializes deterministically, independent of insertion order', () => {
    const a = serializeManifest(new Map([['b', { oid: oid(1), size: 1 }], ['a', { oid: oid(2), size: 2, lfs: true }]]))
    const b = serializeManifest(new Map([['a', { oid: oid(2), size: 2, lfs: true }], ['b', { oid: oid(1), size: 1 }]]))
    expect(a.oid).toBe(b.oid)
    expect(new TextDecoder().decode(a.bytes)).toBe(`{"version":1,"files":{"a":{"oid":"${oid(2)}","size":2,"lfs":true},"b":{"oid":"${oid(1)}","size":1}}}`)
  })

  it('labels web content correctly', () => {
    expect(pagesContentType('index.html')).toBe('text/html; charset=utf-8')
    expect(pagesContentType('assets/app.JS')).toBe('text/javascript; charset=utf-8')
    expect(pagesContentType('style.css')).toBe('text/css; charset=utf-8')
    expect(pagesContentType('feed.xml')).toBe('application/xml; charset=utf-8')
    expect(pagesContentType('site.webmanifest')).toBe('application/manifest+json')
    expect(pagesContentType('img/a.svg')).toBe('image/svg+xml')
    expect(pagesContentType('CNAME')).toBe('application/octet-stream')
  })
})
