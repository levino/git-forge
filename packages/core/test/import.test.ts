import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { concat, readAll, utf8 } from '../src/bytes.ts'
import { handleGitRequest } from '../src/http.ts'
import {
  commitOrder,
  continueImport,
  importBlobsKey,
  ingestStreamed,
  type ImportJob,
  type ImportState,
  type ImportStepOptions,
  ImportRunningError,
  importStep,
  planImportRefUpdates,
  readImportState,
  retryDelaySeconds,
  runImport,
  startImport,
} from '../src/import.ts'
import { lfsObjectKey } from '../src/lfs.ts'
import { MemoryStorage } from '../src/memory-storage.ts'
import { readRefs, type RepositoryName } from '../src/repository.ts'
import type { Storage } from '../src/storage.ts'
import { commitAll, gitEnv, initRepo, sampleHistory, tempDir, writeFile } from './git-helpers.ts'
import { type RunningServer, startServer } from './http-server.ts'
import {
  basicAuth,
  chain,
  FaultyStorage,
  fakeLfs,
  httpBackendHandler,
  lfsPointer,
  randomBytes,
  requireAuthorization,
  staticDirHandler,
} from './mirror-helpers.ts'

const run = promisify(execFile)

const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await run('git', args, { cwd, env: { ...process.env, ...gitEnv }, maxBuffer: 256 * 1024 * 1024 })
  return stdout
}

const servers: RunningServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const serve = async (...handlers: Parameters<typeof chain>): Promise<RunningServer> => {
  const running = await startServer(chain(...handlers))
  servers.push(running)
  return running
}

const target: RepositoryName = { owner: 'village', name: 'imported' }

const branchyHistory = async (dir: string, commits: number): Promise<void> => {
  sampleHistory(dir, commits)
  await git(dir, ['tag', '-a', 'v1', '-m', 'release 1'])
  await git(dir, ['checkout', '-q', '-b', 'feature', 'HEAD~5'])
  for (let i = 0; i < 12; i++) {
    writeFile(dir, `feature/${i}.txt`, `feature ${i}\n`)
    commitAll(dir, `feature ${i}`)
  }
  await git(dir, ['checkout', '-q', 'main'])
  await git(dir, ['merge', '-q', '--no-ff', '-m', 'merge feature', 'feature'])
  await git(dir, ['tag', 'light'])
  for (let i = 0; i < 5; i++) {
    writeFile(dir, `after/${i}.txt`, `after ${i}\n`)
    commitAll(dir, `after ${i}`)
  }
}

type Source = { readonly work: string; readonly root: string; readonly bare: string }

const sourceRepo = async (commits = 40, filter = true): Promise<Source> => {
  const work = initRepo()
  await branchyHistory(work, commits)
  const root = tempDir('git-forge-import-root-')
  await git(root, ['clone', '-q', '--bare', work, 'source.git'])
  const bare = `${root}/source.git`
  await git(bare, ['config', 'uploadpack.allowFilter', String(filter)])
  await git(bare, ['update-server-info'])
  return { work, root, bare }
}

const sourceRefs = async (bare: string): Promise<Record<string, string>> => {
  const refs: Record<string, string> = {}
  for (const line of (await git(bare, ['for-each-ref', '--format=%(objectname) %(refname)'])).trim().split('\n')) {
    const [id, name] = line.split(' ') as [string, string]
    refs[name] = id
  }
  return refs
}

const objectList = async (dir: string): Promise<string[]> =>
  (await git(dir, ['rev-list', '--objects', '--all']))
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' ')[0] as string)
    .sort()

const cloneFromForge = async (storage: Storage): Promise<string> => {
  const forge = await serve((request) => handleGitRequest(request, { storage }))
  const dir = tempDir('git-forge-import-clone-')
  await git(dir, ['clone', '-q', '--mirror', `${forge.url}/${target.owner}/${target.name}.git`, 'clone.git'])
  const clone = `${dir}/clone.git`
  expect(await git(clone, ['fsck', '--full', '--strict', '--no-dangling'])).toBe('')
  return clone
}

const expectIdentical = async (storage: Storage, bare: string): Promise<void> => {
  const refs = (await readRefs(storage, target))?.state.refs ?? {}
  expect(Object.fromEntries(Object.entries(refs).filter(([name]) => !name.startsWith('refs/archive/')))).toEqual(await sourceRefs(bare))
  const clone = await cloneFromForge(storage)
  expect(await objectList(clone)).toEqual(await objectList(bare))
}

