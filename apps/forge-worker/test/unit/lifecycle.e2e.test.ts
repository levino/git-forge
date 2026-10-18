import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git, tempDir } from '../e2e/history.ts'
import { bootstrap, call, type NodeForge, nodeForge } from '../support/node-forge.ts'

const lfsConfig = [
  ['filter.lfs.process', 'git-lfs filter-process'],
  ['filter.lfs.smudge', 'git-lfs smudge -- %f'],
  ['filter.lfs.clean', 'git-lfs clean -- %f'],
  ['filter.lfs.required', 'true'],
  ['lfs.locksverify', 'false'],
].flatMap(([key, value]) => ['-c', `${key}=${value}`])

const lfsGit = (cwd: string, args: readonly string[]) => git(cwd, [...lfsConfig, ...args])

describe('renaming a repository with the real git and git-lfs clients', () => {
  let forge: NodeForge
  let server: RunningServer
  let token: string
  const url = (name: string) => `${server.url.replace('http://', `http://git:${token}@`)}/admin/${name}.git`

  beforeAll(async () => {
    forge = await nodeForge({ maxPushBytes: 16 * 1024 * 1024 })
    server = await startServer((request) => forge.fetch(request))
    token = await bootstrap(forge, server.url)
    expect((await call(forge, server.url, 'POST', '/api/repos', token, { owner: 'admin', name: 'assets' })).status).toBe(201)
  })

  afterAll(async () => {
    await server?.close()
  })

  it('pushes and clones through the old and the new URL', async () => {
    const first = randomBytes(200 * 1024)
    const second = randomBytes(150 * 1024)
    const source = tempDir()
    await git(source, ['init', '-q', '-b', 'main'])
    await lfsGit(source, ['lfs', 'track', '*.bin'])
    writeFileSync(`${source}/first.bin`, first)
    await lfsGit(source, ['add', '-A'])
    await lfsGit(source, ['commit', '-q', '-m', 'first'])
    await lfsGit(source, ['push', '-q', url('assets'), 'main'])

    expect((await call(forge, server.url, 'PATCH', '/api/repos/admin/assets', token, { name: 'media' })).status).toBe(200)

    const old = tempDir()
    await lfsGit(old, ['clone', '-q', url('assets'), 'out'])
    expect(readFileSync(`${old}/out/first.bin`).equals(first)).toBe(true)
    writeFileSync(`${old}/out/second.bin`, second)
    await lfsGit(`${old}/out`, ['add', '-A'])
    await lfsGit(`${old}/out`, ['commit', '-q', '-m', 'second'])
    await lfsGit(`${old}/out`, ['push', '-q', 'origin', 'main'])

    const renamed = tempDir()
    await lfsGit(renamed, ['clone', '-q', url('media'), 'out'])
    expect(readFileSync(`${renamed}/out/first.bin`).equals(first)).toBe(true)
    expect(readFileSync(`${renamed}/out/second.bin`).equals(second)).toBe(true)
    expect(await git(`${renamed}/out`, ['log', '--format=%s'])).toBe('second\nfirst\n')
    expect(server.requests.some((request) => request.status === 301 && request.path.startsWith('/admin/assets.git/'))).toBe(true)
    expect(server.requests.some((request) => request.status === 307 && request.path === '/admin/assets.git/info/lfs/objects/batch')).toBe(true)

    const stored: string[] = []
    for await (const info of forge.storage.list('repos/admin/')) stored.push(info.key)
    expect(stored.some((key) => key.startsWith('repos/admin/media/'))).toBe(false)
    expect(stored.filter((key) => key.startsWith('repos/admin/assets/lfs/objects/'))).toHaveLength(2)
  })
})
