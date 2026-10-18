import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { startServer } from '@git-forge/core/test/http-server.ts'
import { basicAuth, chain, httpBackendHandler, requireAuthorization } from '@git-forge/core/test/mirror-helpers.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateHistory, git, gitEnv, gitFails, tempDir } from './history.ts'
import { startWranglerDev, type WranglerDev } from './wrangler-dev.ts'

const BOOTSTRAP_TOKEN = `e2e-${crypto.randomUUID()}`

let dev: WranglerDev
let source: string
let remote: string
let pushRemote: string
let token: string

const api = (path: string, body: unknown, authorization = token) =>
  fetch(`${dev.url}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authorization}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

const log = (dir: string, ref = 'HEAD') => git(dir, ['log', '--format=%H %s', ref])

const requestsSince = (mark: number) =>
  dev
    .output()
    .slice(mark)
    .split('\n')
    .filter((line) => /\b(GET|POST|HEAD) \//.test(line))

beforeAll(async () => {
  dev = await startWranglerDev({ vars: { BOOTSTRAP_TOKEN, MAX_PUSH_BYTES: String(16 * 1024 * 1024) } })
  source = tempDir()
  await git(source, ['init', '-q', '-b', 'main'])
  generateHistory(source, { commits: 120, files: 40, binaryBytes: 48 * 1024, seed: 1 })
  remote = `${dev.url}/e2e/history.git`
}, 90_000)

afterAll(async () => {
  await dev?.stop()
})

describe('forge worker on wrangler dev', () => {
  it('bootstraps the first admin and creates a repository', async () => {
    expect((await api('/api/bootstrap', { login: 'e2e' }, 'wrong')).status).toBe(401)
    const bootstrapped = await api('/api/bootstrap', { login: 'e2e' }, BOOTSTRAP_TOKEN)
    expect(bootstrapped.status).toBe(201)
    token = ((await bootstrapped.json()) as { token: string }).token
    pushRemote = remote.replace('http://', `http://git:${token}@`)
    expect((await api('/api/bootstrap', { login: 'other' }, BOOTSTRAP_TOKEN)).status).toBe(409)
    expect((await api('/api/repos', { owner: 'e2e', name: 'history' }, 'wrong')).status).toBe(401)
    expect((await api('/api/repos', { owner: 'e2e', name: 'bad.git' })).status).toBe(400)
    const created = await api('/api/repos', { owner: 'e2e', name: 'history', visibility: 'public' })
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ owner: 'e2e', name: 'history', defaultBranch: 'main', visibility: 'public', cloneUrl: `${dev.url}/e2e/history.git` })
    expect((await api('/api/repos', { owner: 'e2e', name: 'history' })).status).toBe(409)
  })

  it('rejects pushes without a token', async () => {
    const message = await gitFails(source, ['push', remote, 'main'])
    expect(message).toMatch(/401|Authentication failed|could not read Username/i)
  })

  it('keeps repositories private by default', async () => {
    expect((await api('/api/repos', { owner: 'e2e', name: 'private' })).status).toBe(201)
    expect(await gitFails(tempDir(), ['clone', '-q', `${dev.url}/e2e/private.git`, 'out'])).toMatch(/401|Authentication failed|could not read Username/i)
    await git(tempDir(), ['clone', '-q', `${dev.url}/e2e/private.git`.replace('http://', `http://git:${token}@`), 'out'])
  })

  it('accepts a push of a generated history with the real git client', async () => {
    const started = performance.now()
    await git(source, ['push', pushRemote, 'main'])
    console.log(`push of 120 commits took ${Math.round(performance.now() - started)} ms wall time`)
    expect(await git(source, ['ls-remote', remote])).toContain('refs/heads/main')
  })

  it('clones with protocol v2', async () => {
    const mark = dev.output().length
    const target = tempDir()
    await git(target, ['-c', 'protocol.version=2', 'clone', '-q', remote, 'out'])
    expect(await log(`${target}/out`)).toBe(await log(source))
    expect(await git(`${target}/out`, ['fsck', '--full', '--strict'])).toBe('')
    expect(requestsSince(mark).some((line) => line.includes('/git-upload-pack'))).toBe(true)
  })

  it('clones over dumb HTTP with protocol v0', async () => {
    const mark = dev.output().length
    const target = tempDir()
    await git(target, ['-c', 'protocol.version=0', 'clone', '-q', remote, 'out'])
    expect(await log(`${target}/out`)).toBe(await log(source))
    expect(await git(`${target}/out`, ['fsck', '--full', '--strict'])).toBe('')
    const requests = requestsSince(mark)
    expect(requests.some((line) => /\/objects\/pack\/pack-[0-9a-f]{40}\.pack/.test(line))).toBe(true)
    expect(requests.some((line) => line.includes('/git-upload-pack'))).toBe(false)
  })

  it('accepts an incremental push and serves it to an existing clone', async () => {
    const target = tempDir()
    await git(target, ['clone', '-q', remote, 'out'])
    generateHistory(source, { commits: 15, files: 40, binaryBytes: 8 * 1024, seed: 2, from: 'refs/heads/main^0' })
    await git(source, ['push', pushRemote, 'main'])
    await git(`${target}/out`, ['pull', '-q', '--ff-only'])
    expect(await log(`${target}/out`)).toBe(await log(source))
    const dumb = tempDir()
    await git(dumb, ['-c', 'protocol.version=0', 'clone', '-q', remote, 'out'])
    expect(await log(`${dumb}/out`)).toBe(await log(source))
  })

  it('archives the previous tip under refs/archive/ on a force push', async () => {
    const previous = (await git(source, ['rev-parse', 'main'])).trim()
    const base = (await git(source, ['rev-parse', 'main~20'])).trim()
    await git(source, ['update-ref', 'refs/heads/main', base])
    generateHistory(source, { commits: 3, files: 40, binaryBytes: 1024, seed: 3, from: base })
    const rewritten = (await git(source, ['rev-parse', 'main'])).trim()
    expect(await gitFails(source, ['push', pushRemote, 'main'])).toMatch(/rejected|non-fast-forward|fetch first/)
    await git(source, ['push', '--force', pushRemote, 'main'])
    const refs = await git(source, ['ls-remote', remote])
    expect(refs).toContain(`${rewritten}\trefs/heads/main`)
    const archived = refs.split('\n').find((line) => line.startsWith(previous) && line.includes('\trefs/archive/'))
    expect(archived).toMatch(/\trefs\/archive\/\d{4}-\d{2}-\d{2}T[\d-]+Z\/heads\/main$/)
    const target = tempDir()
    await git(target, ['clone', '-q', remote, 'out'])
    expect((await git(`${target}/out`, ['rev-parse', 'HEAD'])).trim()).toBe(rewritten)
    await git(`${target}/out`, ['fetch', '-q', 'origin', archived!.split('\t')[1]!])
    expect((await git(`${target}/out`, ['rev-parse', 'FETCH_HEAD'])).trim()).toBe(previous)
    expect(await gitFails(source, ['push', pushRemote, `${rewritten}:${archived!.split('\t')[1]!}`])).toMatch(/invalid ref name|rejected/)
  })

  it('imports a repository from a git http server through the queue', async () => {
    const root = tempDir()
    await git(root, ['clone', '-q', '--bare', source, 'upstream.git'])
    await git(`${root}/upstream.git`, ['config', 'uploadpack.allowFilter', 'true'])
    const upstream = await startServer(chain(requireAuthorization(basicAuth('git', 'upstream-token')), httpBackendHandler(root)))
    try {
      const response = await api('/api/repos/e2e/imported/import', { url: `${upstream.url}/upstream.git`, token: 'upstream-token', commitsPerStep: 40 })
      expect(response.status).toBe(202)
      const status = async () =>
        (await (await fetch(`${dev.url}/api/repos/e2e/imported/import`, { headers: { Authorization: `Bearer ${token}` } })).json()) as {
          phase: string
          steps: number
          stepped: boolean
          error?: string
        }
      await expect.poll(async () => (await status()).phase, { timeout: 50_000, interval: 500 }).toBe('done')
      const final = await status()
      expect(final.stepped).toBe(true)
      expect(final.steps).toBeGreaterThan(4)
      const target = tempDir()
      await git(target, ['clone', '-q', '--mirror', `${dev.url}/e2e/imported.git`.replace('http://', `http://git:${token}@`), 'out.git'])
      expect(await git(`${target}/out.git`, ['fsck', '--full', '--strict'])).toBe('')
      const heads = async (dir: string) => git(dir, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags'])
      expect(await heads(`${target}/out.git`)).toBe(await heads(`${root}/upstream.git`))
    } finally {
      await upstream.close()
    }
  })

  it('streams a push larger than a staging chunk, compacts its packs and serves packfile URIs', async () => {
    expect((await api('/api/repos', { owner: 'e2e', name: 'streamed', visibility: 'public' })).status).toBe(201)
    const streamed = tempDir()
    await git(streamed, ['init', '-q', '-b', 'main'])
    generateHistory(streamed, { commits: 40, files: 20, binaryBytes: 3 * 1024 * 1024, seed: 5 })
    const streamedRemote = `${dev.url}/e2e/streamed.git`
    const streamedPush = streamedRemote.replace('http://', `http://git:${token}@`)
    const started = performance.now()
    await git(streamed, ['push', '-q', streamedPush, 'main'])
    console.log(`push of a 12 MiB pack took ${Math.round(performance.now() - started)} ms wall time`)
    for (let round = 0; round < 3; round++) {
      generateHistory(streamed, { commits: 5, files: 20, binaryBytes: 1024, seed: 6 + round, from: 'refs/heads/main^0' })
      await git(streamed, ['push', '-q', streamedPush, 'main'])
    }
    const packCount = async () => (await (await fetch(`${streamedRemote}/objects/info/packs`)).text()).split('\n').filter((line) => line.startsWith('P ')).length
    await expect.poll(packCount, { timeout: 20_000 }).toBeLessThan(4)
    const mark = dev.output().length
    const target = tempDir()
    await git(target, ['-c', 'fetch.uriProtocols=http', 'clone', '-q', streamedRemote, 'out'])
    expect(await log(`${target}/out`)).toBe(await log(streamed))
    expect(await git(`${target}/out`, ['fsck', '--full', '--strict'])).toBe('')
    expect(requestsSince(mark).some((line) => /GET \/e2e\/streamed\.git\/objects\/pack\/pack-[0-9a-f]{40}\.pack/.test(line))).toBe(true)
    const dumb = tempDir()
    await git(dumb, ['-c', 'protocol.version=0', 'clone', '-q', streamedRemote, 'out'])
    expect(await git(`${dumb}/out`, ['fsck', '--full', '--strict'])).toBe('')
  }, 120_000)

  it('splits a push above the worker limit with git forge push', async () => {
    expect((await api('/api/repos', { owner: 'e2e', name: 'large' })).status).toBe(201)
    const large = tempDir()
    await git(large, ['init', '-q', '-b', 'main'])
    for (let i = 0; i < 12; i++) {
      writeFileSync(`${large}/blob-${i}.bin`, randomBytes(2 * 1024 * 1024))
      await git(large, ['add', '-A'])
      await git(large, ['commit', '-q', '-m', `large ${i}`])
    }
    const url = `${dev.url}/e2e/large.git`.replace('http://', `http://git:${token}@`)
    const plain = await promisify(execFile)('git', ['push', url, 'main'], { cwd: large, env: { ...process.env, ...gitEnv }, timeout: 30_000 }).then(
      () => 'unexpectedly succeeded',
      (error: { stderr?: string; killed?: boolean }) => (error.killed ? 'killed after 30 s' : String(error.stderr)),
    )
    expect(plain).toMatch(/413|exceeds|RPC failed|unexpected disconnect|killed after 30 s/i)
    const cli = resolve(import.meta.dirname, '../../../../packages/cli/src/main.ts')
    const { stderr } = await promisify(execFile)(process.execPath, ['--no-warnings', cli, 'push', '--max-bytes', '8MiB', url, 'main'], {
      cwd: large,
      env: { ...process.env, ...gitEnv },
      timeout: 150_000,
    })
    expect(stderr).toContain('chunk 2')
    expect(await git(large, ['ls-remote', url, 'refs/heads/main'])).toContain((await git(large, ['rev-parse', 'main'])).trim())
  }, 240_000)

  it('runs the scheduled mirror sync', async () => {
    const response = await fetch(`${dev.url}/__scheduled?cron=${encodeURIComponent('*/30 * * * *')}`)
    expect(response.status).toBe(200)
    await expect.poll(() => dev.output()).toContain('"task":"mirror-sync","runs":[]')
  })
})
