import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateSigningKey } from '@git-forge/accounts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git, gitFails, tempDir } from './history.ts'
import { freePort, startWranglerDev, type WranglerDev } from './wrangler-dev.ts'

const BOOTSTRAP_TOKEN = `e2e-${crypto.randomUUID()}`

type Instance = { readonly name: string; readonly url: string; readonly dev: WranglerDev; token: string }

const names = ['alpha', 'beta', 'gamma'] as const
const instances = {} as Record<(typeof names)[number], Instance>

const lfsConfig = [
  ['filter.lfs.process', 'git-lfs filter-process'],
  ['filter.lfs.smudge', 'git-lfs smudge -- %f'],
  ['filter.lfs.clean', 'git-lfs clean -- %f'],
  ['filter.lfs.required', 'true'],
  ['lfs.locksverify', 'false'],
].flatMap(([key, value]) => ['-c', `${key}=${value}`])

const lfsGit = (cwd: string, args: readonly string[]) => git(cwd, [...lfsConfig, ...args])

const api = async (instance: Instance, method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${instance.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${instance.token}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

const expectStatus = async (response: Promise<Response>, status: number) => {
  const resolved = await response
  if (resolved.status !== status) throw new Error(`expected ${status}, got ${resolved.status}: ${await resolved.text()}`)
  return resolved
}

const repoUrl = (instance: Instance) => `${instance.url}/village/archive.git`

const withToken = (instance: Instance) => repoUrl(instance).replace('http://', `http://git:${instance.token}@`)

const lsRemote = async (instance: Instance): Promise<Map<string, string>> => {
  const output = await git(tempDir(), ['ls-remote', withToken(instance)])
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

const cron = async (instance: Instance) => {
  const response = await fetch(`${instance.url}/__scheduled?cron=${encodeURIComponent('*/30 * * * *')}`)
  expect(response.status).toBe(200)
}

type MirrorListing = { config: { remote: string }; status: { lastRun?: { startedAt: string; ok?: boolean; error?: string }; alarms: { kind: string; ref: string; archivedAs: string }[] } | null }

const mirrorStatus = async (instance: Instance, remote = 'origin') => {
  const listing = (await (await expectStatus(api(instance, 'GET', '/api/repos/village/archive/mirrors'), 200)).json()) as MirrorListing[]
  return listing.find((entry) => entry.config.remote === remote)?.status ?? null
}

const syncedByCron = async (instance: Instance) => {
  await expect
    .poll(async () => (await mirrorStatus(instance))?.lastRun, { timeout: 30_000, interval: 250 })
    .toSatisfy((run: { finishedAt?: string } | undefined) => run === undefined || run.finishedAt !== undefined)
  const before = (await mirrorStatus(instance))?.lastRun?.startedAt
  await cron(instance)
  await expect
    .poll(async () => (await mirrorStatus(instance))?.lastRun, { timeout: 30_000, interval: 250 })
    .toSatisfy((run: { ok?: boolean; startedAt?: string } | undefined) => run !== undefined && run.startedAt !== before && run.ok !== undefined)
  const run = (await mirrorStatus(instance))?.lastRun
  if (!run?.ok) throw new Error(`mirror sync on ${instance.name} failed: ${run?.error}`)
}

const lfsObject = async (instance: Instance, oid: string): Promise<Uint8Array | null> => {
  const response = await fetch(`${repoUrl(instance)}/info/lfs/objects/${oid}`, { headers: { Authorization: `Bearer ${instance.token}` } })
  if (response.status === 404) return null
  expect(response.status).toBe(200)
  return new Uint8Array(await response.arrayBuffer())
}

const lfsArrives = (instance: Instance, blob: Uint8Array) =>
  expect
    .poll(async () => {
      const stored = await lfsObject(instance, sha256(blob))
      return stored && sha256(stored)
    }, { timeout: 30_000, interval: 250 })
    .toBe(sha256(blob))

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

let source: string
let firstTip: string
let firstBlob: Buffer
let secondBlob: Buffer

beforeAll(async () => {
  const ports = await Promise.all(names.map(() => freePort()))
  const started = await Promise.all(
    names.map(async (name, index) => {
      const url = `http://127.0.0.1:${ports[index]}`
      const { privateJwk } = await generateSigningKey()
      const dev = await startWranglerDev({
        env: name,
        port: ports[index]!,
        vars: {
          BOOTSTRAP_TOKEN,
          PUBLIC_URL: url,
          INSTANCE_KEY: JSON.stringify(privateJwk),
          ALLOW_INSECURE_FEDERATION: 'true',
          MIRROR_INTERVAL_MINUTES: '0',
        },
      })
      return { name, url, dev, token: '' }
    }),
  )
  for (const instance of started) {
    instances[instance.name] = instance
    const response = await fetch(`${instance.url}/api/bootstrap`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${BOOTSTRAP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'village' }),
    })
    instance.token = ((await expectStatus(Promise.resolve(response), 201).then((r) => r.json())) as { token: string }).token
    await expectStatus(api(instance, 'POST', '/api/repos', { owner: 'village', name: 'archive' }), 201)
  }
}, 180_000)

afterAll(async () => {
  await Promise.all(Object.values(instances).map((instance) => instance.dev.stop()))
})

describe('three federated instances on wrangler dev', () => {
  it('serves its own discovery documents per environment', async () => {
    for (const instance of Object.values(instances)) {
      const config = (await (await fetch(`${instance.url}/.well-known/openid-configuration`)).json()) as { issuer: string }
      expect(config.issuer).toBe(instance.url)
    }
  })

  it('pushes a private repository with LFS content to alpha', async () => {
    const { alpha } = instances
    source = tempDir()
    await git(source, ['init', '-q', '-b', 'main'])
    await lfsGit(source, ['lfs', 'track', '*.bin'])
    firstBlob = randomBlob(200_000, 1)
    writeFileSync(join(source, 'scan.bin'), firstBlob)
    writeFileSync(join(source, 'README.md'), '# Village archive\n')
    await lfsGit(source, ['add', '-A'])
    await lfsGit(source, ['commit', '-q', '-m', 'first scan'])
    writeFileSync(join(source, 'README.md'), '# Village archive\n\nScans of the parish register.\n')
    await lfsGit(source, ['commit', '-q', '-am', 'describe'])
    await lfsGit(source, ['push', '-q', withToken(alpha), 'main'])
    firstTip = (await git(source, ['rev-parse', 'main'])).trim()
    expect((await lsRemote(alpha)).get('refs/heads/main')).toBe(firstTip)
    expect(sha256((await lfsObject(alpha, sha256(firstBlob)))!)).toBe(sha256(firstBlob))
    expect(await gitFails(tempDir(), ['clone', '-q', repoUrl(alpha), 'out'])).toMatch(/401|Authentication failed|could not read Username/i)
  })

  it('lets beta mirror alpha only after alpha trusts beta for this repository', async () => {
    const { alpha, beta } = instances
    await expectStatus(api(beta, 'POST', '/api/repos/village/archive/mirrors', { url: repoUrl(alpha), auth: 'instance' }), 201)
    await cron(beta)
    await expect.poll(async () => (await mirrorStatus(beta))?.lastRun?.error, { timeout: 30_000 }).toMatch(/401/)
    await expectStatus(api(alpha, 'POST', '/api/admin/instances', { issuer: beta.url }), 200)
    await expectStatus(api(alpha, 'POST', '/api/repos/village/archive/instances', { issuer: beta.url }), 200)
    await syncedByCron(beta)
    const refs = await lsRemote(beta)
    expect(refs.get('refs/upstream/origin/heads/main')).toBe(firstTip)
    expect(refs.get('refs/heads/main')).toBe(firstTip)
    await lfsArrives(beta, firstBlob)
  })

  it('lets gamma mirror beta, but not alpha directly', async () => {
    const { alpha, beta, gamma } = instances
    await expectStatus(api(gamma, 'POST', '/api/repos/village/archive/mirrors', { url: repoUrl(beta), auth: 'instance', namespace: 'upstream/origin/' }), 201)
    await expectStatus(api(gamma, 'POST', '/api/repos/village/archive/mirrors', { url: repoUrl(alpha), auth: 'instance', remote: 'direct', mode: 'manual' }), 201)
    await expectStatus(api(beta, 'POST', '/api/admin/instances', { issuer: gamma.url }), 200)
    await expectStatus(api(beta, 'POST', '/api/repos/village/archive/instances', { issuer: gamma.url }), 200)
    await syncedByCron(gamma)
    const refs = await lsRemote(gamma)
    expect(refs.get('refs/upstream/origin/heads/main')).toBe(firstTip)
    await lfsArrives(gamma, firstBlob)
    const direct = await api(gamma, 'POST', '/api/repos/village/archive/mirrors/direct/sync')
    expect(direct.status).toBe(502)
    expect(((await direct.json()) as { error: string }).error).toMatch(/401/)
    const clone = tempDir()
    await lfsGit(clone, ['clone', '-q', withToken(gamma), 'out'])
    await lfsGit(join(clone, 'out'), ['fetch', '-q', 'origin', 'refs/upstream/origin/heads/main'])
    expect((await git(join(clone, 'out'), ['rev-parse', 'FETCH_HEAD'])).trim()).toBe(firstTip)
  })

  it('archives rewritten history and propagates new LFS objects down the chain', async () => {
    const { alpha, beta, gamma } = instances
    await git(source, ['reset', '-q', '--hard', 'main~1'])
    secondBlob = randomBlob(150_000, 2)
    writeFileSync(join(source, 'scan2.bin'), secondBlob)
    await lfsGit(source, ['add', '-A'])
    await lfsGit(source, ['commit', '-q', '-m', 'rewritten'])
    await lfsGit(source, ['push', '-q', '--force', withToken(alpha), 'main'])
    const rewritten = (await git(source, ['rev-parse', 'main'])).trim()
    const alphaRefs = await lsRemote(alpha)
    expect(alphaRefs.get('refs/heads/main')).toBe(rewritten)
    expect([...alphaRefs].some(([ref, id]) => ref.startsWith('refs/archive/') && ref.endsWith('/heads/main') && id === firstTip)).toBe(true)

    for (const instance of [beta, gamma]) {
      await syncedByCron(instance)
      const refs = await lsRemote(instance)
      expect(refs.get('refs/upstream/origin/heads/main')).toBe(rewritten)
      const archived = [...refs].find(([ref, id]) => /^refs\/archive\/[^/]+\/upstream\/origin\/heads\/main$/.test(ref) && id === firstTip)
      expect(archived).toBeDefined()
      const status = await mirrorStatus(instance)
      expect(status?.alarms).toContainEqual(expect.objectContaining({ kind: 'history-rewritten', ref: 'refs/heads/main', archivedAs: archived![0] }))
      await lfsArrives(instance, secondBlob)
    }
  })

  it('propagates a push from alpha through beta to gamma by notifications alone', async () => {
    const { alpha, beta, gamma } = instances
    const cronTicks = () => Object.values(instances).map((instance) => instance.dev.output().split('"event":"scheduled"').length).join()
    await expectStatus(api(beta, 'POST', '/api/admin/instances', { issuer: alpha.url }), 200)
    await expectStatus(api(gamma, 'POST', '/api/admin/instances', { issuer: beta.url }), 200)
    const ticks = cronTicks()
    writeFileSync(join(source, 'notified.md'), 'arrives without cron\n')
    await lfsGit(source, ['add', '-A'])
    await lfsGit(source, ['commit', '-q', '-m', 'notified'])
    await lfsGit(source, ['push', '-q', withToken(alpha), 'main'])
    const tip = (await git(source, ['rev-parse', 'main'])).trim()
    for (const instance of [beta, gamma]) {
      await expect.poll(async () => (await lsRemote(instance)).get('refs/upstream/origin/heads/main'), { timeout: 45_000, interval: 500 }).toBe(tip)
    }
    expect(cronTicks()).toBe(ticks)
    expect(alpha.dev.output()).toContain('POST /api/federation/subscriptions')
  })
})
