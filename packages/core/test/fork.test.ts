import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { compactRepository } from '../src/compaction.ts'
import { forkRepository, sharesObjectsWith, transferObjects } from '../src/fork.ts'
import { handleGitRequest } from '../src/http.ts'
import { lfsObjectSize } from '../src/lfs.ts'
import { MemoryStorage } from '../src/memory-storage.ts'
import { alternatesKey, createRepository, ObjectDatabase, readRefs } from '../src/repository.ts'
import { commitAll, gitEnv, initRepo, sampleHistory, tempDir, writeFile } from './git-helpers.ts'
import { type RunningServer, startServer } from './http-server.ts'

const run = promisify(execFile)

const gitAsync = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await run('git', args, { cwd, env: { ...process.env, ...gitEnv }, maxBuffer: 256 * 1024 * 1024 })
  return stdout
}

let storage: MemoryStorage
let server: RunningServer

beforeAll(async () => {
  server = await startServer(async (request) => (await handleGitRequest(request, { storage })) ?? new Response('not found', { status: 404 }))
})

afterAll(async () => {
  await server.close()
})

beforeEach(() => {
  storage = new MemoryStorage()
})

const upstream = { owner: 'acme', name: 'site' }
const fork = { owner: 'bob', name: 'site' }
const remote = (repo: { owner: string; name: string }) => `${server.url}/${repo.owner}/${repo.name}.git`

const seed = async () => {
  await createRepository(storage, upstream)
  const source = initRepo()
  sampleHistory(source, 4)
  await gitAsync(source, ['push', '-q', remote(upstream), 'main'])
  await gitAsync(source, ['tag', 'v1'])
  await gitAsync(source, ['push', '-q', remote(upstream), 'v1'])
  return source
}

describe('forks', () => {
  it('share the upstream objects through alternates and clone with smart and dumb HTTP', async () => {
    const source = await seed()
    const state = await forkRepository(storage, upstream, fork)
    expect(Object.keys(state.refs).sort()).toEqual(['refs/heads/main', 'refs/tags/v1'])
    expect(await sharesObjectsWith(storage, fork, upstream)).toBe(true)
    expect(new TextDecoder().decode((await (await storage.get(alternatesKey(fork)))!.body.getReader().read()).value)).toBe('../../../../acme/site/git/objects\n')
    expect(await new ObjectDatabase(storage, fork).packNames()).toEqual([])
    const head = (await gitAsync(source, ['rev-parse', 'HEAD'])).trim()
    for (const protocol of ['2', '0']) {
      const clone = tempDir()
      await gitAsync(clone, ['-c', `protocol.version=${protocol}`, 'clone', '-q', remote(fork), 'out'])
      expect((await gitAsync(`${clone}/out`, ['rev-parse', 'HEAD'])).trim()).toBe(head)
      expect(await gitAsync(`${clone}/out`, ['fsck', '--full', '--strict'])).toBe('')
    }
  })

  it('accepts pushes that build on upstream objects, compacts only its own packs and moves objects back', async () => {
    const source = await seed()
    await forkRepository(storage, upstream, fork)
    for (let i = 0; i < 3; i++) {
      writeFile(source, `fork-${i}.txt`, `fork change ${i}\n`)
      commitAll(source, `fork ${i}`)
      await gitAsync(source, ['push', '-q', remote(fork), 'HEAD:refs/heads/feature'])
    }
    const forkDb = new ObjectDatabase(storage, fork)
    expect((await forkDb.ownPacks()).length).toBe(3)
    expect((await compactRepository(storage, fork, { all: true }))?.merged).toHaveLength(3)
    const compacted = new ObjectDatabase(storage, fork)
    expect((await compacted.ownPacks()).length).toBe(1)
    expect((await compacted.packs()).length).toBeGreaterThan(1)
    const tip = (await readRefs(storage, fork))!.state.refs['refs/heads/feature']!
    const upstreamDb = new ObjectDatabase(storage, upstream)
    expect(await upstreamDb.has(tip)).toBe(false)
    const main = (await readRefs(storage, upstream))!.state.refs['refs/heads/main']!
    const moved = await transferObjects(compacted, upstreamDb, [tip], [main])
    expect(moved.objects).toBe(9)
    expect(await new ObjectDatabase(storage, upstream).has(tip)).toBe(true)
    expect((await transferObjects(compacted, new ObjectDatabase(storage, upstream), [tip], [main])).objects).toBe(0)
  })

  it('finds LFS objects of the upstream repository', async () => {
    await seed()
    await forkRepository(storage, upstream, fork)
    const oid = 'a'.repeat(64)
    await storage.put(`repos/acme/site/lfs/objects/aa/aa/${oid}`, new Uint8Array(5), 5)
    expect(await lfsObjectSize(storage, fork, oid)).toBe(5)
    expect(await lfsObjectSize(storage, upstream, 'b'.repeat(64))).toBeNull()
  })
})
