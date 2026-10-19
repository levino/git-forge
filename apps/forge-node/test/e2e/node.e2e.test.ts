import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSigningKey } from '@git-forge/accounts'
import { git, gitFails, tempDir } from 'forge-worker/test/e2e/history.ts'
import { freePort, startWranglerDev, type WranglerDev } from 'forge-worker/test/e2e/wrangler-dev.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type NodeProcess, runCommand, startNodeInstance } from './node-process.ts'

const BOOTSTRAP_TOKEN = `e2e-${crypto.randomUUID()}`

type Instance = { readonly name: string; readonly url: string; token: string; readonly output: () => string }

const lfsConfig = [
  ['filter.lfs.process', 'git-lfs filter-process'],
  ['filter.lfs.smudge', 'git-lfs smudge -- %f'],
  ['filter.lfs.clean', 'git-lfs clean -- %f'],
  ['filter.lfs.required', 'true'],
  ['lfs.locksverify', 'false'],
].flatMap(([key, value]) => ['-c', `${key}=${value}`])

const lfsGit = (cwd: string, args: readonly string[]) => git(cwd, [...lfsConfig, ...args])

const api = (instance: Instance, method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${instance.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${instance.token}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

const expectStatus = async (response: Promise<Response>, status: number): Promise<Response> => {
  const resolved = await response
  if (resolved.status !== status) throw new Error(`expected ${status}, got ${resolved.status}: ${await resolved.text()}`)
  return resolved
}

const repoUrl = (instance: Instance, repository: string) => `${instance.url}/${repository}.git`

const withToken = (instance: Instance, repository: string) => repoUrl(instance, repository).replace('http://', `http://git:${instance.token}@`)

const lsRemote = async (instance: Instance, repository: string): Promise<Map<string, string>> => {
  const output = await git(tempDir(), ['ls-remote', withToken(instance, repository)])
  return new Map(
    output
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [id, ref] = line.split('\t') as [string, string]
        return [ref, id]
      }),
  )
}

const lfsObject = async (instance: Instance, repository: string, oid: string): Promise<Uint8Array | null> => {
  const response = await fetch(`${repoUrl(instance, repository)}/info/lfs/objects/${oid}`, { headers: { Authorization: `Bearer ${instance.token}` } })
  if (response.status === 404) return null
  expect(response.status).toBe(200)
  return new Uint8Array(await response.arrayBuffer())
}

const randomBlob = (size: number, seed: number): Buffer => {
  const out = Buffer.alloc(size)
  let x = seed
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    out[i] = x >>> 24
  }
  return out
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

const bootstrap = async (url: string): Promise<string> => {
  const response = await expectStatus(
    fetch(`${url}/api/bootstrap`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${BOOTSTRAP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'village' }),
    }),
    201,
  )
  return ((await response.json()) as { token: string }).token
}

const scheduledRuns = (instance: Instance) => instance.output().split('"event":"scheduled"').length - 1

let dev: WranglerDev
let pi: NodeProcess
let worker: Instance
let node: Instance
let nodeEnv: Record<string, string> & { PORT: string }
let source: string
let localSource: string

