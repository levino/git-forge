import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git, gitEnv, gitFails, tempDir } from './history.ts'
import { startWranglerDev, type WranglerDev } from './wrangler-dev.ts'

const LFS_CONFIG = ['filter.lfs.process=git-lfs filter-process', 'filter.lfs.required=true', 'lfs.locksverify=false']

const lfsGit = async (cwd: string, args: readonly string[]): Promise<string> =>
  (await promisify(execFile)('git', [...LFS_CONFIG.flatMap((entry) => ['-c', entry]), ...args], { cwd, env: { ...process.env, ...gitEnv }, maxBuffer: 64 * 1024 * 1024 })).stdout

const BOOTSTRAP_TOKEN = `e2e-${crypto.randomUUID()}`

let dev: WranglerDev
let owner: string
let maintainer: string
let outsider: string

type Json = Record<string, any>

const call = async (method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: Json }> => {
  const response = await fetch(`${dev.url}${path}`, {
    method,
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as Json) }
}

const remote = (token: string, repo: string) => `${dev.url.replace('http://', `http://git:${token}@`)}/${repo}.git`

const lines = (tag: string, count = 30) => Array.from({ length: count }, (_, i) => `${tag} line ${i}\n`).join('')

const write = (dir: string, name: string, content: string | Uint8Array) => {
  mkdirSync(dirname(join(dir, name)), { recursive: true })
  writeFileSync(join(dir, name), content)
}

const commit = async (dir: string, message: string) => {
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', message])
}

beforeAll(async () => {
  dev = await startWranglerDev({ vars: { BOOTSTRAP_TOKEN } })
  const bootstrapped = await fetch(`${dev.url}/api/bootstrap`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${BOOTSTRAP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'owner' }),
  })
  owner = ((await bootstrapped.json()) as { token: string }).token
  for (const login of ['maintainer', 'outsider']) expect((await call('POST', '/api/admin/users', owner, { login })).status).toBe(201)
  maintainer = (await call('POST', '/api/admin/users/maintainer/tokens', owner, { scopes: ['repo:write'] })).body.token
  outsider = (await call('POST', '/api/admin/users/outsider/tokens', owner, { scopes: ['repo:write'] })).body.token
  expect((await call('POST', '/api/repos', owner, { owner: 'owner', name: 'site', visibility: 'public' })).status).toBe(201)
  expect((await call('PUT', '/api/repos/owner/site/collaborators/maintainer', owner, { role: 'write' })).status).toBe(200)
  const work = tempDir()
  await git(work, ['init', '-q', '-b', 'main'])
  write(work, 'src/app.txt', lines('app'))
  write(work, 'README.md', lines('readme'))
  await commit(work, 'initial')
  await git(work, ['push', '-q', remote(owner, 'owner/site'), 'main'])
}, 120_000)

afterAll(async () => {
  await dev?.stop()
})

