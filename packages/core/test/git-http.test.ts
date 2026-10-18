import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { compactRepository } from '../src/compaction.ts'
import { type GitHttpOptions, handleGitRequest, publicPackfileUris } from '../src/http.ts'
import { MemoryStorage } from '../src/memory-storage.ts'
import { createRepository, ObjectDatabase, packKey, readRefs } from '../src/repository.ts'
import { commitAll, gitEnv, initRepo, sampleHistory, tempDir, writeFile } from './git-helpers.ts'
import { type RunningServer, startServer } from './http-server.ts'

const run = promisify(execFile)

const gitAsync = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await run('git', args, { cwd, env: { ...process.env, ...gitEnv }, maxBuffer: 256 * 1024 * 1024 })
  return stdout
}

const gitFails = async (cwd: string, args: readonly string[]): Promise<string> => {
  try {
    await gitAsync(cwd, args)
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? error)
  }
  throw new Error(`git ${args.join(' ')} unexpectedly succeeded`)
}

let storage: MemoryStorage
let server: RunningServer
let repoCounter = 0
let extra: Partial<GitHttpOptions> = {}

beforeAll(async () => {
  server = await startServer(async (request) => (await handleGitRequest(request, { storage, ...extra })) ?? new Response('not found', { status: 404 }))
})

afterAll(async () => {
  await server.close()
})

beforeEach(() => {
  storage = new MemoryStorage()
  extra = {}
})

const newRemote = async (): Promise<string> => {
  const name = `repo${++repoCounter}`
  await createRepository(storage, { owner: 'test', name })
  return `${server.url}/test/${name}.git`
}

const log = (dir: string, ref = 'HEAD') => gitAsync(dir, ['log', '--format=%H %s', ref])