const largeSource = async (): Promise<Source> => {
  const work = initRepo()
  sampleHistory(work, 6)
  for (let i = 0; i < 24; i++) writeFile(work, `bulk/${i}.bin`, randomBytes(70_000, 100 + i))
  commitAll(work, 'bulk')
  const big = randomBytes(600_000, 7)
  const copy = big.slice()
  copy[1000] = ((copy[1000] as number) + 1) % 256
  writeFile(work, 'media/big.bin', big)
  writeFile(work, 'media/big-copy.bin', copy)
  writeFile(work, 'media/small.txt', 'small\n')
  commitAll(work, 'big')
  writeFile(work, 'media/big.bin', concat([big, randomBytes(1000, 8)]))
  commitAll(work, 'big changed')
  const twin = randomBytes(250_000, 9)
  for (const name of ['a', 'b', 'c', 'd']) writeFile(work, `twins/${name}.bin`, concat([twin, utf8(`${name}\n`)]))
  commitAll(work, 'twins')
  for (let i = 0; i < 4; i++) {
    writeFile(work, `after/${i}.txt`, `after ${i}\n`)
    commitAll(work, `after ${i}`)
  }
  const root = tempDir('git-forge-import-root-')
  await git(root, ['clone', '-q', '--bare', work, 'source.git'])
  const bare = `${root}/source.git`
  await git(bare, ['config', 'uploadpack.allowFilter', 'true'])
  await git(bare, ['repack', '-q', '-a', '-d', '-f'])
  return { work, root, bare }
}

const stepSplitting = async (options: ImportStepOptions): Promise<{ states: ImportState[]; splits: Set<string> }> => {
  const splits = new Set<string>()
  const states: ImportState[] = []
  for (let i = 0; i < 300; i++) {
    const state = await importStep({
      ...options,
      ingestPack: async (odb, pack, ingest) => {
        const stored = await ingestStreamed(odb, pack, ingest)
        if (ingest?.register === false && stored.name) splits.add(stored.name)
        return stored
      },
    })
    states.push(state)
    if (state.phase === 'done' || state.phase === 'failed') break
  }
  return { states, splits }
}

describe('commit order', () => {
  it('lists parents before children and side branches before their merge', () => {
    const commits = new Map<string, string[]>([
      ['m', ['c', 's2']],
      ['c', ['b']],
      ['b', ['a']],
      ['s2', ['s1']],
      ['s1', ['a']],
      ['a', ['outside']],
    ])
    expect(commitOrder(commits, ['m'])).toEqual(['a', 'b', 'c', 's1', 's2', 'm'])
  })
})

describe('import ref plan', () => {
  it('creates, fast-forwards and archives rewritten refs without deleting local ones', async () => {
    const at = new Date('2026-10-18T12:00:00.000Z')
    const plan = await planImportRefUpdates(
      { 'refs/heads/main': 'a', 'refs/heads/old': 'o', 'refs/tags/v1': 't' },
      { 'refs/heads/main': 'b', 'refs/heads/new': 'n', 'refs/tags/v1': 'u' },
      at,
      async (oldId, newId) => oldId === 'a' && newId === 'b',
    )
    expect(plan.updates.map((update) => [update.ref, update.kind])).toEqual([
      ['refs/heads/main', 'fast-forward'],
      ['refs/heads/new', 'created'],
      ['refs/tags/v1', 'forced'],
    ])
    expect(plan.refs).toEqual({
      'refs/heads/main': 'b',
      'refs/heads/new': 'n',
      'refs/heads/old': 'o',
      'refs/tags/v1': 'u',
      'refs/archive/2026-10-18T12-00-00-000Z/tags/v1': 't',
    })
  })
})

