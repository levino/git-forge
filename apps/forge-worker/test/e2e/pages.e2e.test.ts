import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gitEnv, tempDir } from './history.ts'
import { freePort, startWranglerDev, type WranglerDev } from './wrangler-dev.ts'

const run = promisify(execFile)

const BOOTSTRAP_TOKEN = `e2e-bootstrap-${crypto.randomUUID()}`
let TOKEN = ''

const lfsFilterConfig = [
  ['filter.lfs.process', 'git-lfs filter-process'],
  ['filter.lfs.smudge', 'git-lfs smudge -- %f'],
  ['filter.lfs.clean', 'git-lfs clean -- %f'],
  ['filter.lfs.required', 'true'],
] as const

const env = {
  ...process.env,
  ...gitEnv,
  GIT_CONFIG_COUNT: String(lfsFilterConfig.length),
  ...Object.fromEntries(lfsFilterConfig.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]])),
}

const git = async (cwd: string, args: readonly string[]): Promise<string> => (await run('git', args, { cwd, env, maxBuffer: 64 * 1024 * 1024 })).stdout

const write = (root: string, path: string, content: string | Uint8Array) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

const logo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 300_000 }, (_, i) => (i * 13) % 256)])
const logoOid = createHash('sha256').update(logo).digest('hex')

type PageResponse = { readonly status: number; readonly headers: Record<string, string>; readonly body: Buffer }

let dev: WranglerDev
let port = 0
let dir = ''

const pagesHost = (owner: string) => `${owner}.pages.localhost:${port}`

const page = (host: string, path: string, headers: Record<string, string> = {}): Promise<PageResponse> =>
  new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers: { Host: host, ...headers } }, (incoming) => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
      incoming.on('end', () =>
        resolve({
          status: incoming.statusCode ?? 0,
          headers: Object.fromEntries(Object.entries(incoming.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : (value ?? '')])),
          body: Buffer.concat(chunks),
        }),
      )
    })
    outgoing.on('error', reject)
    outgoing.end()
  })

const api = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${dev.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body !== undefined && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body instanceof Uint8Array ? { body: new Blob([body as Uint8Array<ArrayBuffer>]) } : body !== undefined ? { body: JSON.stringify(body) } : {}),
    redirect: 'manual',
  })

