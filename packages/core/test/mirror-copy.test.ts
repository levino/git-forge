import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { readAll } from '../src/bytes.ts'
import { lfsObjectKey } from '../src/lfs.ts'
import { MemoryStorage } from '../src/memory-storage.ts'
import { configureMirror, deepCheckMirror, deepCheckRepository, readMirrorStatus, syncMirror, type SyncOptions } from '../src/mirror.ts'
import { PackVerificationError, verifyPackIndex, verifyingPackStream } from '../src/pack-copy.ts'
import { gitPrefix, ObjectDatabase, readRefs, type RepositoryName } from '../src/repository.ts'
import type { Storage } from '../src/storage.ts'
import { commitAll, gitEnv, initRepo, sampleHistory, tempDir, writeFile } from './git-helpers.ts'
import { startServer, type RunningServer } from './http-server.ts'
import { chain, fakeLfs, type Forge, lfsPointer, putLfsObject, randomBytes, startForge, staticBucketHandler, storageLfsReader } from './mirror-helpers.ts'

const run = promisify(execFile)

const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await run('git', args, { cwd, env: { ...process.env, ...gitEnv }, maxBuffer: 256 * 1024 * 1024 })
  return stdout
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

const project: RepositoryName = { owner: 'village', name: 'archive' }
const backup: RepositoryName = { owner: 'backup', name: 'archive' }

const setup = async () => {
  const upstreamStorage = new MemoryStorage()
  const lfs = fakeLfs({ read: storageLfsReader(upstreamStorage, project) })
  const upstream = await forge(upstreamStorage, [lfs.handler])
  const downstream = await forge()
  const remote = await upstream.createRepo(project)
  await downstream.createRepo(backup)
  await configureMirror(downstream.storage, backup, { url: remote })
  const source = initRepo()
  sampleHistory(source, 3)
  const asset = randomBytes(200_000, 11)
  writeFile(source, 'media/photo.jpg', lfsPointer(asset).text)
  await putLfsObject(upstreamStorage, project, asset)
  const main = commitAll(source, 'add photo')
  await git(source, ['tag', '-a', 'v1', '-m', 'release 1'])
  await git(source, ['push', '-q', remote, 'main', '--tags'])
  const sync = (extra: Partial<SyncOptions> = {}) => syncMirror({ storage: downstream.storage, repo: backup, strategy: 'copy', ...extra })
  return { upstream, downstream, lfs, remote, source, main, asset, sync }
}

const packFiles = async (storage: Storage, repo: RepositoryName): Promise<Map<string, Uint8Array>> => {
  const files = new Map<string, Uint8Array>()
  const prefix = `${gitPrefix(repo)}objects/pack/`
  for await (const info of storage.list(prefix)) {
    const object = await storage.get(info.key)
    if (object) files.set(info.key.slice(prefix.length), await readAll(object.body))
  }
  return files
}

const fetchWithGit = async (url: string): Promise<string> => {
  const dir = tempDir()
  await git(dir, ['init', '-q', '--bare'])
  await git(dir, ['fetch', '-q', url, '+refs/upstream/*:refs/upstream/*', '+refs/archive/*:refs/archive/*'])
  expect(await git(dir, ['fsck', '--full', '--strict', '--no-dangling'])).toBe('')
  return dir
}

const upstreamPosts = (instance: Forge) => instance.server.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/git-upload-pack')).length

