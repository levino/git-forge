import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { readAll } from '../src/bytes.ts'
import { lfsObjectKey } from '../src/lfs.ts'
import { MemoryStorage } from '../src/memory-storage.ts'
import {
  configureMirror,
  detachMirror,
  isMirrorDue,
  readMirrorStatus,
  refsChecksum,
  syncMirror,
  type SyncOptions,
} from '../src/mirror.ts'
import { readRefs, type RepositoryName } from '../src/repository.ts'
import type { Storage } from '../src/storage.ts'
import { commitAll, gitEnv, initRepo, sampleHistory, tempDir, writeFile } from './git-helpers.ts'
import { startServer, type RunningServer } from './http-server.ts'
import {
  basicAuth,
  chain,
  FaultyStorage,
  fakeLfs,
  type Forge,
  httpBackendHandler,
  lfsPointer,
  putLfsObject,
  randomBytes,
  requireAuthorization,
  startForge,
  staticBucketHandler,
  staticDirHandler,
  storageLfsReader,
} from './mirror-helpers.ts'

const run = promisify(execFile)

const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await run('git', args, { cwd, env: { ...process.env, ...gitEnv }, maxBuffer: 256 * 1024 * 1024 })
  return stdout
}

const gitFails = async (cwd: string, args: readonly string[]): Promise<string> => {
  try {
    await git(cwd, args)
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? error)
  }
  throw new Error(`git ${args.join(' ')} unexpectedly succeeded`)
}

const servers: RunningServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const forge = async (storage?: Storage, extra: Parameters<typeof startForge>[1] = []): Promise<Forge> => {
  const instance = await startForge(storage, extra)
  servers.push(instance.server)
  return instance
}

const server = async (handler: Parameters<typeof startServer>[0]): Promise<RunningServer> => {
  const running = await startServer(handler)
  servers.push(running)
  return running
}

const project: RepositoryName = { owner: 'village', name: 'archive' }
const backup: RepositoryName = { owner: 'backup', name: 'archive' }

const upstreamRefs = async (dir: string, remote: string): Promise<Map<string, string>> => {
  const refs = new Map<string, string>()
  for (const line of (await git(dir, ['ls-remote', remote])).trim().split('\n')) {
    const [id, name] = line.split('\t') as [string, string]
    if ((name.startsWith('refs/heads/') || name.startsWith('refs/tags/')) && !name.endsWith('^{}')) refs.set(name, id)
  }
  return refs
}

const localRefs = async (storage: Storage, repo: RepositoryName): Promise<Record<string, string>> => (await readRefs(storage, repo))?.state.refs ?? {}

const upstreamView = (refs: Record<string, string>, prefix = 'refs/upstream/origin/'): Map<string, string> =>
  new Map(
    Object.entries(refs)
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, id]) => [`refs/${name.slice(prefix.length)}`, id]),
  )

const fetchMirrorWithGit = async (url: string): Promise<string> => {
  const dir = tempDir()
  await git(dir, ['init', '-q', '--bare'])
  await git(dir, ['fetch', '-q', url, '+refs/upstream/*:refs/upstream/*', '+refs/archive/*:refs/archive/*'])
  expect(await git(dir, ['fsck', '--full', '--strict', '--no-dangling'])).toBe('')
  return dir
}

type Setup = {
  readonly upstream: Forge
  readonly downstream: Forge
  readonly lfs: ReturnType<typeof fakeLfs>
  readonly source: string
  readonly remote: string
  readonly sync: (extra?: Partial<SyncOptions>) => ReturnType<typeof syncMirror>
}

const setup = async (): Promise<Setup> => {
  const upstreamStorage = new MemoryStorage()
  const lfs = fakeLfs({ read: storageLfsReader(upstreamStorage, project) })
  const upstream = await forge(upstreamStorage, [lfs.handler])
  const downstream = await forge()
  const remote = await upstream.createRepo(project)
  await downstream.createRepo(backup)
  await configureMirror(downstream.storage, backup, { url: remote })
  const source = initRepo()
  return {
    upstream,
    downstream,
    lfs,
    source,
    remote,
    sync: (extra = {}) => syncMirror({ storage: downstream.storage, repo: backup, ...extra }),
  }
}