describe('forks on wrangler dev with real git', () => {
  it('forks, opens a pull request from the fork, lets maintainers push to it and merges renamed files like git', async () => {
    const fork = await call('POST', '/api/v3/repos/owner/site/forks', outsider, {})
    expect(fork.status).toBe(202)
    expect(fork.body).toMatchObject({ full_name: 'outsider/site', fork: true, parent: { full_name: 'owner/site' }, source: { full_name: 'owner/site' } })
    expect((await call('GET', '/api/v3/repos/owner/site/forks', owner)).body.map((repo: Json) => repo.full_name)).toEqual(['outsider/site'])

    const contributor = tempDir()
    await git(contributor, ['clone', '-q', remote(outsider, 'outsider/site'), 'site'])
    const work = join(contributor, 'site')
    await git(work, ['fsck', '--strict'])
    await git(work, ['checkout', '-q', '-b', 'fix'])
    write(work, 'src/app.txt', lines('app').replace('app line 25\n', 'fixed by the fork\n'))
    await commit(work, 'Fix the app')
    await git(work, ['push', '-q', 'origin', 'fix'])
    expect(await gitFails(work, ['push', remote(outsider, 'owner/site'), 'fix'])).toMatch(/403|permission denied/)

    const upstream = tempDir()
    await git(upstream, ['clone', '-q', remote(owner, 'owner/site'), 'site'])
    const main = join(upstream, 'site')
    mkdirSync(join(main, 'lib'), { recursive: true })
    await git(main, ['mv', 'src/app.txt', 'lib/application.txt'])
    write(main, 'lib/application.txt', lines('app').replace('app line 2\n', 'renamed upstream\n'))
    await commit(main, 'Move the app')
    await git(main, ['push', '-q', 'origin', 'main'])

    const pull = await call('POST', '/api/v3/repos/owner/site/pulls', outsider, { title: 'Fix the app', head: 'outsider:fix', base: 'main', maintainer_can_modify: true })
    expect(pull.status).toBe(201)
    expect(pull.body).toMatchObject({ number: 1, mergeable: true, maintainer_can_modify: true, head: { label: 'outsider:fix', repo: { full_name: 'outsider/site' } } })

    const maintainerClone = tempDir()
    await git(maintainerClone, ['clone', '-q', '--branch', 'fix', remote(maintainer, 'outsider/site'), 'site'])
    const edit = join(maintainerClone, 'site')
    write(edit, 'NOTES.md', 'maintainer note\n')
    await commit(edit, 'Maintainer note')
    await git(edit, ['push', '-q', 'origin', 'fix'])
    expect(await gitFails(edit, ['push', 'origin', 'fix:other'])).toMatch(/permission denied/)
    const head = (await git(edit, ['rev-parse', 'HEAD'])).trim()
    expect((await call('GET', '/api/v3/repos/owner/site/pulls/1', maintainer)).body).toMatchObject({ head: { sha: head }, mergeable: true })

    const merged = await call('PUT', '/api/v3/repos/owner/site/pulls/1/merge', maintainer, { merge_method: 'merge' })
    expect(merged.status).toBe(200)
    await git(main, ['fetch', '-q', 'origin'])
    await git(main, ['fetch', '-q', remote(outsider, 'outsider/site'), 'fix:refs/remotes/fork/fix'])
    await git(main, ['checkout', '-q', '-b', 'expected', 'main'])
    await git(main, ['merge', '-q', '--no-ff', '-m', 'local', 'fork/fix'])
    expect((await git(main, ['rev-parse', 'origin/main^{tree}'])).trim()).toBe((await git(main, ['rev-parse', 'expected^{tree}'])).trim())
    expect((await git(main, ['show', 'origin/main:lib/application.txt']))).toContain('fixed by the fork')
    expect((await git(main, ['log', '-1', '--format=%s', 'origin/main'])).trim()).toBe('Merge pull request #1 from outsider/fix')
    const verify = tempDir()
    await git(verify, ['clone', '-q', remote(owner, 'owner/site'), 'site'])
    await git(join(verify, 'site'), ['fsck', '--strict', '--no-dangling'])
    rmSync(verify, { recursive: true, force: true })
  })

  it('merges a pull request from a fork with LFS objects that only the fork had', async () => {
    expect((await call('POST', '/api/repos', owner, { owner: 'owner', name: 'media', visibility: 'public' })).status).toBe(201)
    const seed = tempDir()
    await git(seed, ['init', '-q', '-b', 'main'])
    write(seed, 'README.md', 'media\n')
    await commit(seed, 'initial')
    await git(seed, ['push', '-q', remote(owner, 'owner/media'), 'main'])
    expect((await call('POST', '/api/v3/repos/owner/media/forks', outsider, {})).status).toBe(202)

    const contributor = tempDir()
    await lfsGit(contributor, ['clone', '-q', remote(outsider, 'outsider/media'), 'media'])
    const work = join(contributor, 'media')
    await lfsGit(work, ['lfs', 'install', '--local'])
    await lfsGit(work, ['checkout', '-q', '-b', 'photo'])
    await lfsGit(work, ['lfs', 'track', '*.bin'])
    const photo = new Uint8Array(Array.from({ length: 300_000 }, (_, i) => (i * 17 + (i >> 7)) % 256))
    write(work, 'photo.bin', photo)
    await lfsGit(work, ['add', '-A'])
    await lfsGit(work, ['commit', '-q', '-m', 'Add a photo'])
    await lfsGit(work, ['push', '-q', 'origin', 'photo'])
    const oid = createHash('sha256').update(photo).digest('hex')
    expect((await fetch(`${dev.url}/owner/media/media/${oid}`)).status).toBe(404)

    const pull = await call('POST', '/api/v3/repos/owner/media/pulls', outsider, { title: 'Add a photo', head: 'outsider:photo', base: 'main' })
    expect(pull.status).toBe(201)
    expect((await call('PUT', `/api/v3/repos/owner/media/pulls/${pull.body.number}/merge`, owner, { merge_method: 'squash' })).status).toBe(200)

    const verify = tempDir()
    await lfsGit(verify, ['clone', '-q', remote(owner, 'owner/media'), 'media'])
    expect(new Uint8Array(readFileSync(join(verify, 'media', 'photo.bin')))).toEqual(photo)
    expect((await fetch(`${dev.url}/owner/media/media/${oid}`)).status).toBe(200)
  })
})