describe('copy-only mirror sync', () => {
  it('copies upstream packs byte for byte without re-indexing and without upload-pack', async () => {
    const context = await setup()
    const result = await context.sync()
    expect(result.status).toBe('ok')
    expect(result.strategy).toBe('copy')
    expect(result.copied?.packs).toBe(1)
    expect(result.scanned).toEqual({ objects: 0, commits: 0 })
    expect(upstreamPosts(context.upstream)).toBe(0)
    expect(await packFiles(context.downstream.storage, backup)).toEqual(await packFiles(context.upstream.storage, project))
    const refs = (await readRefs(context.downstream.storage, backup))?.state.refs ?? {}
    expect(refs['refs/upstream/origin/heads/main']).toBe(context.main)
    expect(refs['refs/upstream/origin/tags/v1']).toBeDefined()
    expect(result.lfs?.downloaded.map((pointer) => pointer.oid)).toEqual([lfsPointer(context.asset).oid])
    const stored = await context.downstream.storage.get(lfsObjectKey(backup, lfsPointer(context.asset).oid))
    expect(stored && (await readAll(stored.body))).toEqual(context.asset)
    const clone = await fetchWithGit(context.downstream.url(backup))
    expect((await git(clone, ['rev-parse', 'refs/upstream/origin/heads/main'])).trim()).toBe(context.main)
  })

  it('copies only new packs on incremental syncs and is idempotent', async () => {
    const context = await setup()
    await context.sync()
    writeFile(context.source, 'docs/new.md', 'new content\n')
    const next = commitAll(context.source, 'incremental')
    await git(context.source, ['push', '-q', context.remote, 'main'])
    const before = context.upstream.server.requests.length
    const incremental = await context.sync()
    expect(incremental.status).toBe('ok')
    expect(incremental.copied?.packs).toBe(1)
    expect(incremental.updates).toEqual([{ ref: 'refs/upstream/origin/heads/main', oldId: context.main, newId: next, kind: 'fast-forward' }])
    const packRequests = context.upstream.server.requests.slice(before).filter((request) => request.path.endsWith('.pack'))
    expect(packRequests).toHaveLength(1)
    expect(await packFiles(context.downstream.storage, backup)).toEqual(await packFiles(context.upstream.storage, project))

    const again = await context.sync()
    expect(again.status).toBe('ok')
    expect(again.updates).toEqual([])
    expect(again.copied).toEqual({ packs: 0, bytes: 0, reused: 0 })
  })

  it('archives rewritten history and raises an alarm', async () => {
    const context = await setup()
    await context.sync()
    await git(context.source, ['reset', '-q', '--hard', 'HEAD~1'])
    writeFile(context.source, 'rewrite.txt', 'rewritten\n')
    const rewritten = commitAll(context.source, 'rewritten')
    await git(context.source, ['push', '-q', '--force', context.remote, 'main'])
    const result = await context.sync()
    expect(result.status).toBe('ok')
    expect(result.alarms.map((alarm) => [alarm.kind, alarm.ref, alarm.oldId, alarm.newId])).toEqual([
      ['history-rewritten', 'refs/heads/main', context.main, rewritten],
    ])
    const refs = (await readRefs(context.downstream.storage, backup))?.state.refs ?? {}
    expect(refs[result.alarms[0]?.archivedAs as string]).toBe(context.main)
    await fetchWithGit(context.downstream.url(backup))
  })

  it('rejects a tampered pack and stores nothing', async () => {
    const context = await setup()
    const tampering = async (request: Request): Promise<Response> => {
      const response = await fetch(request)
      if (!request.url.endsWith('.pack')) return response
      const bytes = new Uint8Array(await response.arrayBuffer())
      bytes[100] = (bytes[100] as number) ^ 0xff
      return new Response(bytes, { headers: response.headers })
    }
    const result = await context.sync({ fetch: tampering })
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/trailer checksum mismatch/)
    expect(await packFiles(context.downstream.storage, backup)).toEqual(new Map())
    expect(await new ObjectDatabase(context.downstream.storage, backup).packNames()).toEqual([])
    expect((await context.sync()).status).toBe('ok')
  })

  it('rejects a pack whose index belongs to another pack', async () => {
    const context = await setup()
    const files = await packFiles(context.upstream.storage, project)
    const idx = [...files].find(([name]) => name.endsWith('.idx'))?.[1] as Uint8Array
    const forged = idx.slice()
    forged[forged.length - 30] = (forged[forged.length - 30] as number) ^ 1
    const swapping = async (request: Request): Promise<Response> =>
      request.url.endsWith('.idx') ? new Response(forged as Uint8Array<ArrayBuffer>) : fetch(request)
    const result = await context.sync({ fetch: swapping })
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/invalid pack index: checksum mismatch/)
  })

  it('mirrors a mirror from its static bucket files', async () => {
    const context = await setup()
    await context.sync()
    const bucket = await startServer(chain(staticBucketHandler(context.downstream.storage)))
    servers.push(bucket)
    const third = await forge()
    const tertiary: RepositoryName = { owner: 'third', name: 'archive' }
    await third.createRepo(tertiary)
    await configureMirror(third.storage, tertiary, {
      url: `${bucket.url}/${backup.owner}/${backup.name}.git`,
      namespace: 'upstream/origin/',
      lfsUrl: `${context.remote}/info/lfs`,
    })
    const result = await syncMirror({ storage: third.storage, repo: tertiary, strategy: 'copy' })
    expect(result.status).toBe('ok')
    expect(bucket.requests.every((request) => request.method === 'GET')).toBe(true)
    expect(await packFiles(third.storage, tertiary)).toEqual(await packFiles(context.upstream.storage, project))
    expect((await readRefs(third.storage, tertiary))?.state.refs['refs/upstream/origin/heads/main']).toBe(context.main)
    await fetchWithGit(third.url(tertiary))
  })
})

