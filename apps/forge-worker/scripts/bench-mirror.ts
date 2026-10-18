import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { generateSigningKey, importSigningKey, mintMirrorNotification, type PrivateJwk } from '@git-forge/accounts'
import {
  type ByteRange,
  configureMirror,
  createRepository,
  createSha1,
  createSha256,
  deepCheckRepository,
  type FetchFunction,
  parseInfoRefs,
  type ObjectInfo,
  type PutBody,
  type PutOptions,
  type PutResult,
  readAll,
  readRefs,
  type Storage,
  type StoredObject,
  syncMirror,
} from '@git-forge/core'
import { generateHistory, git, tempDir } from '../test/e2e/history.ts'
import { createForge } from '../src/app.ts'
import type { ForgeJob } from '../src/mirror-federation.ts'
import { mirrorAuthorization } from '../src/mirrors.ts'
import { type Instance, type Invocation, quiesce, startInstance } from '../test/support/federated-instance.ts'

class BucketLikeStorage implements Storage {
  readonly #objects = new Map<string, { data: Uint8Array; etag: string }>()
  #counter = 0

  async get(key: string, range?: ByteRange): Promise<StoredObject | null> {
    const entry = this.#objects.get(key)
    if (!entry) return null
    const data = range ? entry.data.subarray(range.offset, range.offset + range.length) : entry.data
    return { key, size: entry.data.length, etag: entry.etag, body: new Blob([data as Uint8Array<ArrayBuffer>]).stream() }
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const entry = this.#objects.get(key)
    return entry ? { key, size: entry.data.length, etag: entry.etag } : null
  }

  async put(key: string, body: PutBody, size: number, options: PutOptions = {}): Promise<PutResult> {
    const data = body instanceof Uint8Array ? body : await readAll(body)
    if (data.length !== size) throw new Error(`size mismatch for ${key}`)
    const current = this.#objects.get(key)
    if (options.ifNoneMatch === '*' && current) return { ok: false, reason: 'precondition-failed' }
    if (options.ifMatch !== undefined && current?.etag !== options.ifMatch) return { ok: false, reason: 'precondition-failed' }
    const etag = `e${++this.#counter}`
    this.#objects.set(key, { data, etag })
    return { ok: true, info: { key, size, etag } }
  }

