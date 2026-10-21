import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cookieNames, createLoginStore, type Principal } from '@git-forge/accounts'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import RepoHome from '../../src/pages/[owner]/[repo]/index.astro'
import { isAnonymousRequest } from '../../src/cache-control.ts'
import { cacheablePath, cachedPage, type PageCache } from '../../src/ui/page-cache.ts'
import { signIn } from '../../src/ui/sign-in.ts'
import { git, tempDir } from '../e2e/history.ts'
import { bootstrap, call, type NodeForge, nodeForge } from '../support/node-forge.ts'

const BASE = 'https://forge.example'

const memoryCache = () => {
  const entries = new Map<string, { body: string; headers: [string, string][] }>()
  const cache: PageCache = {
    match: async (key) => {
      const entry = entries.get(key)
      return entry ? new Response(entry.body, { headers: entry.headers }) : null
    },
    put: async (key, response) => void entries.set(key, { body: await response.text(), headers: [...response.headers] }),
  }
  return { cache, entries }
}

let forge: NodeForge
let server: RunningServer
let container: AstroContainer
let token: string
let cookie: string
let dir: string
const store = memoryCache()

const write = (root: string, path: string, content: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

const visit = async (path: string, init: RequestInit = {}, page = RepoHome) => {
  const request = new Request(`${BASE}${path}`, init)
  const signed = await signIn(forge.services, request)
  let rendered = 0
  const response = await cachedPage(forge.services, request, signed.principal, async () => {
    rendered++
    const [, owner, repo] = new URL(request.url).pathname.split('/')
    return container.renderToResponse(page, { request, params: { owner: owner!, repo: repo! }, locals: { forge: forge.services, principal: signed.principal as Principal, session: signed.session }, partial: false })
  })
  return { rendered, cache: response.headers.get('X-Forge-Cache'), vary: response.headers.get('Vary'), html: await response.text() }
}

beforeAll(async () => {
  forge = await nodeForge()
  forge = { ...forge, services: { ...forge.services, pageCache: store.cache } }
  server = await startServer((request) => forge.fetch(request))
  token = await bootstrap(forge, BASE, 'olivia')
  for (const [name, visibility] of [['site', 'public'], ['secret', 'private']]) expect((await call(forge, BASE, 'POST', '/api/repos', token, { owner: 'olivia', name, visibility })).status).toBe(201)
  dir = tempDir()
  await git(dir, ['init', '-q', '-b', 'main'])
  write(dir, 'README.md', '# Site\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'Initial commit'])
  for (const name of ['site', 'secret']) await git(dir, ['push', '-q', `${server.url.replace('://', `://git:${token}@`)}/olivia/${name}.git`, 'main'])
  const user = (await forge.services.authenticate(new Request(BASE, { headers: { Authorization: `Bearer ${token}` } })))!
  const created = await createLoginStore(forge.db).createSession({ userId: user.kind === 'user' ? user.id : '', method: 'oidc', ttlMs: 3_600_000 })
  cookie = `${cookieNames(true).session}=${created.token}`
  container = await AstroContainer.create()
}, 60_000)

afterAll(async () => {
  await server?.close()
})

describe('page cache', () => {
  it('serves public repository pages to anonymous visitors from the cache', async () => {
    expect(await visit('/olivia/site')).toMatchObject({ rendered: 1, cache: 'miss', vary: 'Cookie, Authorization' })
    const hit = await visit('/olivia/site')
    expect(hit).toMatchObject({ rendered: 0, cache: 'hit' })
    expect(hit.html).toContain('Initial commit')
    expect(await visit('/olivia/site?tab=x')).toMatchObject({ rendered: 1, cache: 'miss' })
  })

  it('invalidates on pushes and on collaboration changes', async () => {
    await visit('/olivia/site')
    write(dir, 'README.md', '# Site\n\nMore.\n')
    await git(dir, ['commit', '-q', '-am', 'Second commit'])
    await git(dir, ['push', '-q', `${server.url.replace('://', `://git:${token}@`)}/olivia/site.git`, 'main'])
    const pushed = await visit('/olivia/site')
    expect(pushed).toMatchObject({ rendered: 1, cache: 'miss' })
    expect(pushed.html).toContain('Second commit')
    expect((await call(forge, BASE, 'POST', '/api/v3/repos/olivia/site/issues', token, { title: 'Broken' })).status).toBe(201)
    expect(await visit('/olivia/site')).toMatchObject({ rendered: 1, cache: 'miss' })
    const before = await forge.services.repositoryChanges({ owner: 'olivia', name: 'site' })
    expect((await call(forge, BASE, 'POST', '/api/v3/repos/olivia/site/issues/1/comments', token, { body: 'Same here' })).status).toBe(201)
    expect((await call(forge, BASE, 'POST', '/api/v3/repos/olivia/site/releases', token, { tag_name: 'v1', target_commitish: 'main' })).status).toBe(201)
    expect(await forge.services.repositoryChanges({ owner: 'olivia', name: 'site' })).toBeGreaterThanOrEqual(before! + 2)
  })

  it('never caches for signed-in visitors, private repositories, writes or forms', async () => {
    await visit('/olivia/site')
    const entries = store.entries.size
    const signed = await visit('/olivia/site', { headers: { Cookie: cookie } })
    expect(signed).toMatchObject({ rendered: 1, cache: null })
    expect(signed.html).toContain('href="/notifications"')
    expect(await visit('/olivia/site', { headers: { Authorization: `Bearer ${token}` } })).toMatchObject({ rendered: 1, cache: null })
    expect(await visit('/olivia/site', { headers: { Cookie: `${cookieNames(true).session}=invalid` } })).toMatchObject({ rendered: 1, cache: null })
    expect(await visit('/olivia/secret')).toMatchObject({ rendered: 1, cache: null })
    expect(await visit('/olivia/site', { method: 'POST' })).toMatchObject({ rendered: 1, cache: null })
    expect(store.entries.size).toBe(entries)
    expect((await visit('/olivia/site')).cache).toBe('hit')
  })

  it('stores only plain HTML without cookies', async () => {
    const request = new Request(`${BASE}/olivia/site/tree/main`)
    const responses = [
      new Response('x', { headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'a=b' } }),
      new Response('x', { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'private' } }),
      new Response('x', { status: 404, headers: { 'Content-Type': 'text/html' } }),
      new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
    ]
    for (const response of responses) expect((await cachedPage(forge.services, request, { kind: 'anonymous' }, async () => response)).headers.get('X-Forge-Cache')).toBeNull()
  })
})

describe('cacheable requests', () => {
  it('covers repository pages but not forms', () => {
    for (const path of ['/a/b', '/a/b/tree/main/src', '/a/b/blob/main/x', '/a/b/issues', '/a/b/issues/1', '/a/b/pull/2/files', '/a/b/releases/tag/v1', '/a/b/commits/main'])
      expect(cacheablePath(path)).toEqual({ owner: 'a', name: 'b' })
    for (const path of ['/a/b/settings', '/a/b/issues/new', '/a/b/releases/edit/v1', '/a/b/edit/main/x', '/a/b/actions', '/a/b/fork', '/a/b/import', '/a', '/', '/-/admin/x'])
      expect(cacheablePath(path)).toBeNull()
  })

  it('treats requests with credentials as signed in', () => {
    expect(isAnonymousRequest(new Request(BASE))).toBe(true)
    expect(isAnonymousRequest(new Request(BASE, { headers: { Cookie: 'gf_bookmark=1' } }))).toBe(true)
    expect(isAnonymousRequest(new Request(BASE, { headers: { Cookie: 'x=1; gf_session=abc' } }))).toBe(false)
    expect(isAnonymousRequest(new Request(BASE, { headers: { Cookie: '__Host-gf_session=abc' } }))).toBe(false)
    expect(isAnonymousRequest(new Request(BASE, { headers: { Authorization: 'Basic eDp5' } }))).toBe(false)
  })
})