describe('git over HTTP', () => {
  it('pushes and clones with protocol v2', async () => {
    const remote = await newRemote()
    const source = initRepo()
    sampleHistory(source, 5)
    await gitAsync(source, ['push', remote, 'main'])
    const clone = tempDir()
    await gitAsync(clone, ['clone', '-q', remote, 'out'])
    expect(await log(`${clone}/out`)).toBe(await log(source))
    expect(await gitAsync(`${clone}/out`, ['fsck', '--full', '--strict'])).toBe('')
    expect(server.requests.some((request) => request.path.endsWith('/git-upload-pack'))).toBe(true)
  })

  it('clones over dumb HTTP when protocol v0 is requested', async () => {
    const remote = await newRemote()
    const source = initRepo()
    sampleHistory(source, 4)
    await gitAsync(source, ['push', remote, 'main'])
    const clone = tempDir()
    const before = server.requests.length
    await gitAsync(clone, ['-c', 'protocol.version=0', 'clone', '-q', remote, 'out'])
    expect(await log(`${clone}/out`)).toBe(await log(source))
    const newRequests = server.requests.slice(before)
    expect(newRequests.some((request) => request.path.includes('/objects/pack/'))).toBe(true)
    expect(newRequests.some((request) => request.path.endsWith('/git-upload-pack'))).toBe(false)
  })

  it('accepts incremental pushes with thin packs and fetches only new objects', async () => {
    const remote = await newRemote()
    const source = initRepo()
    sampleHistory(source, 3)
    await gitAsync(source, ['push', remote, 'main'])
    const clone = tempDir()
    await gitAsync(clone, ['clone', '-q', remote, 'out'])
    sampleHistory(source, 6)
    await gitAsync(source, ['push', remote, 'main'])
    await gitAsync(`${clone}/out`, ['pull', '-q', '--ff-only'])
    expect(await log(`${clone}/out`)).toBe(await log(source))
    expect(await gitAsync(`${clone}/out`, ['fsck', '--full', '--strict'])).toBe('')
    const dumb = tempDir()
    await gitAsync(dumb, ['-c', 'protocol.version=0', 'clone', '-q', remote, 'out'])
    expect(await gitAsync(`${dumb}/out`, ['fsck', '--full', '--strict'])).toBe('')
  })

  it('handles branches, annotated tags and deletes', async () => {
    const remote = await newRemote()
    const source = initRepo()
    sampleHistory(source, 2)
    await gitAsync(source, ['tag', '-a', 'v1', '-m', 'release 1'])
    await gitAsync(source, ['checkout', '-q', '-b', 'feature'])
    writeFile(source, 'feature.txt', 'feature\n')
    commitAll(source, 'feature commit')
    await gitAsync(source, ['push', remote, 'main', 'feature', '--tags'])
    const remoteRefs = await gitAsync(source, ['ls-remote', remote])
    expect(remoteRefs).toContain('refs/heads/feature')
    expect(remoteRefs).toContain('refs/tags/v1^{}')
    const clone = tempDir()
    await gitAsync(clone, ['clone', '-q', remote, 'out'])
    expect(await gitAsync(`${clone}/out`, ['describe', '--tags', 'origin/main'])).toBe('v1\n')
    await gitAsync(source, ['push', remote, '--delete', 'feature'])
    expect(await gitAsync(source, ['ls-remote', '--heads', remote])).not.toContain('refs/heads/feature')
  })

  it('archives the previous state on force push and branch deletion', async () => {
    const remote = await newRemote()
    const source = initRepo()
    const [, second] = sampleHistory(source, 2) as [string, string]
    await gitAsync(source, ['push', remote, 'main'])
    await gitAsync(source, ['reset', '-q', '--hard', 'HEAD~1'])
    writeFile(source, 'rewrite.txt', 'rewritten\n')
    commitAll(source, 'rewritten history')
    expect(await gitFails(source, ['push', remote, 'main'])).toMatch(/rejected|non-fast-forward|fetch first/)
    await gitAsync(source, ['push', '--force', remote, 'main'])
    const refs = (await readRefs(storage, { owner: 'test', name: `repo${repoCounter}` }))?.state.refs ?? {}
    const archived = Object.entries(refs).filter(([name]) => name.startsWith('refs/archive/'))
    expect(archived.map(([, id]) => id)).toContain(second)
    expect(await gitFails(source, ['push', remote, 'HEAD:refs/archive/evil'])).toMatch(/invalid ref name|rejected/)
  })

  it('rejects pushes based on stale refs', async () => {
    const remote = await newRemote()
    const a = initRepo()
    sampleHistory(a, 1)
    await gitAsync(a, ['push', remote, 'main'])
    const b = tempDir()
    await gitAsync(b, ['clone', '-q', remote, 'out'])
    writeFile(a, 'a.txt', 'a\n')
    commitAll(a, 'from a')
    await gitAsync(a, ['push', remote, 'main'])
    writeFile(`${b}/out`, 'b.txt', 'b\n')
    commitAll(`${b}/out`, 'from b')
    expect(await gitFails(`${b}/out`, ['push', 'origin', 'main'])).toMatch(/fetch first|rejected/)
  })

  it('supports empty repositories and pushing to them', async () => {
    const remote = await newRemote()
    const clone = tempDir()
    await gitAsync(clone, ['clone', '-q', remote, 'empty'])
    writeFile(`${clone}/empty`, 'first.txt', 'first\n')
    commitAll(`${clone}/empty`, 'first')
    await gitAsync(`${clone}/empty`, ['push', '-q', 'origin', 'HEAD:main'])
    expect(await gitAsync(clone, ['ls-remote', remote])).toContain('refs/heads/main')
  })

  it('returns 404 for unknown repositories', async () => {
    const dir = tempDir()
    expect(await gitFails(dir, ['ls-remote', `${server.url}/test/missing.git`])).toMatch(/not found|404/)
  })

  it('handles concurrent pushes to different branches', async () => {
    const remote = await newRemote()
    const base = initRepo()
    sampleHistory(base, 1)
    await gitAsync(base, ['push', remote, 'main'])
    const clones = await Promise.all(
      Array.from({ length: 4 }, async (_, i) => {
        const dir = tempDir()
        await gitAsync(dir, ['clone', '-q', remote, 'c'])
        writeFile(`${dir}/c`, `file-${i}.txt`, `${i}\n`)
        commitAll(`${dir}/c`, `branch ${i}`)
        return `${dir}/c`
      }),
    )
    await Promise.all(clones.map((dir, i) => gitAsync(dir, ['push', '-q', 'origin', `HEAD:refs/heads/b${i}`])))
    const heads = await gitAsync(base, ['ls-remote', '--heads', remote])
    for (let i = 0; i < 4; i++) expect(heads).toContain(`refs/heads/b${i}`)
  })

  it('clones a repository of many packs with duplicate objects, in-band and over packfile-uris', async () => {
    const remote = await newRemote()
    const repo = { owner: 'test', name: `repo${repoCounter}` }
    const source = initRepo()
    for (let round = 1; round <= 4; round++) {
      sampleHistory(source, round * 2)
      await gitAsync(source, ['push', '-q', remote, 'main'])
    }
    expect((await new ObjectDatabase(storage, repo).packNames()).length).toBe(4)
    const plain = tempDir()
    await gitAsync(plain, ['clone', '-q', remote, 'out'])
    expect(await log(`${plain}/out`)).toBe(await log(source))
    expect(await gitAsync(`${plain}/out`, ['fsck', '--full', '--strict'])).toBe('')
    expect(await gitAsync(`${plain}/out`, ['-c', 'transfer.fsckObjects=true', 'fetch', '-q', 'origin'])).toBe('')
    const strict = tempDir()
    await gitAsync(strict, ['-c', 'transfer.fsckObjects=true', 'clone', '-q', remote, 'out'])
    extra = { packfileUris: publicPackfileUris() }
    const before = server.requests.length
    const viaUris = tempDir()
    await gitAsync(viaUris, ['-c', 'fetch.uriProtocols=http', 'clone', '-q', remote, 'out'])
    expect(await log(`${viaUris}/out`)).toBe(await log(source))
    expect(await gitAsync(`${viaUris}/out`, ['fsck', '--full', '--strict'])).toBe('')
    const downloads = server.requests.slice(before).filter((request) => request.path.includes('/objects/pack/pack-'))
    expect(downloads.length).toBe(4)
    const withoutUris = tempDir()
    await gitAsync(withoutUris, ['clone', '-q', remote, 'out'])
    expect(server.requests.slice(before).filter((request) => request.path.includes('/objects/pack/pack-')).length).toBe(4)
  })

  it('compacts packs into one without deleting anything and keeps every protocol working', async () => {
    const remote = await newRemote()
    const repo = { owner: 'test', name: `repo${repoCounter}` }
    const source = initRepo()
    sampleHistory(source, 2)
    await gitAsync(source, ['push', '-q', remote, 'main'])
    const early = tempDir()
    await gitAsync(early, ['clone', '-q', remote, 'out'])
    for (let round = 2; round <= 5; round++) {
      sampleHistory(source, round * 2)
      await gitAsync(source, ['push', '-q', remote, 'main'])
    }
    const odb = new ObjectDatabase(storage, repo)
    const before = await odb.packNames()
    expect(before.length).toBe(5)
    const result = await compactRepository(storage, repo, { all: true })
    expect(result?.merged.length).toBe(5)
    expect(result?.duplicates).toBeGreaterThan(0)
    expect(await odb.packNames()).toEqual([result?.pack])
    for (const name of before) expect(await storage.head(packKey(repo, name))).not.toBeNull()
    expect(await compactRepository(storage, repo, { all: true })).toBeNull()
    const clone = tempDir()
    await gitAsync(clone, ['clone', '-q', remote, 'out'])
    expect(await log(`${clone}/out`)).toBe(await log(source))
    expect(await gitAsync(`${clone}/out`, ['fsck', '--full', '--strict'])).toBe('')
    const dumb = tempDir()
    await gitAsync(dumb, ['-c', 'protocol.version=0', 'clone', '-q', remote, 'out'])
    expect(await gitAsync(`${dumb}/out`, ['fsck', '--full', '--strict'])).toBe('')
    await gitAsync(`${early}/out`, ['pull', '-q', '--ff-only'])
    expect(await log(`${early}/out`)).toBe(await log(source))
    sampleHistory(source, 12)
    await gitAsync(source, ['push', '-q', remote, 'main'])
    await gitAsync(`${early}/out`, ['pull', '-q', '--ff-only'])
    expect(await gitAsync(`${early}/out`, ['fsck', '--full', '--strict'])).toBe('')
  })
})

