import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createRepository, handleGitRequest, MemoryStorage, readRefs, type RepositoryName } from '@git-forge/core'
import { gitEnv, tempDir, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { randomBytes } from '@git-forge/core/test/mirror-helpers.ts'
import { afterEach, describe, expect, it } from 'vitest'

const run = promisify(execFile)

const binDir = (() => {
  const dir = tempDir('git-forge-bin-')
  const script = join(dir, 'git-forge')
  const main = resolve(import.meta.dirname, '../src/main.ts')
  writeFileSync(script, `#!/bin/sh\nexec "${process.execPath}" --no-warnings "${main}" "$@"\n`)
  chmodSync(script, 0o755)
  return dir
})()

const env = { ...process.env, ...gitEnv, PATH: `${binDir}:${process.env.PATH ?? ''}` }

const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await run('git', args, { cwd, env, maxBuffer: 256 * 1024 * 1024 })
  return stdout
}

const attempt = async (cwd: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
  try {
    const { stdout, stderr } = await run('git', args, { cwd, env, maxBuffer: 256 * 1024 * 1024 })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

type TestForge = {
  readonly url: string
  readonly storage: MemoryStorage
  readonly pushes: () => number
  failPush: number | null
}

const servers: RunningServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const repo: RepositoryName = { owner: 'village', name: 'archive' }

const startTestForge = async (maxRequestBytes: number): Promise<TestForge> => {
  const storage = new MemoryStorage()
  await createRepository(storage, repo)
  let pushes = 0
  const forge: TestForge = {
    url: '',
    storage,
    pushes: () => pushes,
    failPush: null,
  }
  const server = await startServer(async (request) => {
    if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/git-receive-pack')) {
      pushes++
      if (forge.failPush === pushes) {
        await request.arrayBuffer()
        return new Response('simulated outage\n', { status: 502 })
      }
    }
    return (await handleGitRequest(request, { storage, maxRequestBytes })) ?? new Response('not found\n', { status: 404 })
  })
  servers.push(server)
  return Object.assign(forge, { url: `${server.url}/${repo.owner}/${repo.name}.git` })
}

const commit = async (dir: string, message: string) => {
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '--allow-empty', '-m', message])
}

const largeHistory = async (dir: string, commits: number, bytesPerCommit: number, seed = 1) => {
  for (let i = 0; i < commits; i++) {
    writeFile(dir, `data/${seed}-${i}.bin`, randomBytes(bytesPerCommit, seed * 1000 + i + 1))
    writeFile(dir, `log-${seed}.txt`, `entry ${seed}-${i}\n`)
    await commit(dir, `commit ${seed}-${i}`)
  }
}

const newRepo = async (): Promise<string> => {
  const dir = tempDir()
  await git(dir, ['init', '-q', '-b', 'main'])
  return dir
}

const remoteRefs = async (url: string): Promise<Map<string, string>> => {
  const refs = new Map<string, string>()
  for (const line of (await git(binDir, ['ls-remote', url])).trim().split('\n').filter(Boolean)) {
    const [id, name] = line.split('\t') as [string, string]
    refs.set(name, id)
  }
  return refs
}

const objectSet = async (url: string): Promise<string[]> => {
  const dir = tempDir('git-forge-clone-')
  await git(dir, ['clone', '-q', '--mirror', url, 'clone.git'])
  const listed = await git(join(dir, 'clone.git'), ['rev-list', '--objects', '--all'])
  return listed
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' ')[0] as string)
    .sort()
}

const visible = (refs: Map<string, string>) => new Map([...refs].filter(([name]) => !name.startsWith('refs/archive/')))

const BUDGET = 300_000

