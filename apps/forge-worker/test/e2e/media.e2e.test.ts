import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gitEnv, tempDir } from './history.ts'
import { startWranglerDev, type WranglerDev } from './wrangler-dev.ts'

const run = promisify(execFile)

const BOOTSTRAP_TOKEN = `e2e-bootstrap-${crypto.randomUUID()}`
let ADMIN_TOKEN = ''
let READ_TOKEN = ''

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

const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 700_000 }, (_, i) => (i * 31 + (i >> 9)) % 256)])
const photoOid = createHash('sha256').update(photo).digest('hex')

let dev: WranglerDev
let commit: string

const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  fetch(`${dev.url}${path}`, { method, headers: { Authorization: `Bearer ${READ_TOKEN}`, ...headers }, redirect: 'manual' })

beforeAll(async () => {
  dev = await startWranglerDev({ vars: { BOOTSTRAP_TOKEN } })
  const post = async (path: string, token: string, body: unknown) =>
    fetch(`${dev.url}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const bootstrapped = await post('/api/bootstrap', BOOTSTRAP_TOKEN, { login: 'e2e' })
  expect(bootstrapped.status).toBe(201)
  ADMIN_TOKEN = ((await bootstrapped.json()) as { token: string }).token
  const reader = await post('/api/admin/users/e2e/tokens', ADMIN_TOKEN, { name: 'cdn', scopes: ['repo:read'] })
  expect(reader.status).toBe(201)
  READ_TOKEN = ((await reader.json()) as { token: string }).token
  const created = await post('/api/repos', ADMIN_TOKEN, { owner: 'e2e', name: 'archive' })
  expect(created.status).toBe(201)
  const dir = tempDir()
  await git(dir, ['init', '-q', '-b', 'main'])
  await git(dir, ['lfs', 'install', '--local'])
  await git(dir, ['config', 'lfs.locksverify', 'false'])
  await git(dir, ['remote', 'add', 'origin', `${dev.url.replace('http://', `http://git:${ADMIN_TOKEN}@`)}/e2e/archive.git`])
  await git(dir, ['lfs', 'track', '*.jpg'])
  write(dir, 'photos/1950/Dorfplatz.jpg', photo)
  write(dir, 'README.md', '# Archive\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'add photo'])
  commit = (await git(dir, ['rev-parse', 'HEAD'])).trim()
  await git(dir, ['lfs', 'push', '--all', 'origin'])
  await git(dir, ['push', '-q', 'origin', 'main'])
}, 120_000)

afterAll(async () => {
  await dev?.stop()
})

describe('media and raw endpoints on wrangler dev', () => {
  it('refuses anonymous reads of a private repository', async () => {
    expect((await fetch(`${dev.url}/e2e/archive/media/${photoOid}`)).status).toBe(401)
    expect((await fetch(`${dev.url}/e2e/archive/raw/main/README.md`)).status).toBe(401)
  })

  it('serves the pushed LFS object by oid as an immutable resource', async () => {
    const response = await get(`/e2e/archive/media/${photoOid}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
    expect(response.headers.get('ETag')).toBe(`"${photoOid}"`)
    expect(response.headers.get('Content-Type')).toBe('image/jpeg')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(photo)
  })

  it('answers range, HEAD and conditional requests from R2', async () => {
    const partial = await get(`/e2e/archive/media/${photoOid}`, { Range: 'bytes=1000-1999' })
    expect(partial.status).toBe(206)
    expect(partial.headers.get('Content-Range')).toBe(`bytes 1000-1999/${photo.length}`)
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(photo.slice(1000, 2000))
    const head = await get(`/e2e/archive/media/${photoOid}`, {}, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.headers.get('Content-Length')).toBe(String(photo.length))
    expect((await get(`/e2e/archive/media/${photoOid}`, { 'If-None-Match': `"${photoOid}"` })).status).toBe(304)
  })

  it('resolves raw paths, redirecting LFS pointers to the media URL', async () => {
    const readme = await get('/e2e/archive/raw/main/README.md')
    expect(await readme.text()).toBe('# Archive\n')
    expect(readme.headers.get('Cache-Control')).toBe('public, max-age=60')
    const redirect = await get('/e2e/archive/raw/main/photos/1950/Dorfplatz.jpg')
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get('Location')).toBe(`/e2e/archive/media/${photoOid}/Dorfplatz.jpg`)
    const pinned = await get(`/e2e/archive/raw/${commit}/photos/1950/Dorfplatz.jpg`)
    expect(pinned.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
    const followed = await get(redirect.headers.get('Location')!)
    expect(followed.headers.get('Content-Disposition')).toContain('filename="Dorfplatz.jpg"')
    expect(new Uint8Array(await followed.arrayBuffer())).toEqual(photo)
  })
})
