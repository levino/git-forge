import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { compactRepository } from '../src/compaction.ts'
import { forkRepository, sharesObjectsWith, transferObjects } from '../src/fork.ts'
import { handleGitRequest } from '../src/http.ts'
import { copyLfsObjects, lfsObjectKey, lfsObjectSize, storeLfsObject } from '../src/lfs.ts'
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
  it('share the upstream objects through alternates and clone over smart HTTP only', async () => {
    const source = await seed()
    const state = await forkRepository(storage, upstream, fork)
    expect(Object.keys(state.refs).sort()).toEqual(['refs/heads/main', 'refs/tags/v1'])
    expect(await sharesObjectsWith(storage, fork, upstream)).toBe(true)
    expect(new TextDecoder().decode((await (await storage.get(alternatesKey(fork)))!.body.getReader().read()).value)).toBe('../../../../acme/site/git/objects\n')
    expect(await new ObjectDatabase(storage, fork).packNames()).toEqual([])
    const head = (await gitAsync(source, ['rev-parse', 'HEAD'])).trim()
    const clone = tempDir()
    await gitAsync(clone, ['clone', '-q', remote(fork), 'out'])
    expect((await gitAsync(`${clone}/out`, ['rev-parse', 'HEAD'])).trim()).toBe(head)
    expect(await gitAsync(`${clone}/out`, ['fsck', '--full', '--strict'])).toBe('')
    const pack = (await new ObjectDatabase(storage, upstream).packNames())[0]!
    for (const path of ['info/refs', 'objects/info/packs', `objects/pack/${pack}`]) expect((await fetch(`${remote(fork)}/${path}`)).status).toBe(404)
    await expect(gitAsync(tempDir(), ['-c', 'protocol.version=0', 'clone', '-q', remote(fork), 'out'])).rejects.toThrow()
  })

  it('serves only objects reachable from its own refs', async () => {
    const source = await seed()
    await forkRepository(storage, upstream, fork)
    const forked = (await gitAsync(source, ['rev-parse', 'HEAD'])).trim()
    const parent = (await gitAsync(source, ['rev-parse', 'HEAD~1'])).trim()
    writeFile(source, 'later.txt', 'pushed upstream after the fork\n')
    commitAll(source, 'later')
    await gitAsync(source, ['push', '-q', remote(upstream), 'main'])
    const later = (await gitAsync(source, ['rev-parse', 'HEAD'])).trim()
    const blob = (await gitAsync(source, ['rev-parse', 'HEAD:later.txt'])).trim()
    const clone = `${tempDir()}/out`
    await gitAsync(tempDir(), ['clone', '-q', '--bare', remote(fork), clone])
    expect((await gitAsync(clone, ['rev-parse', 'main'])).trim()).toBe(forked)
    expect(await gitAsync(clone, ['fsck', '--full', '--strict'])).toBe('')
    for (const id of [later, blob]) await expect(gitAsync(clone, ['cat-file', '-e', id])).rejects.toThrow()
    await expect(gitAsync(clone, ['fetch', '-q', 'origin', later])).rejects.toThrow(/not our ref/)
    const shallow = `${tempDir()}/shallow`
    await gitAsync(tempDir(), ['clone', '-q', '--bare', '--depth=1', remote(fork), shallow])
    await gitAsync(shallow, ['fetch', '-q', '--depth=1', 'origin', parent])
    expect((await gitAsync(shallow, ['cat-file', '-t', parent])).trim()).toBe('commit')
    await expect(gitAsync(shallow, ['fetch', '-q', 'origin', later])).rejects.toThrow(/not our ref/)
    await gitAsync(source, ['push', '-q', remote(fork), 'main'])
    await gitAsync(clone, ['fetch', '-q', 'origin', 'main:main'])
    expect((await gitAsync(clone, ['cat-file', '-t', blob])).trim()).toBe('blob')
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

  it('serves upstream LFS objects only when its own refs point at them', async () => {
    const source = await seed()
    await forkRepository(storage, upstream, fork)
    const objects = ['in the fork\n', 'upstream only\n'].map((text) => new TextEncoder().encode(text))
    const specs = []
    for (const content of objects) {
      const oid = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', content)), (byte) => byte.toString(16).padStart(2, '0')).join('')
      expect((await storeLfsObject(storage, upstream, { oid, size: content.length }, new Blob([content]).stream())).ok).toBe(true)
      specs.push({ oid, size: content.length })
    }
    writeFile(source, 'a.bin', `version https://git-lfs.github.com/spec/v1\noid sha256:${specs[0]!.oid}\nsize ${specs[0]!.size}\n`)
    commitAll(source, 'pointer')
    await gitAsync(source, ['push', '-q', remote(fork), 'HEAD:refs/heads/lfs'])
    const response = await fetch(`${remote(fork)}/info/lfs/objects/batch`, {
      method: 'POST',
      headers: { Accept: 'application/vnd.git-lfs+json', 'Content-Type': 'application/vnd.git-lfs+json' },
      body: JSON.stringify({ operation: 'download', objects: specs }),
    })
    const { objects: described } = (await response.json()) as { objects: { oid: string; actions?: unknown; error?: { code: number } }[] }
    expect(described.map((object) => [object.oid, object.actions ? 'ok' : object.error?.code])).toEqual([
      [specs[0]!.oid, 'ok'],
      [specs[1]!.oid, 404],
    ])
    expect((await fetch(`${remote(fork)}/info/lfs/objects/${specs[0]!.oid}`)).status).toBe(200)
    expect((await fetch(`${remote(fork)}/info/lfs/objects/${specs[1]!.oid}`)).status).toBe(404)
    expect((await fetch(`${remote(upstream)}/info/lfs/objects/${specs[1]!.oid}`)).status).toBe(200)
  })

  it('finds LFS objects of the upstream repository', async () => {
    await seed()
    await forkRepository(storage, upstream, fork)
    const oid = 'a'.repeat(64)
    await storage.put(`repos/acme/site/lfs/objects/aa/aa/${oid}`, new Uint8Array(5), 5)
    expect(await lfsObjectSize(storage, fork, oid)).toBe(5)
    expect(await lfsObjectSize(storage, upstream, 'b'.repeat(64))).toBeNull()
  })

  it('copies the LFS objects of transferred pointers into the target', async () => {
    const source = await seed()
    await forkRepository(storage, upstream, fork)
    const content = new TextEncoder().encode('only in the fork\n')
    const oid = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', content)), (byte) => byte.toString(16).padStart(2, '0')).join('')
    const spec = { oid, size: content.length }
    expect((await storeLfsObject(storage, fork, spec, new Blob([content]).stream())).ok).toBe(true)
    writeFile(source, 'photo.bin', `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${content.length}\n`)
    commitAll(source, 'pointer')
    await gitAsync(source, ['push', '-q', remote(fork), 'HEAD:refs/heads/photo'])
    const tip = (await readRefs(storage, fork))!.state.refs['refs/heads/photo']!
    const main = (await readRefs(storage, upstream))!.state.refs['refs/heads/main']!
    const moved = await transferObjects(new ObjectDatabase(storage, fork), new ObjectDatabase(storage, upstream), [tip], [main])
    expect(moved.lfsPointers).toEqual([spec])
    expect(await lfsObjectSize(storage, upstream, oid)).toBeNull()
    expect(await copyLfsObjects(storage, fork, upstream, moved.lfsPointers)).toBe(1)
    expect((await storage.head(lfsObjectKey(upstream, oid)))?.size).toBe(content.length)
    expect(await copyLfsObjects(storage, fork, upstream, moved.lfsPointers)).toBe(0)
  })
})