describe('git forge push', () => {
  it('splits a push larger than the budget and lands the same refs and objects as a normal push', async () => {
    const source = await newRepo()
    await largeHistory(source, 12, 60_000)
    await git(source, ['tag', '-a', 'v1', '-m', 'release 1'])
    await largeHistory(source, 6, 60_000, 2)
    const limited = await startTestForge(BUDGET)
    const plain = await startTestForge(64 * 1024 * 1024)

    const rejected = await attempt(source, ['push', limited.url, 'main'])
    expect(rejected.code).not.toBe(0)
    expect(rejected.stderr).toMatch(/413|exceeds|unexpected disconnect|RPC failed/i)

    const result = await attempt(source, ['forge', 'push', '--max-bytes', String(BUDGET), limited.url, 'main', 'v1'])
    expect(result.stderr).toContain('chunk 3')
    expect(result.code).toBe(0)
    expect(limited.pushes()).toBeGreaterThan(4)

    await git(source, ['push', '-q', plain.url, 'main', 'v1'])
    const chunked = await remoteRefs(limited.url)
    expect(chunked).toEqual(await remoteRefs(plain.url))
    expect([...chunked.keys()].some((name) => name.startsWith('refs/forge-chunk/') || name.startsWith('refs/archive/'))).toBe(false)
    expect(await objectSet(limited.url)).toEqual(await objectSet(plain.url))

    const again = await attempt(source, ['forge', 'push', '--max-bytes', String(BUDGET), limited.url, 'main'])
    expect(again.code).toBe(0)
    expect(again.stderr).toContain('up to date')
  })

  it('resumes after an interrupted chunk without resending what already landed', async () => {
    const source = await newRepo()
    await largeHistory(source, 16, 60_000)
    const reference = await startTestForge(BUDGET)
    const interrupted = await startTestForge(BUDGET)

    expect((await attempt(source, ['forge', 'push', '--max-bytes', String(BUDGET), reference.url, 'main'])).code).toBe(0)
    const uninterruptedPushes = reference.pushes()

    interrupted.failPush = 3
    const first = await attempt(source, ['forge', 'push', '--max-bytes', String(BUDGET), interrupted.url, 'main'])
    expect(first.code).not.toBe(0)
    const landed = (await readRefs(interrupted.storage, repo))?.state.refs['refs/heads/main']
    expect(landed).toBeDefined()
    expect(landed).not.toBe((await git(source, ['rev-parse', 'main'])).trim())

    const second = await attempt(source, ['forge', 'push', '--max-bytes', String(BUDGET), interrupted.url, 'main'])
    expect(second.code).toBe(0)
    expect(interrupted.pushes() - 1).toBe(uninterruptedPushes)
    expect(await remoteRefs(interrupted.url)).toEqual(await remoteRefs(reference.url))
    expect(await objectSet(interrupted.url)).toEqual(await objectSet(reference.url))
  })

  it('pushes a large merged side branch through temporary refs and removes them at the end', async () => {
    const source = await newRepo()
    await largeHistory(source, 2, 1000)
    await git(source, ['checkout', '-q', '-b', 'side'])
    await largeHistory(source, 10, 60_000, 3)
    await git(source, ['checkout', '-q', 'main'])
    await largeHistory(source, 2, 1000, 4)
    await git(source, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side'])
    const limited = await startTestForge(BUDGET)
    const plain = await startTestForge(64 * 1024 * 1024)

    const result = await attempt(source, ['forge', 'push', '--max-bytes', String(BUDGET), limited.url, 'main'])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('refs/forge-chunk/heads/main/')
    await git(source, ['push', '-q', plain.url, 'main'])
    const refs = await remoteRefs(limited.url)
    expect(visible(refs)).toEqual(await remoteRefs(plain.url))
    expect([...refs.keys()].some((name) => name.startsWith('refs/forge-chunk/'))).toBe(false)
    expect(await objectSet(limited.url)).toEqual(await objectSet(plain.url))
  })

  it('force-pushes rewritten history in chunks and archives the old tip once', async () => {
    const source = await newRepo()
    await largeHistory(source, 3, 1000)
    const forge = await startTestForge(BUDGET)
    await git(source, ['push', '-q', forge.url, 'main'])
    const old = (await git(source, ['rev-parse', 'main'])).trim()
    await git(source, ['reset', '-q', '--hard', 'HEAD~1'])
    await largeHistory(source, 10, 60_000, 5)

    const refused = await attempt(source, ['forge', 'push', '--max-bytes', String(BUDGET), forge.url, 'main'])
    expect(refused.code).not.toBe(0)
    expect(refused.stderr).toContain('not an ancestor')

    const forced = await attempt(source, ['forge', 'push', '--max-bytes', String(BUDGET), forge.url, '+main'])
    expect(forced.code).toBe(0)
    const refs = await remoteRefs(forge.url)
    expect(refs.get('refs/heads/main')).toBe((await git(source, ['rev-parse', 'main'])).trim())
    const archived = [...refs].filter(([name]) => name.startsWith('refs/archive/'))
    expect(archived.map(([, id]) => id)).toEqual([old])
  })

  it('refuses a single commit above the budget and suggests Git LFS', async () => {
    const source = await newRepo()
    writeFile(source, 'huge.bin', randomBytes(400_000, 9))
    await commit(source, 'huge')
    mkdirSync(join(source, 'more'))
    const forge = await startTestForge(BUDGET)
    const result = await attempt(source, ['forge', 'push', '--max-bytes', String(BUDGET), forge.url, 'main'])
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/alone needs more than .*Git LFS/s)
    expect(forge.pushes()).toBe(0)
  })

  it('prints the plan without pushing in dry-run mode', async () => {
    const source = await newRepo()
    await largeHistory(source, 8, 60_000)
    const forge = await startTestForge(BUDGET)
    const result = await attempt(source, ['forge', 'push', '-n', '--max-bytes', String(BUDGET), forge.url, 'main'])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('chunk 2')
    expect(forge.pushes()).toBe(0)
  })
})