describe('deep check', () => {
  it('recomputes every index and walks every ref', async () => {
    const context = await setup()
    await context.sync()
    const check = await deepCheckMirror(context.downstream.storage, backup)
    expect(check).toEqual(expect.objectContaining({ ok: true, packs: 1, problems: [] }))
    expect(check.objects).toBeGreaterThan(10)
    expect((await readMirrorStatus(context.downstream.storage, backup))?.lastDeepCheck).toEqual(check)
  })

  it('reports an index that does not match its pack', async () => {
    const context = await setup()
    await context.sync()
    const [name, idx] = [...(await packFiles(context.downstream.storage, backup))].find(([file]) => file.endsWith('.idx')) as [string, Uint8Array]
    const damaged = idx.slice()
    const crcTable = 8 + 1024 + ((damaged[8 + 1020] as number) << 24 | (damaged[8 + 1021] as number) << 16 | (damaged[8 + 1022] as number) << 8 | (damaged[8 + 1023] as number)) * 20
    damaged[crcTable] = (damaged[crcTable] as number) ^ 1
    await context.downstream.storage.put(`${gitPrefix(backup)}objects/pack/${name}`, damaged, damaged.length)
    const check = await deepCheckRepository(context.downstream.storage, backup)
    expect(check.ok).toBe(false)
    expect(check.problems).toEqual([expect.stringMatching(/index differs from the recomputed index/)])
  })
})

describe('pack verification', () => {
  const sample = async () => {
    const context = await setup()
    const files = await packFiles(context.upstream.storage, project)
    const pack = [...files].find(([name]) => name.endsWith('.pack'))?.[1] as Uint8Array
    const idx = [...files].find(([name]) => name.endsWith('.idx'))?.[1] as Uint8Array
    return { pack, idx }
  }

  const pipe = async (bytes: Uint8Array, stream: TransformStream<Uint8Array, Uint8Array>, chunk = 7) => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += chunk) controller.enqueue(bytes.subarray(offset, offset + chunk))
        controller.close()
      },
    })
    return readAll(source.pipeThrough(stream))
  }

  it('passes a valid pack through unchanged in any chunking', async () => {
    const { pack, idx } = await sample()
    const index = verifyPackIndex(idx, pack.length)
    const expectation = { size: pack.length, objects: index.count, checksum: index.packChecksum }
    expect(await pipe(pack, verifyingPackStream(expectation), 1)).toEqual(pack)
    expect(await pipe(pack, verifyingPackStream(expectation), 4096)).toEqual(pack)
  })

  it('rejects an index whose offsets point outside the pack', async () => {
    const { pack, idx } = await sample()
    expect(() => verifyPackIndex(idx, 40)).toThrow(PackVerificationError)
    expect(() => verifyPackIndex(idx.subarray(0, idx.length - 1), pack.length)).toThrow(/size does not match/)
  })

  it('rejects a truncated pack and a wrong object count', async () => {
    const { pack, idx } = await sample()
    const index = verifyPackIndex(idx, pack.length)
    await expect(pipe(pack.subarray(0, pack.length - 5), verifyingPackStream({ size: pack.length, objects: index.count, checksum: index.packChecksum }))).rejects.toThrow(
      /expected/,
    )
    await expect(pipe(pack, verifyingPackStream({ size: pack.length, objects: index.count + 1, checksum: index.packChecksum }))).rejects.toThrow(/object count/)
  })
})