beforeAll(async () => {
  const [workerPort, nodePort] = await Promise.all([freePort(), freePort()])
  const workerUrl = `http://127.0.0.1:${workerPort}`
  const nodeUrl = `http://127.0.0.1:${nodePort}`
  const [workerKey, nodeKey] = await Promise.all([generateSigningKey(), generateSigningKey()])
  nodeEnv = {
    PORT: String(nodePort),
    DATA_DIR: mkdtempSync(join(tmpdir(), 'git-forge-node-e2e-')),
    BOOTSTRAP_TOKEN,
    PUBLIC_URL: nodeUrl,
    INSTANCE_KEY: JSON.stringify(nodeKey.privateJwk),
    ALLOW_INSECURE_FEDERATION: 'true',
    ALLOW_PRIVATE_REMOTES: 'true',
    MIRROR_INTERVAL_MINUTES: '0',
    MAX_PUSH_BYTES: String(64 * 1024 * 1024),
  }
  const migrated = await runCommand(['migrate'], nodeEnv)
  expect(migrated.stdout).toContain('"0001_initial"')
  ;[dev, pi] = await Promise.all([
    startWranglerDev({
      env: 'alpha',
      port: workerPort,
      vars: { BOOTSTRAP_TOKEN, PUBLIC_URL: workerUrl, INSTANCE_KEY: JSON.stringify(workerKey.privateJwk), ALLOW_INSECURE_FEDERATION: 'true', ALLOW_PRIVATE_REMOTES: 'true', MIRROR_INTERVAL_MINUTES: '0' },
    }),
    startNodeInstance(nodeEnv),
  ])
  worker = { name: 'worker', url: workerUrl, token: await bootstrap(workerUrl), output: () => dev.output() }
  node = { name: 'node', url: nodeUrl, token: await bootstrap(nodeUrl), output: () => pi.output() }
  for (const [instance, repository] of [
    [worker, 'archive'],
    [worker, 'back'],
    [node, 'archive'],
    [node, 'local'],
  ] as const) {
    await expectStatus(api(instance, 'POST', '/api/repos', { owner: 'village', name: repository }), 201)
  }
  await expectStatus(api(worker, 'POST', '/api/admin/instances', { issuer: node.url }), 200)
  await expectStatus(api(worker, 'POST', '/api/repos/village/archive/instances', { issuer: node.url }), 200)
  await expectStatus(api(node, 'POST', '/api/admin/instances', { issuer: worker.url }), 200)
  await expectStatus(api(node, 'POST', '/api/repos/village/local/instances', { issuer: worker.url }), 200)
}, 180_000)

afterAll(async () => {
  await Promise.all([dev?.stop(), pi?.stop()])
})

