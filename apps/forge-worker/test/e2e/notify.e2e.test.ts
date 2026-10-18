import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateSigningKey, mintMirrorNotification } from '@git-forge/accounts'
import { gitPrefix, lfsObjectKey, readAll, readMirrorStatus, readRefs, type RepositoryName, type Storage } from '@git-forge/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Instance, quiesce, startInstance } from '../support/federated-instance.ts'
import { git, tempDir } from './history.ts'

const repo: RepositoryName = { owner: 'village', name: 'archive' }
const repository = 'village/archive'

const lfsConfig = [
  ['filter.lfs.process', 'git-lfs filter-process'],
  ['filter.lfs.smudge', 'git-lfs smudge -- %f'],
  ['filter.lfs.clean', 'git-lfs clean -- %f'],
  ['filter.lfs.required', 'true'],
  ['lfs.locksverify', 'false'],
].flatMap(([key, value]) => ['-c', `${key}=${value}`])

const lfsGit = (cwd: string, args: readonly string[]) => git(cwd, [...lfsConfig, ...args])

let alpha: Instance
let beta: Instance
let gamma: Instance
let source: string

const expectStatus = async (response: Promise<Response>, status: number): Promise<Response> => {
  const resolved = await response
  if (resolved.status !== status) throw new Error(`expected ${status}, got ${resolved.status}: ${await resolved.text()}`)
  return resolved
}

const repoUrl = (instance: Instance) => instance.gitUrl(repository)

const pushUrl = (instance: Instance) => instance.gitUrl(repository, true)

const refs = async (instance: Instance) => (await readRefs(instance.storage, repo))?.state.refs ?? {}