describe('push policy hook', () => {
  it('asks pushPolicy per request and reports its rejection per ref to real git', async () => {
    const seen: string[] = []
    const guarded = await startServer(
      async (request) =>
        (await handleGitRequest(request, {
          storage,
          receive: { policy: (command) => (command.name === 'refs/heads/frozen' ? 'frozen by receive.policy' : null) },
          pushPolicy: async (request, repo) => {
            seen.push(`${request.headers.get('X-Who')}:${repo.name}`)
            return (command) => (command.name === 'refs/heads/main' && !command.fastForward ? 'no rewrites' : null)
          },
        })) ?? new Response('not found', { status: 404 }),
    )
    try {
      await createRepository(storage, { owner: 'test', name: 'guarded' })
      const remote = `${guarded.url}/test/guarded.git`
      const source = initRepo()
      sampleHistory(source, 2)
      const header = ['-c', 'http.extraHeader=X-Who: tester']
      await gitAsync(source, [...header, 'push', '-q', remote, 'main', 'main:frozen-not'])
      await gitAsync(source, ['commit', '-q', '--amend', '-m', 'rewritten'])
      const stderr = await gitFails(source, [...header, 'push', '--force', remote, 'main', 'main:frozen'])
      expect(stderr).toContain('! [remote rejected] main -> main (no rewrites)')
      expect(stderr).toContain('! [remote rejected] main -> frozen (frozen by receive.policy)')
      expect(seen).toEqual(['tester:guarded', 'tester:guarded'])
      expect(Object.keys((await readRefs(storage, { owner: 'test', name: 'guarded' }))!.state.refs).sort()).toEqual(['refs/heads/frozen-not', 'refs/heads/main'])
    } finally {
      await guarded.close()
    }
  })
})