const eventually = async (check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> => {
  const until = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > until) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

beforeAll(async () => {
  port = await freePort()
  dev = await startWranglerDev({
    port,
    vars: { BOOTSTRAP_TOKEN, PUBLIC_URL: `http://127.0.0.1:${port}`, PAGES_HOST: `http://{owner}.pages.localhost:${port}`, PAGES_MAX_AGE: '120' },
  })
  const bootstrapped = await fetch(`${dev.url}/api/bootstrap`, { method: 'POST', headers: { Authorization: `Bearer ${BOOTSTRAP_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'e2e' }) })
  expect(bootstrapped.status).toBe(201)
  TOKEN = ((await bootstrapped.json()) as { token: string }).token
  for (const [name, visibility] of [['site', 'public'], ['notes', 'private'], ['docs', 'public']] as const) {
    expect((await api('POST', '/api/repos', { owner: 'e2e', name, visibility })).status).toBe(201)
  }
  dir = tempDir()
  await git(dir, ['init', '-q', '-b', 'main'])
  await git(dir, ['lfs', 'install', '--local'])
  await git(dir, ['config', 'lfs.locksverify', 'false'])
  await git(dir, ['lfs', 'track', '*.png'])
  write(dir, 'index.html', '<!doctype html><h1>Home</h1>')
  write(dir, 'blog/index.html', '<h1>Blog</h1>')
  write(dir, 'style.css', 'h1{color:red}')
  write(dir, '404.html', '<h1>Not here</h1>')
  write(dir, 'logo.png', logo)
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'site'])
  const authed = dev.url.replace('http://', `http://git:${TOKEN}@`)
  for (const name of ['site', 'notes']) {
    await git(dir, ['remote', 'add', name, `${authed}/e2e/${name}.git`])
    await git(dir, ['lfs', 'push', '--all', name])
    await git(dir, ['push', '-q', name, 'main'])
  }
}, 180_000)

afterAll(async () => {
  await dev?.stop()
})

describe('pages on wrangler dev', () => {
  it('deploys from a branch and serves the site on the pages host', async () => {
    const enabled = await api('POST', '/api/v3/repos/e2e/site/pages', { source: { branch: 'main', path: '/' } })
    expect(enabled.status).toBe(201)
    expect(await enabled.json()).toMatchObject({ html_url: `http://${pagesHost('e2e')}/site/` })
    await eventually(async () => (await page(pagesHost('e2e'), '/site/')).status === 200)
    const home = await page(pagesHost('e2e'), '/site/')
    expect(home.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(home.headers['cache-control']).toBe('public, max-age=120')
    expect(home.headers.etag).toBe(`"${createHash('sha256').update('<!doctype html><h1>Home</h1>').digest('hex')}"`)
    expect(home.body.toString()).toBe('<!doctype html><h1>Home</h1>')
    expect((await page(pagesHost('e2e'), '/site/style.css')).headers['content-type']).toBe('text/css; charset=utf-8')
    expect((await page(pagesHost('e2e'), '/site')).headers.location).toBe('/site/')
    expect((await page(pagesHost('e2e'), '/site/blog')).headers.location).toBe('blog/')
    expect((await page(pagesHost('e2e'), '/site/blog/')).body.toString()).toBe('<h1>Blog</h1>')
    const missing = await page(pagesHost('e2e'), '/site/nothing')
    expect(missing.status).toBe(404)
    expect(missing.body.toString()).toBe('<h1>Not here</h1>')
    expect((await page(pagesHost('e2e'), '/site/index.html', { 'If-None-Match': home.headers.etag! })).status).toBe(304)
  })

  it('resolves LFS files to the immutable media URL', async () => {
    const redirect = await page(pagesHost('e2e'), '/site/logo.png')
    expect(redirect.status).toBe(302)
    expect(redirect.headers.location).toBe(`http://127.0.0.1:${port}/e2e/site/media/${logoOid}/logo.png`)
    const media = await fetch(redirect.headers.location!)
    expect(media.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(logo)
  })

  it('redeploys on push and switches to the new deployment', async () => {
    write(dir, 'index.html', '<h1>Version 2</h1>')
    await git(dir, ['commit', '-qam', 'v2'])
    await git(dir, ['push', '-q', 'site', 'main'])
    await eventually(async () => (await page(pagesHost('e2e'), '/site/')).body.toString() === '<h1>Version 2</h1>')
    const builds = (await (await api('GET', '/api/v3/repos/e2e/site/pages/builds')).json()) as { status: string }[]
    expect(builds.map((build) => build.status)).toEqual(['built', 'built'])
  })

  it('deploys an uploaded artifact (the tar that actions/upload-pages-artifact produces)', async () => {
    expect((await api('POST', '/api/v3/repos/e2e/docs/pages', { build_type: 'workflow' })).status).toBe(201)
    const out = tempDir()
    write(out, 'index.html', '<h1>Built by CI</h1>')
    write(out, 'assets/app.js', 'console.log(1)')
    const archive = new Uint8Array(execFileSync('tar', ['--format', 'pax', '-cf', '-', '-C', out, '.']))
    const deployed = await api('POST', '/api/v3/repos/e2e/docs/pages/deployments?pages_build_version=abc123', archive, { 'Content-Type': 'application/x-tar' })
    expect(deployed.status).toBe(200)
    const body = (await deployed.json()) as { id: number; status: string; page_url: string }
    expect(body).toMatchObject({ status: 'succeed', page_url: `http://${pagesHost('e2e')}/docs/` })
    expect((await (await api('GET', `/api/v3/repos/e2e/docs/pages/deployments/${body.id}`)).json()) as { status: string }).toMatchObject({ status: 'succeed' })
    expect((await page(pagesHost('e2e'), '/docs/')).body.toString()).toBe('<h1>Built by CI</h1>')
    expect((await page(pagesHost('e2e'), '/docs/assets/app.js')).headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect((await api('POST', '/api/v3/repos/e2e/docs/pages/deployments', { artifact_id: 1 })).status).toBe(422)
  })

  it('keeps private pages for readers: sign-in redirect for visitors, tokens for readers', async () => {
    expect((await api('POST', '/api/v3/repos/e2e/notes/pages', { source: 'main' })).status).toBe(201)
    await eventually(async () => (await page(pagesHost('e2e'), '/notes/', { Authorization: `Bearer ${TOKEN}` })).status === 200)
    const anonymous = await page(pagesHost('e2e'), '/notes/')
    expect(anonymous.status).toBe(302)
    const authorize = new URL(anonymous.headers.location!)
    expect(authorize.pathname).toBe('/_pages/authorize')
    expect(authorize.searchParams.get('redirect')).toBe(`http://${pagesHost('e2e')}/notes/`)
    const toLogin = await fetch(authorize, { redirect: 'manual' })
    expect(toLogin.status).toBe(302)
    expect(toLogin.headers.get('Location')).toMatch(/^\/login\?return_to=%2F_pages%2Fauthorize/)
    const reader = await page(pagesHost('e2e'), '/notes/', { Authorization: `Bearer ${TOKEN}` })
    expect(reader.headers['cache-control']).toBe('private, no-cache')
    expect(reader.body.toString()).toBe('<!doctype html><h1>Home</h1>')
    const lfs = await page(pagesHost('e2e'), '/notes/logo.png', { Authorization: `Bearer ${TOKEN}` })
    expect(lfs.status).toBe(200)
    expect(new Uint8Array(lfs.body)).toEqual(logo)
    expect((await page(pagesHost('e2e'), '/notes/', { Cookie: 'forge_pages=forged' })).status).toBe(302)
  })
})