describe('server-side import', () => {
  it('takes over an import that made no progress for half an hour, e.g. after a restart', async () => {
    const storage = new MemoryStorage()
    const url = 'https://example.org/source.git'
    const started = new Date('2026-10-18T12:00:00Z')
    await startImport(storage, target, { url, commitsPerStep: 8 }, started)
    const later = (minutes: number) => new Date(started.getTime() + minutes * 60_000)
    await expect(startImport(storage, target, { url }, later(29))).rejects.toBeInstanceOf(ImportRunningError)
    const resumed = await startImport(storage, target, { url }, later(31))
    expect(resumed).toMatchObject({ phase: 'discover', commitsPerStep: 8, createdAt: started.toISOString(), updatedAt: later(31).toISOString() })
    await expect(startImport(storage, target, { url }, later(32))).rejects.toBeInstanceOf(ImportRunningError)
    const replaced = await startImport(storage, target, { url: 'https://example.org/other.git' }, later(70))
    expect(replaced).toMatchObject({ url: 'https://example.org/other.git', phase: 'discover', createdAt: later(70).toISOString() })
  })

  it('imports a repository from a git http server in bounded steps', async () => {
    const source = await sourceRepo(60)
    const remote = await serve(httpBackendHandler(source.root))
    const storage = new MemoryStorage()
    const started = await startImport(storage, target, { url: `${remote.url}/source.git`, commitsPerStep: 8 })
    expect(started.phase).toBe('discover')
    await expect(startImport(storage, target, { url: `${remote.url}/source.git` })).rejects.toBeInstanceOf(ImportRunningError)

    const ingested: number[] = []
    const state = await runImport({
      storage,
      repo: target,
      maxStepBytes: 400_000,
      ingestPack: async (odb, pack) => {
        const stored = await ingestStreamed(odb, pack)
        ingested.push(stored.bytes)
        return stored
      },
    })
    expect(ingested.length).toBe(state.fetched.packs)
    expect(state.phase).toBe('done')
    expect(state.stepped).toBe(true)
    expect(state.protocol).toBe('v2')
    expect(state.commits).toBe(78)
    expect(state.fetched.packs).toBeGreaterThan(4)
    expect(state.steps).toBeGreaterThan(6)
    expect(state.updates.every((update) => update.kind === 'created')).toBe(true)
    expect((await readRefs(storage, target))?.state.head).toBe('refs/heads/main')
    const filtered = remote.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/git-upload-pack'))
    expect(filtered.length).toBeGreaterThan(5)
    await expectIdentical(storage, source.bare)
  }, 60_000)

  it('splits commits and blobs larger than one step and resumes after crashes in between', async () => {
    const source = await largeSource()
    const remote = await serve(httpBackendHandler(source.root))
    const inner = new MemoryStorage()
    let packWrites = 0
    const storage = new FaultyStorage(inner, (key) => key.endsWith('.pack') && [4, 9].includes(++packWrites))
    await startImport(storage, target, { url: `${remote.url}/source.git`, commitsPerStep: 8 })
    const { states, splits } = await stepSplitting({ storage, repo: target, maxStepBytes: 400_000, maxObjectBytes: 200_000 })
    const state = states.at(-1)
    expect(state?.phase).toBe('done')
    expect(state?.split).toBeUndefined()
    expect(states.some((step) => step.error?.includes('simulated crash'))).toBe(true)
    expect(states.some((step) => step.error?.includes('exceeds'))).toBe(false)
    expect(splits.size).toBe(4)
    expect(states.some((step) => step.split?.blobs === 24)).toBe(true)
    expect(states.some((step) => step.split?.listed && step.split.blobsPerStep < Math.ceil(step.split.blobs / 2))).toBe(true)
    expect(await inner.get(importBlobsKey(target))).not.toBeNull()
    await expectIdentical(inner, source.bare)
  }, 120_000)

  it('splits a commit whose deltas resolve to objects above the memory limit', async () => {
    const source = await largeSource()
    const remote = await serve(httpBackendHandler(source.root))
    const storage = new MemoryStorage()
    await startImport(storage, target, { url: `${remote.url}/source.git` })
    const { states, splits } = await stepSplitting({ storage, repo: target, maxObjectBytes: 200_000 })
    expect(states.at(-1)?.phase).toBe('done')
    expect(states.every((step) => step.error === undefined)).toBe(true)
    expect(states.some((step) => step.commitsPerStep === 1)).toBe(true)
    expect(states.some((step) => step.split?.listed && step.split.blobsPerStep < Math.ceil(step.split.blobs / 2))).toBe(true)
    expect(splits.size).toBe(1)
    await expectIdentical(storage, source.bare)
  }, 120_000)

  it('updates an imported repository and archives rewritten history', async () => {
    const source = await sourceRepo(10)
    const remote = await serve(httpBackendHandler(source.root))
    const storage = new MemoryStorage()
    const url = `${remote.url}/source.git`
    await startImport(storage, target, { url, commitsPerStep: 4 })
    expect((await runImport({ storage, repo: target })).phase).toBe('done')
    const before = (await readRefs(storage, target))?.state.refs ?? {}

    writeFile(source.work, 'next.txt', 'next\n')
    commitAll(source.work, 'next')
    await git(source.work, ['checkout', '-q', 'feature'])
    await git(source.work, ['reset', '-q', '--hard', 'HEAD~2'])
    writeFile(source.work, 'rewritten.txt', 'rewritten\n')
    commitAll(source.work, 'rewritten')
    await git(source.work, ['push', '-q', '--force', source.bare, 'main', 'feature'])

    await startImport(storage, target, { url, commitsPerStep: 4 })
    const state = await runImport({ storage, repo: target })
    expect(state.phase).toBe('done')
    expect(Object.fromEntries(state.updates.map((update) => [update.ref, update.kind]))).toEqual({
      'refs/heads/feature': 'forced',
      'refs/heads/main': 'fast-forward',
    })
    const refs = (await readRefs(storage, target))?.state.refs ?? {}
    expect(Object.entries(refs).filter(([name]) => name.startsWith('refs/archive/')).map(([, id]) => id)).toEqual([before['refs/heads/feature']])
    await expectIdentical(storage, source.bare)
  })

  it('falls back to a single fetch when the server does not allow filters', async () => {
    const source = await sourceRepo(20, false)
    const remote = await serve(httpBackendHandler(source.root))
    const storage = new MemoryStorage()
    await startImport(storage, target, { url: `${remote.url}/source.git` })
    const state = await runImport({ storage, repo: target })
    expect(state.phase).toBe('done')
    expect(state.stepped).toBe(false)
    expect(state.fetched.packs).toBe(1)
    await expectIdentical(storage, source.bare)
  })

  it('imports from a dumb HTTP server', async () => {
    const source = await sourceRepo(15)
    const remote = await serve(staticDirHandler(source.root))
    const storage = new MemoryStorage()
    await startImport(storage, target, { url: `${remote.url}/source.git` })
    const state = await runImport({ storage, repo: target })
    expect(state.phase).toBe('done')
    expect(state.protocol).toBe('dumb')
    await expectIdentical(storage, source.bare)
  })

  it('sends the token on every request and resumes after a failed import', async () => {
    const source = await sourceRepo(20)
    const token = basicAuth('git', 'secret-token')
    const remote = await serve(requireAuthorization(token), httpBackendHandler(source.root))
    const storage = new MemoryStorage()
    const url = `${remote.url}/source.git`
    await startImport(storage, target, { url, commitsPerStep: 5 })
    const denied = await runImport({ storage, repo: target, maxFailures: 2 })
    expect(denied.phase).toBe('failed')
    expect(denied.failedIn).toBe('discover')
    expect(denied.error).toMatch(/401/)

    await startImport(storage, target, { url })
    let state = await importStep({ storage, repo: target, getAuthorization: async () => token })
    while (state.phase !== 'graph') state = await importStep({ storage, repo: target, getAuthorization: async () => token })
    state = await importStep({ storage, repo: target, getAuthorization: async () => token })
    state = await importStep({ storage, repo: target, getAuthorization: async () => token })
    expect(state.phase).toBe('fetch')
    expect(state.cuts.length).toBe(1)
    const failed = await runImport({ storage, repo: target, maxFailures: 1 })
    expect(failed.phase).toBe('failed')
    expect(failed.failedIn).toBe('fetch')

    const resumed = await startImport(storage, target, { url })
    expect(resumed.phase).toBe('fetch')
    expect(resumed.cuts.length).toBe(1)
    const done = await runImport({ storage, repo: target, getAuthorization: async () => token })
    expect(done.phase).toBe('done')
    expect(done.fetched.packs).toBe(done.cuts.length + 1)
    await expectIdentical(storage, source.bare)
  })

  it('survives a crash in the middle of a step', async () => {
    const source = await sourceRepo(30)
    const remote = await serve(httpBackendHandler(source.root))
    const inner = new MemoryStorage()
    let packWrites = 0
    const storage = new FaultyStorage(inner, (key) => key.endsWith('.pack') && ++packWrites === 3)
    await startImport(storage, target, { url: `${remote.url}/source.git`, commitsPerStep: 6 })
    const states = []
    for (let i = 0; i < 100; i++) {
      const state = await importStep({ storage, repo: target })
      states.push(state)
      if (state.phase === 'done' || state.phase === 'failed') break
    }
    expect(states.some((state) => state.error?.includes('simulated crash'))).toBe(true)
    expect(states.at(-1)?.phase).toBe('done')
    await expectIdentical(inner, source.bare)
  })

  it('imports LFS objects referenced by imported commits', async () => {
    const work = initRepo()
    sampleHistory(work, 3)
    const asset = randomBytes(50_000, 3)
    const pointer = lfsPointer(asset)
    writeFile(work, 'media/photo.jpg', pointer.text)
    commitAll(work, 'photo')
    const root = tempDir('git-forge-import-root-')
    await git(root, ['clone', '-q', '--bare', work, 'source.git'])
    await git(`${root}/source.git`, ['config', 'uploadpack.allowFilter', 'true'])
    const lfs = fakeLfs({ read: async (oid) => (oid === pointer.oid ? asset : null) })
    const remote = await serve(lfs.handler, httpBackendHandler(root))
    const storage = new MemoryStorage()
    await startImport(storage, target, { url: `${remote.url}/source.git` })
    const state = await runImport({ storage, repo: target })
    expect(state.phase).toBe('done')
    expect(state.lfsMissing).toEqual([])
    const stored = await storage.get(lfsObjectKey(target, pointer.oid))
    expect(stored && (await readAll(stored.body))).toEqual(asset)
  })

  it('takes the LFS endpoint from .lfsconfig, keeps the token away from it and splits LFS steps by size', async () => {
    const assets = [randomBytes(50_000, 21), randomBytes(150_000, 22), randomBytes(40_000, 23)]
    const pointers = assets.map((asset) => lfsPointer(asset))
    const lfs = fakeLfs({ read: async (oid) => assets[pointers.findIndex((pointer) => pointer.oid === oid)] ?? null })
    const lfsServer = await serve(lfs.handler)
    const work = initRepo()
    sampleHistory(work, 2)
    pointers.forEach((pointer, i) => writeFile(work, `media/${i}.bin`, pointer.text))
    writeFile(work, '.lfsconfig', `[lfs]\n\turl = ${lfsServer.url}/store/info/lfs/objects/batch\n\tfetchexclude = media/**\n`)
    commitAll(work, 'media')
    await git(work, ['checkout', '-q', '-b', 'other'])
    writeFile(work, '.lfsconfig', '[lfs]\n\turl = https://elsewhere.invalid/lfs\n')
    commitAll(work, 'other endpoint')
    await git(work, ['checkout', '-q', 'main'])
    const root = tempDir('git-forge-import-root-')
    await git(root, ['clone', '-q', '--bare', work, 'source.git'])
    await git(`${root}/source.git`, ['config', 'uploadpack.allowFilter', 'true'])
    const token = basicAuth('git', 'github-token')
    const remote = await serve(requireAuthorization(token), httpBackendHandler(root))
    const storage = new MemoryStorage()
    await startImport(storage, target, { url: `${remote.url}/source.git` })
    const states: ImportState[] = []
    for (let i = 0; i < 50; i++) {
      const state = await importStep({ storage, repo: target, maxLfsStepBytes: 100_000, getAuthorization: async () => token })
      states.push(state)
      if (state.phase === 'done' || state.phase === 'failed') break
    }
    const state = states.at(-1)
    expect(state?.phase).toBe('done')
    expect(state?.lfsMissing).toEqual([])
    expect(state?.lfsEndpoint).toEqual({ url: `${lfsServer.url}/store/info/lfs`, source: 'lfsconfig', ref: 'refs/heads/main' })
    expect(states.filter((step) => step.phase === 'lfs' || (step.phase === 'refs' && step.lfsEndpoint)).length).toBeGreaterThanOrEqual(2)
    const sizeOf = (oid: string) => pointers.find((pointer) => pointer.oid === oid)?.size ?? 0
    expect(lfs.batches.length).toBeGreaterThanOrEqual(2)
    expect(lfs.batches.every((batch) => batch.oids.length === 1 || batch.oids.reduce((sum, oid) => sum + sizeOf(oid), 0) <= 100_000)).toBe(true)
    expect(lfs.batches.every((batch) => batch.authorization === null)).toBe(true)
    for (const [i, pointer] of pointers.entries()) {
      const stored = await storage.get(lfsObjectKey(target, pointer.oid))
      expect(stored && (await readAll(stored.body))).toEqual(assets[i])
    }
  })

  it('continues through a scheduler and backs off after failures', async () => {
    const source = await sourceRepo(10)
    const token = basicAuth('git', 'queue-token')
    const remote = await serve(requireAuthorization(token), httpBackendHandler(source.root))
    const storage = new MemoryStorage()
    await startImport(storage, target, { url: `${remote.url}/source.git`, commitsPerStep: 3 })
    const queue: { job: ImportJob; delay: number }[] = [{ job: { owner: target.owner, name: target.name, authorization: token }, delay: 0 }]
    let processed = 0
    while (queue.length > 0 && processed < 100) {
      const { job } = queue.shift() as { job: ImportJob }
      await continueImport(job, { storage, schedule: async (next, delay) => void queue.push({ job: next, delay }) })
      processed++
    }
    expect((await readImportState(storage, target))?.phase).toBe('done')
    expect(processed).toBeGreaterThan(3)
    expect([0, 1, 2, 3, 10].map(retryDelaySeconds)).toEqual([0, 15, 30, 60, 600])
    await expectIdentical(storage, source.bare)
  })
})
