import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateHistory, git, gitFails, tempDir } from './history.ts'
import { startWranglerDev, type WranglerDev } from './wrangler-dev.ts'

const ADMIN_TOKEN = `e2e-${crypto.randomUUID()}`

let dev: WranglerDev
let source: string
let remote: string
let pushRemote: string

const admin = (body: unknown, token = ADMIN_TOKEN) =>
  fetch(`${dev.url}/api/admin/repos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
  dev = await startWranglerDev({ ADMIN_TOKEN })
  source = tempDir()
  await git(source, ['init', '-q', '-b', 'main'])
  generateHistory(source, { commits: 120, files: 40, binaryBytes: 48 * 1024, seed: 1 })
  remote = `${dev.url}/e2e/history.git`
  pushRemote = remote.replace('http://', `http://git:${ADMIN_TOKEN}@`)
}, 90_000)

afterAll(async () => {
  await dev?.stop()
})

describe('forge worker on wrangler dev', () => {
  it('protects the admin endpoint and creates a repository', async () => {
    expect((await admin({ owner: 'e2e', name: 'history' }, 'wrong')).status).toBe(401)
    expect((await admin({ owner: 'e2e', name: 'bad.git' })).status).toBe(400)
    const created = await admin({ owner: 'e2e', name: 'history' })
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ owner: 'e2e', name: 'history', defaultBranch: 'main', cloneUrl: `${dev.url}/e2e/history.git` })
    expect((await admin({ owner: 'e2e', name: 'history' })).status).toBe(409)
  })

  it('rejects pushes without the token', async () => {
    const message = await gitFails(source, ['push', remote, 'main'])
    expect(message).toMatch(/401|Authentication failed|could not read Username/i)
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

  it('streams a push larger than a staging chunk, compacts its packs and serves packfile URIs', async () => {
    expect((await admin({ owner: 'e2e', name: 'large' })).status).toBe(201)
    const large = tempDir()
    await git(large, ['init', '-q', '-b', 'main'])
    generateHistory(large, { commits: 40, files: 20, binaryBytes: 3 * 1024 * 1024, seed: 5 })
    const largeRemote = `${dev.url}/e2e/large.git`
    const largePush = largeRemote.replace('http://', `http://git:${ADMIN_TOKEN}@`)
    const started = performance.now()
    await git(large, ['push', '-q', largePush, 'main'])
    console.log(`push of a 12 MiB pack took ${Math.round(performance.now() - started)} ms wall time`)
    for (let round = 0; round < 3; round++) {
      generateHistory(large, { commits: 5, files: 20, binaryBytes: 1024, seed: 6 + round, from: 'refs/heads/main^0' })
      await git(large, ['push', '-q', largePush, 'main'])
    }
    const packCount = async () => (await (await fetch(`${largeRemote}/objects/info/packs`)).text()).split('\n').filter((line) => line.startsWith('P ')).length
    await expect.poll(packCount, { timeout: 20_000 }).toBeLessThan(4)
    const mark = dev.output().length
    const target = tempDir()
    await git(target, ['-c', 'fetch.uriProtocols=http', 'clone', '-q', largeRemote, 'out'])
    expect(await log(`${target}/out`)).toBe(await log(large))
    expect(await git(`${target}/out`, ['fsck', '--full', '--strict'])).toBe('')
    expect(requestsSince(mark).some((line) => /GET \/e2e\/large\.git\/objects\/pack\/pack-[0-9a-f]{40}\.pack/.test(line))).toBe(true)
    const dumb = tempDir()
    await git(dumb, ['-c', 'protocol.version=0', 'clone', '-q', largeRemote, 'out'])
    expect(await git(`${dumb}/out`, ['fsck', '--full', '--strict'])).toBe('')
  }, 120_000)

  it('runs the scheduled handler stub', async () => {
    const response = await fetch(`${dev.url}/__scheduled?cron=${encodeURIComponent('*/30 * * * *')}`)
    expect(response.status).toBe(200)
    await expect.poll(() => dev.output()).toContain('"task":"mirror-sync"')
  })
})