const seed = async ({ source, remote, upstream }: Setup): Promise<{ main: string; feature: string; asset: Uint8Array }> => {
  sampleHistory(source, 3)
  const asset = randomBytes(300_000, 7)
  const pointer = lfsPointer(asset)
  writeFile(source, 'media/photo.jpg', pointer.text)
  await putLfsObject(upstream.storage, project, asset)
  const main = commitAll(source, 'add photo')
  await git(source, ['tag', '-a', 'v1', '-m', 'release 1'])
  await git(source, ['tag', 'light'])
  await git(source, ['checkout', '-q', '-b', 'feature'])
  writeFile(source, 'feature.txt', 'feature\n')
  const feature = commitAll(source, 'feature work')
  await git(source, ['checkout', '-q', 'main'])
  await git(source, ['push', '-q', remote, 'main', 'feature', '--tags'])
  return { main, feature, asset }
}

const uploadPackPosts = (instance: Forge) => instance.server.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/git-upload-pack')).length

describe('mirroring between two forge instances', () => {
  it('mirrors branches, tags and LFS objects into refs/upstream and serves them to real git', async () => {
    const context = await setup()
    const { main, feature, asset } = await seed(context)
    const result = await context.sync()
    expect(result.status).toBe('ok')
    expect(result.protocol).toBe('v2')
    expect(result.alarms).toEqual([])
    expect(result.updates.map((update) => [update.ref, update.kind])).toEqual([
      ['refs/upstream/origin/heads/feature', 'created'],
      ['refs/upstream/origin/heads/main', 'created'],
      ['refs/upstream/origin/tags/light', 'created'],
      ['refs/upstream/origin/tags/v1', 'created'],
    ])
    const refs = await localRefs(context.downstream.storage, backup)
    expect(refs['refs/upstream/origin/heads/main']).toBe(main)
    expect(refs['refs/upstream/origin/heads/feature']).toBe(feature)
    expect(Object.keys(refs).filter((name) => name.startsWith('refs/heads/'))).toEqual([])

    expect(result.lfs?.downloaded.map((pointer) => pointer.size)).toEqual([asset.length])
    const stored = await context.downstream.storage.get(lfsObjectKey(backup, lfsPointer(asset).oid))
    expect(stored && (await readAll(stored.body))).toEqual(asset)

    const expected = await upstreamRefs(context.source, context.remote)
    const status = await readMirrorStatus(context.downstream.storage, backup)
    expect(status?.upstreamChecksum).toBe(refsChecksum(expected))
    expect(refsChecksum(upstreamView(refs))).toBe(refsChecksum(expected))
    expect(status?.lastRun?.ok).toBe(true)
    expect(status?.lastSuccessAt).toBe(status?.lastRun?.finishedAt)
    expect(status?.upstreamHead).toBe('refs/heads/main')
    expect(status?.protocol).toBe('v2')

    const clone = await fetchMirrorWithGit(context.downstream.url(backup))
    expect((await git(clone, ['rev-parse', 'refs/upstream/origin/heads/main'])).trim()).toBe(main)
    expect((await git(clone, ['cat-file', '-t', 'refs/upstream/origin/tags/v1'])).trim()).toBe('tag')
    expect(await git(clone, ['log', '--format=%H', 'refs/upstream/origin/heads/feature'])).toBe(await git(context.source, ['log', '--format=%H', 'feature']))
  })

  it('fetches only new objects on incremental syncs and is idempotent', async () => {
    const context = await setup()
    await seed(context)
    expect((await context.sync()).status).toBe('ok')
    writeFile(context.source, 'docs/new.md', 'new content\n')
    const next = commitAll(context.source, 'incremental')
    await git(context.source, ['push', '-q', context.remote, 'main'])
    const incremental = await context.sync()
    expect(incremental.status).toBe('ok')
    expect(incremental.updates).toEqual([
      { ref: 'refs/upstream/origin/heads/main', oldId: expect.any(String), newId: next, kind: 'fast-forward' },
    ])
    expect(incremental.fetched.objects).toBeGreaterThan(0)
    expect(incremental.fetched.objects).toBeLessThanOrEqual(4)
    expect(incremental.lfs).toBeNull()

    const postsBefore = uploadPackPosts(context.upstream)
    const batchesBefore = context.lfs.batches.length
    const again = await context.sync()
    expect(again.status).toBe('ok')
    expect(again.updates).toEqual([])
    expect(again.fetched.objects).toBe(0)
    expect(uploadPackPosts(context.upstream) - postsBefore).toBe(1)
    expect(context.lfs.batches.length).toBe(batchesBefore)
  })

  it('archives force-pushed history and moved tags and raises alarms', async () => {
    const context = await setup()
    const { main } = await seed(context)
    await context.sync()
    await git(context.source, ['reset', '-q', '--hard', 'HEAD~1'])
    writeFile(context.source, 'rewrite.txt', 'rewritten\n')
    const rewritten = commitAll(context.source, 'rewritten history')
    await git(context.source, ['tag', '-f', '-a', 'v1', '-m', 'moved release'])
    await git(context.source, ['push', '-q', '--force', context.remote, 'main', 'refs/tags/v1'])
    const result = await context.sync()
    expect(result.status).toBe('ok')
    expect(result.alarms.map((alarm) => [alarm.kind, alarm.ref])).toEqual([
      ['history-rewritten', 'refs/heads/main'],
      ['history-rewritten', 'refs/tags/v1'],
    ])
    const [alarm] = result.alarms
    expect(alarm?.oldId).toBe(main)
    expect(alarm?.newId).toBe(rewritten)
    expect(alarm?.archivedAs).toMatch(/^refs\/archive\/[0-9TZ-]+\/upstream\/origin\/heads\/main$/)
    const refs = await localRefs(context.downstream.storage, backup)
    expect(refs[alarm?.archivedAs as string]).toBe(main)
    expect(refs['refs/upstream/origin/heads/main']).toBe(rewritten)
    expect((await readMirrorStatus(context.downstream.storage, backup))?.alarms).toHaveLength(2)

    const clone = await fetchMirrorWithGit(context.downstream.url(backup))
    expect((await git(clone, ['rev-parse', alarm?.archivedAs as string])).trim()).toBe(main)
  })

  it('keeps refs that upstream deleted under refs/archive', async () => {
    const context = await setup()
    const { feature } = await seed(context)
    await context.sync()
    await git(context.source, ['push', '-q', context.remote, '--delete', 'feature'])
    const result = await context.sync()
    expect(result.status).toBe('ok')
    expect(result.updates).toEqual([{ ref: 'refs/upstream/origin/heads/feature', oldId: feature, newId: null, kind: 'deleted' }])
    expect(result.alarms).toEqual([expect.objectContaining({ kind: 'ref-deleted', ref: 'refs/heads/feature', oldId: feature, newId: null })])
    const refs = await localRefs(context.downstream.storage, backup)
    expect(refs['refs/upstream/origin/heads/feature']).toBeUndefined()
    expect(refs[result.alarms[0]?.archivedAs as string]).toBe(feature)
    const clone = await fetchMirrorWithGit(context.downstream.url(backup))
    expect((await git(clone, ['cat-file', '-t', feature])).trim()).toBe('commit')
    expect((await context.sync()).alarms).toEqual([])
  })

  it('rejects pushes to refs/upstream but keeps downstream branches untouched', async () => {
    const context = await setup()
    const { main } = await seed(context)
    await context.sync()
    const url = context.downstream.url(backup)
    const work = tempDir()
    await git(work, ['clone', '-q', context.remote, 'w'])
    const dir = `${work}/w`
    writeFile(dir, 'evil.txt', 'evil\n')
    commitAll(dir, 'evil')
    expect(await gitFails(dir, ['push', url, 'HEAD:refs/upstream/origin/heads/main'])).toMatch(/invalid ref name|rejected/)
    expect(await gitFails(dir, ['push', url, 'HEAD:refs/upstream/other/heads/x'])).toMatch(/invalid ref name|rejected/)
    await git(dir, ['push', '-q', url, 'HEAD:refs/heads/downstream-work'])
    const own = (await git(dir, ['rev-parse', 'HEAD'])).trim()
    writeFile(context.source, 'more.txt', 'more\n')
    commitAll(context.source, 'more upstream work')
    await git(context.source, ['push', '-q', context.remote, 'main'])
    const result = await context.sync()
    expect(result.status).toBe('ok')
    expect(result.updates.map((update) => update.kind)).toEqual(['fast-forward'])
    const refs = await localRefs(context.downstream.storage, backup)
    expect(refs['refs/heads/downstream-work']).toBe(own)
    expect(refs['refs/upstream/origin/heads/main']).not.toBe(main)
  })

  it('mirrors a mirror from its static files over dumb HTTP', async () => {
    const context = await setup()
    const { asset } = await seed(context)
    await context.sync()
    const bucket = await server(chain(staticBucketHandler(context.downstream.storage)))
    const third = await forge()
    const tertiary: RepositoryName = { owner: 'third', name: 'archive' }
    await third.createRepo(tertiary)
    await configureMirror(third.storage, tertiary, {
      url: `${bucket.url}/${backup.owner}/${backup.name}.git`,
      namespace: 'upstream/origin/',
      lfsUrl: `${context.remote}/info/lfs`,
    })
    const sync = () => syncMirror({ storage: third.storage, repo: tertiary })
    const first = await sync()
    expect(first.status).toBe('ok')
    expect(first.protocol).toBe('dumb')
    expect(bucket.requests.every((request) => request.method === 'GET')).toBe(true)
    const secondRefs = await localRefs(context.downstream.storage, backup)
    const thirdRefs = await localRefs(third.storage, tertiary)
    expect(upstreamView(thirdRefs)).toEqual(upstreamView(secondRefs))
    expect(first.lfs?.downloaded).toHaveLength(1)
    const stored = await third.storage.get(lfsObjectKey(tertiary, lfsPointer(asset).oid))
    expect(stored && (await readAll(stored.body))).toEqual(asset)

    writeFile(context.source, 'chain.txt', 'chained\n')
    const next = commitAll(context.source, 'chained update')
    await git(context.source, ['push', '-q', context.remote, 'main'])
    await context.sync()
    const before = bucket.requests.length
    const incremental = await sync()
    expect(incremental.status).toBe('ok')
    expect(incremental.fetched.packs).toHaveLength(1)
    expect(bucket.requests.slice(before).filter((request) => request.path.endsWith('.pack'))).toHaveLength(1)
    expect((await localRefs(third.storage, tertiary))['refs/upstream/origin/heads/main']).toBe(next)
    expect((await readMirrorStatus(third.storage, tertiary))?.upstreamChecksum).toBe(refsChecksum(upstreamView(await localRefs(context.downstream.storage, backup))))
    await fetchMirrorWithGit(third.url(tertiary))
  })

  it('resumes after a crash before the refs update without downloading again', async () => {
    const context = await setup()
    const { main } = await seed(context)
    const faulty = new FaultyStorage(context.downstream.storage, (key) => key.endsWith('/refs.json'))
    const crashed = await syncMirror({ storage: faulty, repo: backup })
    expect(crashed.status).toBe('failed')
    expect(crashed.error).toMatch(/simulated crash/)
    expect(crashed.fetched.objects).toBeGreaterThan(0)
    const status = await readMirrorStatus(context.downstream.storage, backup)
    expect(status?.lastRun?.ok).toBe(false)
    expect(status?.lastSuccessAt).toBeUndefined()
    expect(upstreamView(await localRefs(context.downstream.storage, backup)).size).toBe(0)

    const resumed = await context.sync()
    expect(resumed.status).toBe('ok')
    expect(resumed.fetched.objects).toBe(0)
    expect(resumed.lfs?.present).toBe(1)
    expect((await localRefs(context.downstream.storage, backup))['refs/upstream/origin/heads/main']).toBe(main)
    await fetchMirrorWithGit(context.downstream.url(backup))
  })

  it('repairs static server info after a crash right after the refs update', async () => {
    const context = await setup()
    const { main } = await seed(context)
    const faulty = new FaultyStorage(context.downstream.storage, (key) => key.endsWith('/git/info/refs'))
    expect((await syncMirror({ storage: faulty, repo: backup })).status).toBe('failed')
    expect((await localRefs(context.downstream.storage, backup))['refs/upstream/origin/heads/main']).toBe(main)
    const infoRefs = async () => {
      const object = await context.downstream.storage.get(`repos/${backup.owner}/${backup.name}/git/info/refs`)
      return object ? new TextDecoder().decode(await readAll(object.body)) : ''
    }
    expect(await infoRefs()).toBe('')
    const repaired = await context.sync()
    expect(repaired.status).toBe('ok')
    expect(repaired.updates).toEqual([])
    expect(await infoRefs()).toContain(`${main}\trefs/upstream/origin/heads/main`)
  })

  it('recovers from a connection dropped in the middle of the pack', async () => {
    const context = await setup()
    const { main } = await seed(context)
    const dropping = async (request: Request): Promise<Response> => {
      const isFetch = request.url.endsWith('/git-upload-pack') && (await request.clone().text()).includes('command=fetch')
      const response = await fetch(request)
      if (!isFetch) return response
      const bytes = new Uint8Array(await response.arrayBuffer())
      return new Response(bytes.subarray(0, Math.floor(bytes.length / 2)), { headers: response.headers })
    }
    const dropped = await context.sync({ fetch: dropping })
    expect(dropped.status).toBe('failed')
    expect(dropped.error).toMatch(/truncated/)
    expect(upstreamView(await localRefs(context.downstream.storage, backup)).size).toBe(0)
    const resumed = await context.sync()
    expect(resumed.status).toBe('ok')
    expect((await localRefs(context.downstream.storage, backup))['refs/upstream/origin/heads/main']).toBe(main)
  })

  it('keeps LFS objects that failed to download pending until a later sync', async () => {
    const context = await setup()
    const { asset } = await seed(context)
    const oid = lfsPointer(asset).oid
    const truncating = async (request: Request): Promise<Response> => {
      const response = await fetch(request)
      if (!request.url.includes('/lfs-download/')) return response
      const bytes = new Uint8Array(await response.arrayBuffer())
      return new Response(bytes.subarray(0, 1000), { headers: response.headers })
    }
    const partial = await context.sync({ fetch: truncating })
    expect(partial.status).toBe('ok')
    expect(partial.lfs?.missing).toEqual([expect.objectContaining({ oid, reason: expect.stringMatching(/1000 bytes/) })])
    expect(await context.downstream.storage.head(lfsObjectKey(backup, oid))).toBeNull()
    expect((await readMirrorStatus(context.downstream.storage, backup))?.lfsPending).toHaveLength(1)

    const healed = await context.sync()
    expect(healed.lfs?.downloaded.map((pointer) => pointer.oid)).toEqual([oid])
    expect((await readMirrorStatus(context.downstream.storage, backup))?.lfsPending).toEqual([])
  })

  it('stops syncing when detached and keeps everything', async () => {
    const context = await setup()
    const { main } = await seed(context)
    await context.sync()
    const config = await detachMirror(context.downstream.storage, backup)
    expect(config.detachedAt).toBeDefined()
    writeFile(context.source, 'after.txt', 'after detach\n')
    commitAll(context.source, 'after detach')
    await git(context.source, ['push', '-q', context.remote, 'main'])
    const result = await context.sync()
    expect(result.status).toBe('detached')
    expect((await localRefs(context.downstream.storage, backup))['refs/upstream/origin/heads/main']).toBe(main)
    expect(isMirrorDue(config, await readMirrorStatus(context.downstream.storage, backup), new Date(Date.now() + 1e9), 1000)).toBe(false)
  })
})

