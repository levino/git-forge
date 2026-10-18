import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { MemoryStorage, publishedObjectKey, readAll, storagePublisher } from '@git-forge/core'
import { tempDir, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConfigurationError, parsePagesSettings, parseSettings } from '../../src/config.ts'
import { gitEnv } from '../e2e/history.ts'
import { bootstrap, call, type NodeForge, nodeForge } from '../support/node-forge.ts'

const run = promisify(execFile)

const lfsConfig = [
  ['filter.lfs.process', 'git-lfs filter-process'],
  ['filter.lfs.smudge', 'git-lfs smudge -- %f'],
  ['filter.lfs.clean', 'git-lfs clean -- %f'],
  ['filter.lfs.required', 'true'],
] as const

const env = {
  ...process.env,
  ...gitEnv,
  GIT_CONFIG_COUNT: String(lfsConfig.length),
  ...Object.fromEntries(lfsConfig.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]])),
}

const git = async (cwd: string, args: readonly string[]) => (await run('git', args, { cwd, env, maxBuffer: 64 * 1024 * 1024 })).stdout

const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 5000 }, (_, i) => i % 251)])
const imageOid = createHash('sha256').update(image).digest('hex')

describe('pages settings', () => {
  it('parses the pages host pattern, custom domains and cache age', async () => {
    expect(parsePagesSettings({})).toEqual({ hosts: null, maxAgeSeconds: 60 })
    const settings = await parseSettings({ PAGES_HOST: '{owner}.pages.example.org', PAGES_DOMAINS: '{"docs.example.com":"acme/docs"}', PAGES_MAX_AGE: '300' })
    expect(settings.pages?.hosts?.ownerSuffix).toBe('pages.example.org')
    expect(settings.pages?.maxAgeSeconds).toBe(300)
    expect(() => parsePagesSettings({ PAGES_HOST: 'pages.example.org' })).toThrow(ConfigurationError)
    expect(() => parsePagesSettings({ PAGES_DOMAINS: '[]' })).toThrow(ConfigurationError)
  })
})

describe('pages and LFS publish in the forge', () => {
  let server: RunningServer
  let forge: NodeForge
  let cdn: MemoryStorage
  let token: string
  let dir: string

  beforeAll(async () => {
    let handler: (request: Request) => Promise<Response> = async () => new Response(null, { status: 503 })
    server = await startServer((request) => handler(request))
    cdn = new MemoryStorage()
    forge = await nodeForge({
      publicUrl: server.url,
      pages: { hosts: (await parseSettings({ PAGES_HOST: 'http://{owner}.pages.test' })).pages!.hosts, maxAgeSeconds: 30 },
      lfsPublisher: storagePublisher(cdn, 'objects/'),
    })
    handler = forge.fetch
    const admin = await bootstrap(forge, server.url, 'alice')
    token = admin
    expect((await call(forge, server.url, 'POST', '/api/repos', token, { owner: 'alice', name: 'site', visibility: 'public' })).status).toBe(201)
    expect((await call(forge, server.url, 'POST', '/api/repos', token, { owner: 'alice', name: 'secret' })).status).toBe(201)
    dir = tempDir()
    await git(dir, ['init', '-q', '-b', 'main'])
    await git(dir, ['lfs', 'install', '--local'])
    await git(dir, ['config', 'lfs.locksverify', 'false'])
    await git(dir, ['lfs', 'track', '*.png'])
    writeFile(dir, 'index.html', '<h1>one</h1>')
    writeFile(dir, 'logo.png', image)
    await git(dir, ['add', '-A'])
    await git(dir, ['commit', '-q', '-m', 'one'])
    const authed = server.url.replace('http://', `http://alice:${token}@`)
    await git(dir, ['remote', 'add', 'origin', `${authed}/alice/site.git`])
    await git(dir, ['remote', 'add', 'secret', `${authed}/alice/secret.git`])
    await git(dir, ['push', '-q', 'secret', 'main'])
  }, 60_000)

  afterAll(async () => {
    await server?.close()
  })

  const page = (path: string, headers: Record<string, string> = {}) => forge.fetch(new Request(`http://alice.pages.test${path}`, { headers }))

  it('publishes LFS objects of public repositories on push, keyed by oid, and never those of private ones', async () => {
    expect(await cdn.head(publishedObjectKey(imageOid, 'objects/'))).toBeNull()
    expect((await call(forge, server.url, 'POST', '/api/repos/alice/secret/lfs/publish', token)).status).toBe(422)
    await git(dir, ['push', '-q', 'origin', 'main'])
    const published = await cdn.get(publishedObjectKey(imageOid, 'objects/'))
    expect(published && (await readAll(published.body))).toEqual(image)
    expect((await call(forge, server.url, 'POST', '/api/repos/alice/site/lfs/publish', token)).status).toBe(202)
  })

  it('deploys the source branch on enable and on every push, and serves it on the pages host', async () => {
    const enabled = await call(forge, server.url, 'POST', '/api/v3/repos/alice/site/pages', token, { source: { branch: 'main', path: '/' } })
    expect(enabled.status).toBe(201)
    expect(await enabled.json()).toMatchObject({ html_url: 'http://alice.pages.test/site/', status: 'built' })
    const home = await page('/site/')
    expect(home.headers.get('Cache-Control')).toBe('public, max-age=30')
    expect(await home.text()).toBe('<h1>one</h1>')
    expect((await page('/site/logo.png')).headers.get('Location')).toBe(`${server.url}/alice/site/media/${imageOid}/logo.png`)
    writeFile(dir, 'index.html', '<h1>two</h1>')
    await git(dir, ['commit', '-qam', 'two'])
    await git(dir, ['push', '-q', 'origin', 'main'])
    expect(await (await page('/site/')).text()).toBe('<h1>two</h1>')
    expect((await forge.fetch(new Request(`${server.url}/alice/site/`))).status).not.toBe(200)
  })

  it('keeps private sites behind the forge sign-in', async () => {
    expect((await call(forge, server.url, 'POST', '/api/v3/repos/alice/secret/pages', token, { source: 'main' })).status).toBe(201)
    const response = await page('/secret/')
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe(`${server.url}/_pages/authorize?redirect=${encodeURIComponent('http://alice.pages.test/secret/')}`)
    const redirect = await forge.fetch(new Request(response.headers.get('Location')!))
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get('Location')).toMatch(/^\/login\?return_to=/)
    expect(await (await page('/secret/', { Authorization: `Bearer ${token}` })).text()).toBe('<h1>one</h1>')
  })
})