const packFiles = async (storage: Storage): Promise<Map<string, string>> => {
  const files = new Map<string, string>()
  const prefix = `${gitPrefix(repo)}objects/pack/`
  for await (const info of storage.list(prefix)) {
    const object = await storage.get(info.key)
    if (object) files.set(info.key.slice(prefix.length), createHash('sha256').update(await readAll(object.body)).digest('hex'))
  }
  return files
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

const scheduledRequests = (instance: Instance) => instance.requests.filter((request) => request.path === '/__scheduled').length

const jobsOf = (instance: Instance, kind: string) => instance.invocations.filter((invocation) => invocation.kind === 'job' && invocation.label === kind).length

const notify = (target: Instance, token: string, remote = 'origin') =>
  fetch(`${target.url}/api/federation/notify/${repository}/${remote}`, { method: 'POST', headers: { 'Content-Type': 'application/jwt' }, body: token })

beforeAll(async () => {
  ;[alpha, beta, gamma] = await Promise.all([startInstance('alpha'), startInstance('beta'), startInstance('gamma')])
  for (const instance of [alpha, beta, gamma]) {
    await expectStatus(instance.api('POST', '/api/repos', { owner: repo.owner, name: repo.name }), 201)
  }
  await expectStatus(alpha.api('POST', '/api/admin/instances', { issuer: beta.url }), 200)
  await expectStatus(alpha.api('POST', `/api/repos/${repository}/instances`, { issuer: beta.url }), 200)
  await expectStatus(beta.api('POST', '/api/admin/instances', { issuer: alpha.url }), 200)
  await expectStatus(beta.api('POST', '/api/admin/instances', { issuer: gamma.url }), 200)
  await expectStatus(beta.api('POST', `/api/repos/${repository}/instances`, { issuer: gamma.url }), 200)
  await expectStatus(gamma.api('POST', '/api/admin/instances', { issuer: beta.url }), 200)
}, 60_000)

afterAll(async () => {
  await Promise.all([alpha, beta, gamma].filter(Boolean).map((instance) => instance.close()))
})

describe('push-notified mirror sync across three instances', () => {
  it('subscribes mirrors at their upstream when they are configured', async () => {
    await expectStatus(beta.api('POST', `/api/repos/${repository}/mirrors`, { url: repoUrl(alpha), auth: 'instance' }), 201)
    await expectStatus(gamma.api('POST', `/api/repos/${repository}/mirrors`, { url: repoUrl(beta), auth: 'instance', namespace: 'upstream/origin/' }), 201)
    await quiesce([alpha, beta, gamma])
    expect(await alpha.store.mirrorSubscriptions(repository)).toEqual([
      { issuer: beta.url, repository, callback: `${beta.url}/api/federation/notify/${repository}/origin` },
    ])
    expect(await beta.store.mirrorSubscriptions(repository)).toEqual([
      { issuer: gamma.url, repository, callback: `${gamma.url}/api/federation/notify/${repository}/origin` },
    ])
    expect(beta.jobs.failed).toEqual([])
    expect(gamma.jobs.failed).toEqual([])
  })

  it('propagates a push from alpha through beta to gamma without any cron run', async () => {
    source = tempDir()
    await git(source, ['init', '-q', '-b', 'main'])
    await lfsGit(source, ['lfs', 'track', '*.bin'])
    const scan = randomBlob(120_000, 1)
    writeFileSync(join(source, 'scan.bin'), scan)
    writeFileSync(join(source, 'README.md'), '# Village archive\n')
    await lfsGit(source, ['add', '-A'])
    await lfsGit(source, ['commit', '-q', '-m', 'first scan'])
    alpha.failNextFetches((request) => request.url.includes('/api/federation/notify/'), 1)
    await lfsGit(source, ['push', '-q', pushUrl(alpha), 'main'])
    const tip = (await git(source, ['rev-parse', 'main'])).trim()
    await quiesce([alpha, beta, gamma])

    expect((await refs(beta))['refs/upstream/origin/heads/main']).toBe(tip)
    expect((await refs(gamma))['refs/upstream/origin/heads/main']).toBe(tip)
    const deliveries = alpha.invocations.filter((invocation) => invocation.label === 'mirror-notify')
    expect(deliveries.map((delivery) => delivery.ok)).toEqual([false, true])
    expect(alpha.jobs.failed).toEqual([])
    for (const instance of [alpha, beta, gamma]) expect(scheduledRequests(instance)).toBe(0)

    for (const instance of [beta, gamma]) {
      const stored = await instance.storage.get(lfsObjectKey(repo, sha256(scan)))
      expect(stored && sha256(await readAll(stored.body))).toBe(sha256(scan))
    }
    const clone = tempDir()
    await git(clone, ['init', '-q', '--bare'])
    await git(clone, ['fetch', '-q', pushUrl(gamma), '+refs/upstream/*:refs/upstream/*'])
    expect(await git(clone, ['fsck', '--full', '--strict', '--no-dangling'])).toBe('')
  })

  it('copies packs byte for byte down the chain', async () => {
    const upstream = await packFiles(alpha.storage)
    expect(upstream.size).toBeGreaterThanOrEqual(2)
    expect(await packFiles(beta.storage)).toEqual(upstream)
    expect(await packFiles(gamma.storage)).toEqual(upstream)
    const status = await readMirrorStatus(beta.storage, repo)
    expect(status?.lastRun?.ok).toBe(true)
  })

  it('treats duplicate notifications as no-ops', async () => {
    const syncsBefore = jobsOf(beta, 'mirror-sync')
    const token = await mintMirrorNotification({ key: alpha.key, issuer: alpha.url, audience: beta.url, repository, refs: await refs(alpha) })
    for (let i = 0; i < 3; i++) {
      const response = await expectStatus(notify(beta, token), 200)
      expect(await response.json()).toEqual({ status: 'up-to-date' })
    }
    const stale = await mintMirrorNotification({ key: alpha.key, issuer: alpha.url, audience: beta.url, repository, refs: { 'refs/heads/main': '1'.repeat(40) } })
    await expectStatus(notify(beta, stale), 202)
    await expectStatus(notify(beta, stale), 202)
    await quiesce([alpha, beta, gamma])
    expect(jobsOf(beta, 'mirror-sync') - syncsBefore).toBe(2)
    expect(beta.jobs.failed).toEqual([])
    const gammaSyncs = jobsOf(gamma, 'mirror-sync')
    await quiesce([gamma])
    expect(jobsOf(gamma, 'mirror-sync')).toBe(gammaSyncs)
  })

  it('rejects notifications from untrusted issuers, forged signatures and foreign repositories', async () => {
    const { key: mallory } = await generateSigningKey()
    const refsNow = await refs(alpha)
    const untrusted = await mintMirrorNotification({ key: mallory, issuer: 'http://127.0.0.1:9', audience: beta.url, repository, refs: refsNow })
    expect(await (await expectStatus(notify(beta, untrusted), 401)).json()).toEqual({ error: 'notification rejected: unknown-issuer' })
    await expectStatus(notify(beta, untrusted, 'nope'), 401)
    const forged = await mintMirrorNotification({ key: mallory, issuer: alpha.url, audience: beta.url, repository, refs: refsNow })
    expect(await (await expectStatus(notify(beta, forged), 401)).json()).toEqual({ error: 'notification rejected: unknown-key' })
    const wrongAudience = await mintMirrorNotification({ key: alpha.key, issuer: alpha.url, audience: gamma.url, repository, refs: refsNow })
    await expectStatus(notify(beta, wrongAudience), 401)
    const foreign = await mintMirrorNotification({ key: gamma.key, issuer: gamma.url, audience: beta.url, repository, refs: refsNow })
    await expectStatus(notify(beta, foreign), 403)
    await expectStatus(notify(beta, 'not-a-jwt'), 401)
  })

  it('refuses subscriptions from untrusted instances and callbacks on other hosts', async () => {
    const subscribe = (token: string, callback: string) =>
      fetch(`${alpha.url}/api/federation/subscriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ repository, callback }),
      })
    const { mintInstanceToken } = await import('@git-forge/accounts')
    const fromGamma = await mintInstanceToken({ key: gamma.key, issuer: gamma.url, audience: alpha.url, repositories: [repository] })
    await expectStatus(subscribe(fromGamma, `${gamma.url}/hook`), 401)
    const fromBeta = await mintInstanceToken({ key: beta.key, issuer: beta.url, audience: alpha.url, repositories: [repository] })
    await expectStatus(subscribe(fromBeta, `${gamma.url}/api/federation/notify/${repository}/origin`), 403)
  })

  it('archives rewritten history on every mirror and raises alarms', async () => {
    const before = (await refs(alpha))['refs/heads/main']!
    await git(source, ['commit', '-q', '--amend', '-m', 'rewritten first scan'])
    await lfsGit(source, ['push', '-q', '--force', pushUrl(alpha), 'main'])
    const rewritten = (await git(source, ['rev-parse', 'main'])).trim()
    await quiesce([alpha, beta, gamma])
    for (const instance of [beta, gamma]) {
      const current = await refs(instance)
      expect(current['refs/upstream/origin/heads/main']).toBe(rewritten)
      const archived = Object.entries(current).find(([name, id]) => /^refs\/archive\/[^/]+\/upstream\/origin\/heads\/main$/.test(name) && id === before)
      expect(archived).toBeDefined()
      expect((await readMirrorStatus(instance.storage, repo))?.alarms).toContainEqual(
        expect.objectContaining({ kind: 'history-rewritten', ref: 'refs/heads/main', archivedAs: archived![0] }),
      )
    }
    expect(await packFiles(gamma.storage)).toEqual(await packFiles(alpha.storage))
  })

  it('keeps the daily safety net and the deep check available', async () => {
    const verify = await expectStatus(gamma.api('POST', `/api/repos/${repository}/mirrors/origin/verify`), 200)
    expect(await verify.json()).toEqual(expect.objectContaining({ ok: true, problems: [] }))
    const sync = await expectStatus(gamma.api('POST', `/api/repos/${repository}/mirrors/origin/sync`), 200)
    expect(await sync.json()).toEqual(expect.objectContaining({ status: 'ok', strategy: 'copy', updates: [] }))
  })
})

describe('push notifications when the job queue is down', () => {
  it('still accepts the push', async () => {
    const solo = await startInstance('solo')
    try {
      await expectStatus(solo.api('POST', '/api/repos', { owner: repo.owner, name: repo.name }), 201)
      await solo.store.trustInstance({ issuer: beta.url })
      await solo.store.subscribeMirror({ issuer: beta.url, repository, callback: `${beta.url}/api/federation/notify/${repository}/solo` })
      const enqueue = solo.jobs.enqueue
      ;(solo.jobs as { enqueue: typeof enqueue }).enqueue = async () => {
        throw new Error('queue unavailable')
      }
      const work = tempDir()
      await git(work, ['init', '-q', '-b', 'main'])
      writeFileSync(join(work, 'a.txt'), 'a\n')
      await git(work, ['add', '-A'])
      await git(work, ['commit', '-q', '-m', 'a'])
      await git(work, ['push', '-q', pushUrl(solo), 'main'])
      expect((await refs(solo))['refs/heads/main']).toBe((await git(work, ['rev-parse', 'main'])).trim())
    } finally {
      await solo.close()
    }
  })
})