describe('mirroring from other git servers', () => {
  it('mirrors from a GitHub-like smart HTTP v2 server with authorization and git-lfs', async () => {
    const root = tempDir()
    const source = initRepo()
    await git(source, ['lfs', 'install', '--local'])
    await git(source, ['lfs', 'track', 'assets/*.bin'])
    sampleHistory(source, 2)
    const big = randomBytes(200_000, 3)
    writeFile(source, 'assets/big.bin', big)
    writeFile(source, 'assets/second.bin', randomBytes(50_000, 11))
    commitAll(source, 'add lfs assets')
    const pointerText = await git(source, ['show', 'HEAD:assets/big.bin'])
    expect(pointerText).toContain('oid sha256:')
    await git(root, ['clone', '-q', '--bare', source, 'project.git'])
    const token = basicAuth('x-access-token', 'secret-token')
    const lfsObjects = async (oid: string) => {
      try {
        return new Uint8Array(await readFile(`${source}/.git/lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`))
      } catch {
        return null
      }
    }
    const lfs = fakeLfs({ read: lfsObjects, authorization: token, downloadHeader: { Authorization: 'RemoteAuth signed-url-token' } })
    const github = await server(chain(lfs.handler, requireAuthorization(token), httpBackendHandler(root)))
    const downstream = await forge()
    await downstream.createRepo(backup)
    await configureMirror(downstream.storage, backup, { url: `${github.url}/project.git` })

    const denied = await syncMirror({ storage: downstream.storage, repo: backup })
    expect(denied.status).toBe('failed')
    expect(denied.error).toMatch(/401/)

    let calls = 0
    const getAuthorization = async () => {
      calls++
      return token
    }
    const result = await syncMirror({ storage: downstream.storage, repo: backup, getAuthorization })
    expect(result.status).toBe('ok')
    expect(result.protocol).toBe('v2')
    expect(calls).toBeGreaterThan(0)
    expect(result.lfs?.downloaded).toHaveLength(2)
    expect(lfs.batches.every((batch) => batch.authorization === token)).toBe(true)
    const stored = await downstream.storage.get(lfsObjectKey(backup, lfsPointer(big).oid))
    expect(stored && (await readAll(stored.body))).toEqual(big)
    const main = (await git(source, ['rev-parse', 'HEAD'])).trim()
    expect((await localRefs(downstream.storage, backup))['refs/upstream/origin/heads/main']).toBe(main)

    const work = tempDir()
    await git(work, ['clone', '-q', downstream.url(backup), 'own'])
    for (let i = 0; i < 40; i++) {
      writeFile(`${work}/own`, `own-${i}.txt`, `${i}\n`)
      commitAll(`${work}/own`, `downstream only ${i}`)
    }
    await git(work, ['-C', 'own', 'push', '-q', 'origin', 'HEAD:refs/heads/own'])
    writeFile(source, 'later.txt', 'later\n')
    const later = commitAll(source, 'later upstream commit')
    await git(source, ['push', '-q', `${root}/project.git`, 'main'])
    const incremental = await syncMirror({ storage: downstream.storage, repo: backup, getAuthorization })
    expect(incremental.status).toBe('ok')
    expect(incremental.fetched.objects).toBeLessThanOrEqual(4)
    expect(incremental.fetched.rounds).toBeGreaterThanOrEqual(1)
    expect((await localRefs(downstream.storage, backup))['refs/upstream/origin/heads/main']).toBe(later)
    await fetchMirrorWithGit(downstream.url(backup))
  })

  it('falls back to dumb HTTP for a plain bare repository with loose objects', async () => {
    const root = tempDir()
    const source = initRepo()
    sampleHistory(source, 3)
    await git(root, ['clone', '-q', '--bare', source, 'plain.git'])
    await git(`${root}/plain.git`, ['repack', '-a', '-d', '-q'])
    sampleHistory(source, 5)
    await git(source, ['tag', '-a', 'v2', '-m', 'second'])
    await git(source, ['push', '-q', `${root}/plain.git`, 'main', '--tags'])
    await git(`${root}/plain.git`, ['update-server-info'])
    const plain = await server(chain(staticDirHandler(root)))
    const downstream = await forge()
    await downstream.createRepo(backup)
    await configureMirror(downstream.storage, backup, { url: `${plain.url}/plain.git`, lfs: false })
    const result = await syncMirror({ storage: downstream.storage, repo: backup })
    expect(result.status).toBe('ok')
    expect(result.protocol).toBe('dumb')
    expect(result.fetched.packs.length).toBeGreaterThanOrEqual(2)
    expect(plain.requests.some((request) => /\/objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/.test(request.path))).toBe(true)
    expect(upstreamView(await localRefs(downstream.storage, backup))).toEqual(await upstreamRefs(source, `${root}/plain.git`))
    const clone = await fetchMirrorWithGit(downstream.url(backup))
    expect(await git(clone, ['log', '--format=%H', 'refs/upstream/origin/heads/main'])).toBe(await git(source, ['log', '--format=%H', 'main']))
  })

  it('reports a failure without touching refs when the upstream is unreachable', async () => {
    const downstream = await forge()
    await downstream.createRepo(backup)
    await configureMirror(downstream.storage, backup, { url: 'http://127.0.0.1:9/nothing.git' })
    const result = await syncMirror({ storage: downstream.storage, repo: backup })
    expect(result.status).toBe('failed')
    const status = await readMirrorStatus(downstream.storage, backup)
    expect(status?.lastRun?.ok).toBe(false)
    expect(status?.lastRun?.error).toBeTruthy()
    expect(await localRefs(downstream.storage, backup)).toEqual({})
  })
})