  snapshot(): BucketLikeStorage {
    const copy = new BucketLikeStorage()
    for (const [key, entry] of this.#objects) copy.#objects.set(key, entry)
    copy.#counter = this.#counter
    return copy
  }

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    for (const key of [...this.#objects.keys()].filter((candidate) => candidate.startsWith(prefix)).sort()) {
      const entry = this.#objects.get(key)!
      yield { key, size: entry.data.length, etag: entry.etag }
    }
  }
}

if (process.argv.includes('--upstream')) {
  const upstream = await startInstance('alpha', { storage: new BucketLikeStorage(), privateJwk: JSON.parse(process.env.ALPHA_KEY!) as PrivateJwk })
  const sink = createServer((incoming, outgoing) => {
    incoming.resume()
    incoming.on('end', () => outgoing.end('{}'))
  })
  await new Promise<void>((done) => sink.listen(0, '127.0.0.1', done))
  console.log(JSON.stringify({ url: upstream.url, token: upstream.token, sink: `http://127.0.0.1:${(sink.address() as AddressInfo).port}/hook` }))
  createInterface({ input: process.stdin }).on('close', () => void upstream.close().then(() => process.exit(0)))
} else {
  const alphaJwk = (await generateSigningKey()).privateJwk
  const alphaKey = await importSigningKey(alphaJwk)
  const child = spawn(process.execPath, [...process.execArgv, import.meta.filename, '--upstream'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ALPHA_KEY: JSON.stringify(alphaJwk) },
  })
  const alpha = await new Promise<{ url: string; token: string; sink: string }>((done) =>
    createInterface({ input: child.stdout! }).once('line', (line) => done(JSON.parse(line) as { url: string; token: string; sink: string })),
  )
  const alphaUrl = alpha.url
  const alphaApi = (method: string, path: string, body?: unknown) =>
    fetch(`${alphaUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${alpha.token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  const betaStorage = new BucketLikeStorage()
  const beta: Instance = await startInstance('beta', { storage: betaStorage })
  const expectOk = async (response: Promise<Response>) => {
    const resolved = await response
    if (!resolved.ok) throw new Error(`${resolved.status}: ${await resolved.text()}`)
  }
  await expectOk(alphaApi('POST', '/api/admin/instances', { issuer: beta.url }))
  await expectOk(beta.api('POST', '/api/admin/instances', { issuer: alphaUrl }))

  type Row = { scenario: string; invocation: string; cpuMs: number; wallMs: number; storageOps: number; fetches: number }
  const rows: Row[] = []
  const collect = (scenario: string, invocations: readonly Invocation[]) => {
    for (const invocation of invocations) {
      rows.push({ scenario, invocation: invocation.label, cpuMs: invocation.cpuMs, wallMs: invocation.wallMs, storageOps: invocation.storageOps, fetches: invocation.fetches })
    }
  }
  const cpuOf = async <T>(action: () => Promise<T>) => {
    const before = process.cpuUsage()
    const started = performance.now()
    const value = await action()
    const used = process.cpuUsage(before)
    return { value, cpuMs: (used.user + used.system) / 1000, wallMs: performance.now() - started }
  }
  const measure = async (scenario: string, action: () => Promise<unknown>) => {
    const measured = await cpuOf(action)
    rows.push({ scenario, invocation: 'inline call', cpuMs: measured.cpuMs, wallMs: measured.wallMs, storageOps: 0, fetches: 0 })
  }
  type Recorded = { status: number; headers: [string, string][]; body: Uint8Array }
  const recording =
    (log: Map<string, Recorded>): FetchFunction =>
    async (request) => {
      const response = await fetch(request)
      const body = new Uint8Array(await response.arrayBuffer())
      log.set(`${request.method} ${request.url}`, { status: response.status, headers: [...response.headers], body })
      return new Response(response.status === 204 ? null : (body as Uint8Array<ArrayBuffer>), { status: response.status, headers: response.headers })
    }
  const replaying =
    (log: Map<string, Recorded>): FetchFunction =>
    async (request) => {
      const entry = log.get(`${request.method} ${request.url}`)
      if (!entry) throw new Error(`not recorded: ${request.method} ${request.url}`)
      return new Response(entry.body.slice() as Uint8Array<ArrayBuffer>, { status: entry.status, headers: entry.headers })
    }
  const noJobs = { enqueue: async () => undefined }
  const replayForge = (storage: Storage, fetcher: FetchFunction) => createForge({ ...beta.options, storage, jobs: noJobs, fetch: fetcher })
  const replay = async (scenario: string, name: string, before: BucketLikeStorage) => {
    const repository = `village/${name}`
    const upstreamRefs = parseInfoRefs(await (await alphaApi('GET', `/${repository}.git/info/refs`)).text())
    const token = await mintMirrorNotification({
      key: alphaKey,
      issuer: alphaUrl,
      audience: beta.url,
      repository,
      refs: Object.fromEntries(upstreamRefs.map((ref) => [ref.name, ref.id])),
    })
    const notified = replayForge(before.snapshot(), (request) => fetch(request))
    const notify = () => notified.fetch(new Request(`${beta.url}/api/federation/notify/${repository}/origin`, { method: 'POST', body: token }))
    await notify()
    const notification = await cpuOf(notify)
    rows.push({ scenario, invocation: `replay: notification handler (HTTP ${notification.value.status})`, cpuMs: notification.cpuMs, wallMs: notification.wallMs, storageOps: 0, fetches: 0 })
    const job: ForgeJob = { kind: 'mirror-sync', repository, remote: 'origin', reason: 'notification' }
    const log = new Map<string, Recorded>()
    await replayForge(before.snapshot(), recording(log)).runJob(job)
    const synced = before.snapshot()
    const sync = await cpuOf(() => replayForge(synced, replaying(log)).runJob(job))
    rows.push({ scenario, invocation: 'replay: copy-only sync job', cpuMs: sync.cpuMs, wallMs: sync.wallMs, storageOps: 0, fetches: log.size })
    const delivering = replayForge(synced, async () => new Response('{}'))
    const delivery = await cpuOf(() => delivering.runJob({ kind: 'mirror-notify', repository: 'village/small', issuer: alphaUrl, callback: alpha.sink }))
    rows.push({ scenario, invocation: 'replay: notification delivery job', cpuMs: delivery.cpuMs, wallMs: delivery.wallMs, storageOps: 0, fetches: 1 })
  }

  const hashRate = (label: string, hash: () => { update(data: Uint8Array): unknown; digest(): Uint8Array }) => {
    const data = new Uint8Array(4 * 1024 * 1024).map((_, i) => (i * 31) & 0xff)
    for (let round = 0; round < 2; round++) {
      const before = process.cpuUsage()
      const state = hash()
      state.update(data)
      state.digest()
      const used = process.cpuUsage(before)
      if (round === 1) rows.push({ scenario: 'hashing in JavaScript, per MiB', invocation: label, cpuMs: (used.user + used.system) / 1000 / 4, wallMs: 0, storageOps: 0, fetches: 0 })
    }
  }
  hashRate('SHA-1 (pack trailer check)', createSha1)
  hashRate('SHA-256 (LFS object check)', createSha256)
  for (const algorithm of ['SHA-1', 'SHA-256']) {
    const data = new Uint8Array(4 * 1024 * 1024).map((_, i) => (i * 31) & 0xff)
    await crypto.subtle.digest(algorithm, data)
    const measured = await cpuOf(() => crypto.subtle.digest(algorithm, data))
    rows.push({ scenario: 'hashing natively (WebCrypto), per MiB', invocation: algorithm, cpuMs: measured.cpuMs / 4, wallMs: 0, storageOps: 0, fetches: 0 })
  }

  const scenarios = [
    { name: 'small', commits: 120, files: 40, binaryBytes: 48 * 1024 },
    { name: 'medium', commits: 500, files: 200, binaryBytes: 256 * 1024 },
  ]
  for (const scenario of scenarios) {
    const repository = `village/${scenario.name}`
    const repo = { owner: 'village', name: scenario.name }
    await expectOk(alphaApi('POST', '/api/repos', repo))
    await expectOk(alphaApi('POST', `/api/repos/${repository}/instances`, { issuer: beta.url }))
    await expectOk(beta.api('POST', '/api/repos', repo))
    await expectOk(beta.api('POST', `/api/repos/${repository}/mirrors`, { url: `${alphaUrl}/${repository}.git`, auth: 'instance', lfs: false }))
    await quiesce([beta])
    if (scenario.name === 'small') await beta.store.subscribeMirror({ issuer: alphaUrl, repository, callback: alpha.sink })
    const source = tempDir()
    await git(source, ['init', '-q', '-b', 'main'])
    generateHistory(source, { ...scenario, seed: 7 })
    await git(source, ['gc', '-q'])
    const packBytes = Number(/size-pack: (\d+)/.exec(await git(source, ['count-objects', '-v']))?.[1] ?? 0) * 1024
    const objects = (await git(source, ['rev-list', '--objects', '--all'])).trim().split('\n').length
    const remote = `http://git:${alpha.token}@${alphaUrl.slice('http://'.length)}/${repository}.git`
    const waitFor = async (tip: string) => {
      for (;;) {
        await quiesce([beta])
        if ((await readRefs(beta.storage, repo))?.state.refs['refs/upstream/origin/heads/main'] === tip) return
        await new Promise((done) => setTimeout(done, 20))
      }
    }
    const pushed = async (label: string, change: () => Promise<void>) => {
      await change()
      const snapshot = betaStorage.snapshot()
      await git(source, ['push', '-q', remote, 'main'])
      const before = beta.invocations.length
      await waitFor((await git(source, ['rev-parse', 'main'])).trim())
      collect(label, beta.invocations.slice(before))
      await replay(label, scenario.name, snapshot)
    }
    const tag = `${scenario.name} initial push (${scenario.commits} commits, ${objects} objects, ${(packBytes / 1024 / 1024).toFixed(1)} MiB pack)`
    await pushed(tag, async () => undefined)
    for (let round = 1; round <= 3; round++) {
      await pushed(`${scenario.name} incremental push #${round} (1 commit, 2 files)`, async () => {
        writeFileSync(join(source, `update-${round}.md`), `update ${round}\n`.repeat(200))
        writeFileSync(join(source, 'README.md'), `round ${round}\n`)
        await git(source, ['add', '-A'])
        await git(source, ['commit', '-q', '-m', `update ${round}`])
      })
    }
    const context = { storage: beta.storage, store: beta.store, issuer: beta.url, instanceKey: beta.key }
    const fetchStorage = new BucketLikeStorage()
    await createRepository(fetchStorage, repo)
    const config = await configureMirror(fetchStorage, repo, { url: `${alphaUrl}/${repository}.git`, remote: 'fetch', mode: 'manual', lfs: false, auth: 'instance' })
    const getAuthorization = mirrorAuthorization(context, config)!
    await measure(`${scenario.name} same repository, re-indexing sync (strategy fetch, protocol v2)`, () =>
      syncMirror({ storage: fetchStorage, repo, remote: 'fetch', strategy: 'fetch', getAuthorization }),
    )
    await measure(`${scenario.name} deep check of the mirror`, () => deepCheckRepository(beta.storage, repo))
  }
  await beta.close()
  child.stdin!.end()

  console.log('| scenario | invocation | CPU (ms) | wall (ms) | storage ops | outbound fetches |')
  console.log('|---|---|---|---|---|---|')
  for (const row of rows) {
    console.log(`| ${row.scenario} | ${row.invocation} | ${row.cpuMs.toFixed(1)} | ${Math.round(row.wallMs)} | ${row.storageOps} | ${row.fetches} |`)
  }
  console.log(`node ${process.version}`)
}