describe('git-forge-node next to a Worker on wrangler dev', () => {
  it('serves pushes and clones with Git LFS on the Node instance', async () => {
    localSource = tempDir()
    await git(localSource, ['init', '-q', '-b', 'main'])
    await lfsGit(localSource, ['lfs', 'track', '*.bin'])
    const blob = randomBlob(300_000, 7)
    writeFileSync(join(localSource, 'photo.bin'), blob)
    writeFileSync(join(localSource, 'README.md'), '# Pi\n')
    await lfsGit(localSource, ['add', '-A'])
    await lfsGit(localSource, ['commit', '-q', '-m', 'on the pi'])
    expect(await gitFails(localSource, ['push', repoUrl(node, 'village/local'), 'main'])).toMatch(/401|Authentication failed|could not read Username/i)
    await lfsGit(localSource, ['push', '-q', withToken(node, 'village/local'), 'main'])
    const tip = (await git(localSource, ['rev-parse', 'main'])).trim()

    const smart = tempDir()
    await lfsGit(smart, ['-c', 'protocol.version=2', 'clone', '-q', withToken(node, 'village/local'), 'out'])
    expect((await git(join(smart, 'out'), ['rev-parse', 'HEAD'])).trim()).toBe(tip)
    expect(await git(join(smart, 'out'), ['fsck', '--full', '--strict'])).toBe('')
    expect(sha256(readFileSync(join(smart, 'out', 'photo.bin')))).toBe(sha256(blob))

    const dumb = tempDir()
    await git(dumb, ['-c', 'protocol.version=0', 'clone', '-q', withToken(node, 'village/local'), 'out'])
    expect((await git(join(dumb, 'out'), ['rev-parse', 'HEAD'])).trim()).toBe(tip)
    expect(sha256((await lfsObject(node, 'village/local', sha256(blob)))!)).toBe(sha256(blob))
  })

  it('mirrors a Worker repository, including LFS objects', async () => {
    source = tempDir()
    await git(source, ['init', '-q', '-b', 'main'])
    await lfsGit(source, ['lfs', 'track', '*.bin'])
    const blob = randomBlob(200_000, 1)
    writeFileSync(join(source, 'scan.bin'), blob)
    writeFileSync(join(source, 'README.md'), '# Village archive\n')
    await lfsGit(source, ['add', '-A'])
    await lfsGit(source, ['commit', '-q', '-m', 'first scan'])
    await lfsGit(source, ['push', '-q', withToken(worker, 'village/archive'), 'main'])
    const tip = (await git(source, ['rev-parse', 'main'])).trim()

    await expectStatus(api(node, 'POST', '/api/repos/village/archive/mirrors', { url: repoUrl(worker, 'village/archive'), auth: 'instance' }), 201)
    await expect.poll(async () => (await lsRemote(node, 'village/archive')).get('refs/upstream/origin/heads/main'), { timeout: 45_000, interval: 250 }).toBe(tip)
    expect(sha256((await lfsObject(node, 'village/archive', sha256(blob)))!)).toBe(sha256(blob))
    const clone = tempDir()
    await lfsGit(clone, ['clone', '-q', withToken(node, 'village/archive'), 'out'])
    expect((await git(join(clone, 'out'), ['rev-parse', 'HEAD'])).trim()).toBe(tip)
    await expect.poll(() => dev.output(), { timeout: 15_000 }).toContain('POST /api/federation/subscriptions')
  })

  it('follows pushes to the Worker by notification, without a scheduled run', async () => {
    const ticks = scheduledRuns(node)
    const blob = randomBlob(150_000, 2)
    writeFileSync(join(source, 'scan2.bin'), blob)
    await lfsGit(source, ['add', '-A'])
    await lfsGit(source, ['commit', '-q', '-m', 'second scan'])
    await lfsGit(source, ['push', '-q', withToken(worker, 'village/archive'), 'main'])
    const tip = (await git(source, ['rev-parse', 'main'])).trim()
    await expect.poll(async () => (await lsRemote(node, 'village/archive')).get('refs/upstream/origin/heads/main'), { timeout: 45_000, interval: 250 }).toBe(tip)
    expect(sha256((await lfsObject(node, 'village/archive', sha256(blob)))!)).toBe(sha256(blob))
    expect(scheduledRuns(node)).toBe(ticks)
    expect(node.output()).toContain('"kind":"mirror-sync"')
    expect(node.output()).toContain('"reason":"notification"')
  })

  it('is mirrored back by the Worker and notifies it on push', async () => {
    await expectStatus(api(worker, 'POST', '/api/repos/village/back/mirrors', { url: repoUrl(node, 'village/local'), auth: 'instance' }), 201)
    const first = (await git(localSource, ['rev-parse', 'main'])).trim()
    await expect.poll(async () => (await lsRemote(worker, 'village/back')).get('refs/upstream/origin/heads/main'), { timeout: 45_000, interval: 250 }).toBe(first)
    await expect.poll(() => node.output(), { timeout: 15_000 }).toContain('"kind":"mirror-subscribe"')
    writeFileSync(join(localSource, 'notes.md'), 'pushed to the pi\n')
    await lfsGit(localSource, ['add', '-A'])
    await lfsGit(localSource, ['commit', '-q', '-m', 'second on the pi'])
    await lfsGit(localSource, ['push', '-q', withToken(node, 'village/local'), 'main'])
    const tip = (await git(localSource, ['rev-parse', 'main'])).trim()
    await expect.poll(async () => (await lsRemote(worker, 'village/back')).get('refs/upstream/origin/heads/main'), { timeout: 45_000, interval: 250 }).toBe(tip)
    expect(node.output()).toContain('"kind":"mirror-notify"')
  })

  it('stops gracefully and keeps its data across restarts', async () => {
    expect(await pi.stop()).toBe(0)
    expect(pi.output()).toContain('"event":"stopped"')
    pi = await startNodeInstance(nodeEnv)
    node = { ...node, output: () => pi.output() }
    const tip = (await git(localSource, ['rev-parse', 'main'])).trim()
    expect((await lsRemote(node, 'village/local')).get('refs/heads/main')).toBe(tip)
    expect((await lsRemote(node, 'village/archive')).get('refs/upstream/origin/heads/main')).toBe((await git(source, ['rev-parse', 'main'])).trim())
  })
})
