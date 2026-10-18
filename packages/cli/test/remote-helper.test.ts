import { execFile } from 'node:child_process'
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { branchProtectionPolicy, type BranchProtectionRule, DEFAULT_PROTECTION } from '@git-forge/accounts'
import {
  createRepository,
  type GitHttpOptions,
  handleGitRequest,
  MemoryStorage,
  type PresignedPut,
  publicPackfileUris,
  readRefs,
  type RepositoryName,
  sha256Hex,
} from '@git-forge/core'
import { gitEnv, tempDir, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { randomBytes } from '@git-forge/core/test/mirror-helpers.ts'
import { afterEach, describe, expect, it } from 'vitest'

const run = promisify(execFile)

const TOKEN = 'forge-token'

const configDir = tempDir('git-forge-config-')

const binDir = (() => {
  const dir = tempDir('git-forge-bin-')
  const main = resolve(import.meta.dirname, '../src/main.ts')
  for (const [name, prefix] of [
    ['git-forge', ''],
    ['git-remote-forge', 'remote-helper '],
  ] as const) {
    const script = join(dir, name)
    writeFileSync(script, `#!/bin/sh\nexec "${process.execPath}" --no-warnings "${main}" ${prefix}"$@"\n`)
    chmodSync(script, 0o755)
  }
  return dir
})()

const env = {
  ...process.env,
  ...gitEnv,
  PATH: `${binDir}:${process.env.PATH ?? ''}`,
  GIT_FORGE_CONFIG_DIR: configDir,
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'credential.helper',
  GIT_CONFIG_VALUE_0: '!git-forge auth git-credential',
}

const attempt = async (cwd: string, args: readonly string[], extra: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> => {
  try {
    const { stdout, stderr } = await run('git', args, { cwd, env: { ...env, ...extra }, maxBuffer: 256 * 1024 * 1024 })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

const git = async (cwd: string, args: readonly string[], extra: Record<string, string> = {}): Promise<string> => {
  const result = await attempt(cwd, args, extra)
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

const repo: RepositoryName = { owner: 'village', name: 'archive' }

type ForgeSetup = {
  readonly maxPushBytes?: number
  readonly presign?: boolean
  readonly options?: Partial<GitHttpOptions>
}

type TestForge = {
  readonly origin: string
  readonly url: string
  readonly storage: MemoryStorage
  readonly server: RunningServer
  failPartsAfter: number | null
  partPuts: number
  bucketPuts: number
  receivePacks: number
}

const servers: RunningServer[] = []

const hosts: Record<string, unknown> = {}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const authorized = (request: Request): boolean => {
  const header = request.headers.get('Authorization') ?? ''
  if (!header.startsWith('Basic ')) return false
  return Buffer.from(header.slice(6), 'base64').toString('utf8').endsWith(`:${TOKEN}`)
}

const startForge = async (setup: ForgeSetup = {}): Promise<TestForge> => {
  const storage = new MemoryStorage()
  await createRepository(storage, repo)
  let origin = ''
  if (setup.presign) {
    ;(storage as MemoryStorage & { presignPut: unknown }).presignPut = async (key: string, size: number, sha: string, expires: number): Promise<PresignedPut> => ({
      url: `${origin}/__bucket/${key}`,
      headers: { 'x-amz-checksum-sha256': Buffer.from(sha, 'hex').toString('base64') },
      expiresAt: new Date(Date.now() + expires * 1000),
    })
  }
  const forge: TestForge = { origin: '', url: '', storage, server: undefined as unknown as RunningServer, failPartsAfter: null, partPuts: 0, bucketPuts: 0, receivePacks: 0 }
  const isPartUpload = (request: Request, path: string) => request.method === 'PUT' && (/\/forge\/uploads\/[^/]+\/parts\/\d+$/.test(path) || path.startsWith('/__bucket/'))
  const server = await startServer(async (request) => {
    const path = new URL(request.url).pathname
    if (isPartUpload(request, path)) {
      if (forge.failPartsAfter !== null && forge.partPuts + forge.bucketPuts >= forge.failPartsAfter) {
        await request.arrayBuffer()
        return new Response('simulated outage\n', { status: 503 })
      }
    }
    if (path.startsWith('/__bucket/')) {
      const bytes = new Uint8Array(await request.arrayBuffer())
      const expected = Buffer.from(request.headers.get('x-amz-checksum-sha256') ?? '', 'base64').toString('hex')
      if (sha256Hex(bytes) !== expected || Number(request.headers.get('Content-Length')) !== bytes.length) return new Response('BadDigest\n', { status: 400 })
      await storage.put(decodeURIComponent(path.slice('/__bucket/'.length)), bytes, bytes.length)
      forge.bucketPuts++
      return new Response(null, { status: 200 })
    }
    const publicPack = request.method === 'GET' && /\/objects\/pack\/pack-[0-9a-f]{40}\.pack$/.test(path)
    if (!publicPack && !authorized(request)) return new Response('authentication required\n', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="forge"' } })
    if (path.endsWith('/git-receive-pack') && request.method === 'POST') forge.receivePacks++
    const response = await handleGitRequest(request, {
      storage,
      ...(setup.maxPushBytes !== undefined ? { maxPushBytes: setup.maxPushBytes } : {}),
      packfileUris: publicPackfileUris(),
      ...setup.options,
    })
    if (response && isPartUpload(request, path) && response.ok) forge.partPuts++
    return response ?? new Response('not found\n', { status: 404 })
  })
  servers.push(server)
  origin = server.url
  hosts[server.url] = { login: 'tester', token: TOKEN, expiresAt: null }
  writeFileSync(join(configDir, 'hosts.json'), JSON.stringify(hosts))
  return Object.assign(forge, { origin: server.url, server, url: `${server.url}/${repo.owner}/${repo.name}` })
}

const commit = async (dir: string, message: string) => {
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '--allow-empty', '-m', message])
}

const largeHistory = async (dir: string, commits: number, bytesPerCommit: number, seed = 1) => {
  for (let i = 0; i < commits; i++) {
    writeFile(dir, `data/${seed}-${i}.bin`, randomBytes(bytesPerCommit, seed * 1000 + i + 1))
    await commit(dir, `commit ${seed}-${i}`)
  }
}

const newRepo = async (): Promise<string> => {
  const dir = tempDir()
  await git(dir, ['init', '-q', '-b', 'main'])
  return dir
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

const LIMIT = 200_000

const pending = (dir: string) => {
  const root = join(dir, '.git', 'forge-upload')
  return existsSync(root) ? readdirSync(root) : []
}

describe('git-remote-forge', () => {
  it('pushes more than the request body limit in parts and clones back through smart HTTP', async () => {
    const source = await newRepo()
    await largeHistory(source, 10, 60_000)
    await git(source, ['tag', '-a', 'v1', '-m', 'release 1'])
    const forge = await startForge({ maxPushBytes: LIMIT })
    const plain = await startForge()

    const rejected = await attempt(source, ['push', `${forge.url}.git`, 'main'])
    expect(rejected.code).not.toBe(0)
    const receivePacks = forge.receivePacks

    const pushed = await attempt(source, ['push', `forge::${forge.url}`, 'main', 'v1'])
    expect(pushed.stderr).toContain('[new branch]')
    expect(pushed.code).toBe(0)
    expect(forge.partPuts).toBeGreaterThan(2)
    expect(forge.receivePacks).toBe(receivePacks)
    expect(pending(source)).toEqual([])

    await git(source, ['push', '-q', `${plain.url}.git`, 'main', 'v1'])
    expect((await readRefs(forge.storage, repo))?.state.refs).toEqual((await readRefs(plain.storage, repo))?.state.refs)
    expect(await objectSet(`forge::${forge.url}`)).toEqual(await objectSet(`${plain.url}.git`))

    const clone = tempDir('git-forge-clone-')
    const traced = await attempt(clone, ['-c', 'fetch.uriprotocols=http', 'clone', `forge::${forge.url}`, 'work'], { GIT_TRACE_PACKET: '1' })
    expect(traced.code).toBe(0)
    expect(traced.stderr).toContain('packfile-uris')
    expect(forge.server.requests.some((request) => /\/objects\/pack\/pack-[0-9a-f]{40}\.pack$/.test(request.path))).toBe(true)
    expect((await git(join(clone, 'work'), ['rev-parse', 'HEAD'])).trim()).toBe((await git(source, ['rev-parse', 'main'])).trim())

    await largeHistory(source, 2, 60_000, 2)
    const incremental = await attempt(source, ['push', `forge::${forge.url}`, 'main'])
    expect(incremental.code).toBe(0)
    const fetched = await attempt(join(clone, 'work'), ['pull', '-q', '--ff-only'])
    expect(fetched.code).toBe(0)
    expect((await git(join(clone, 'work'), ['rev-parse', 'HEAD'])).trim()).toBe((await git(source, ['rev-parse', 'main'])).trim())
  })

  it('uploads parts directly to presigned object storage URLs', async () => {
    const source = await newRepo()
    await largeHistory(source, 6, 60_000)
    const forge = await startForge({ maxPushBytes: LIMIT, presign: true })
    const pushed = await attempt(source, ['push', `forge::${forge.url}`, 'main'])
    expect(pushed.code).toBe(0)
    expect(forge.bucketPuts).toBeGreaterThan(1)
    expect(forge.partPuts).toBe(0)
    expect((await readRefs(forge.storage, repo))?.state.refs['refs/heads/main']).toBe((await git(source, ['rev-parse', 'main'])).trim())
  })

  it('resumes an interrupted upload without resending the parts that landed', async () => {
    const source = await newRepo()
    await largeHistory(source, 10, 60_000)
    const forge = await startForge({ maxPushBytes: LIMIT })
    forge.failPartsAfter = 2

    const first = await attempt(source, ['push', `forge::${forge.url}`, 'main'])
    expect(first.code).not.toBe(0)
    expect(first.stderr).toContain('upload interrupted')
    expect(forge.partPuts).toBe(2)
    expect(pending(source)).toHaveLength(1)
    expect((await readRefs(forge.storage, repo))?.state.refs['refs/heads/main']).toBeUndefined()

    forge.failPartsAfter = null
    const second = await attempt(source, ['push', '--progress', `forge::${forge.url}`, 'main'])
    expect(second.code).toBe(0)
    expect(second.stderr).toContain('resuming upload, 2 of')
    const total = Number(/resuming upload, 2 of (\d+) parts/.exec(second.stderr)?.[1])
    expect(forge.partPuts).toBe(total)
    expect(pending(source)).toEqual([])
    expect((await readRefs(forge.storage, repo))?.state.refs['refs/heads/main']).toBe((await git(source, ['rev-parse', 'main'])).trim())
  })

  it('reports refs rejected by branch protection per ref', async () => {
    const source = await newRepo()
    await largeHistory(source, 3, 1000)
    const rule: BranchProtectionRule = { ...DEFAULT_PROTECTION, id: 'rule', repositoryId: 'repo', pattern: 'main', createdAt: 0, updatedAt: 0 }
    const forge = await startForge({
      maxPushBytes: LIMIT,
      options: { pushPolicy: async () => branchProtectionPolicy([rule], { kind: 'user', id: 'u1', access: 'write', teamIds: [] }) },
    })
    expect((await attempt(source, ['push', `forge::${forge.url}`, 'main'])).code).toBe(0)
    const before = (await git(source, ['rev-parse', 'main'])).trim()
    await git(source, ['reset', '-q', '--hard', 'HEAD~1'])
    await largeHistory(source, 4, 60_000, 3)
    await git(source, ['branch', 'topic'])

    const result = await attempt(source, ['push', `forge::${forge.url}`, '+main', 'topic'])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/! \[remote rejected\] +main -> main \(protected branch: [^)]*force/)
    expect(result.stderr).toContain('[new branch]')
    const refs = (await readRefs(forge.storage, repo))?.state.refs ?? {}
    expect(refs['refs/heads/main']).toBe(before)
    expect(refs['refs/heads/topic']).toBe((await git(source, ['rev-parse', 'topic'])).trim())

    const atomic = await attempt(source, ['push', '--atomic', `forge::${forge.url}`, '+main', 'topic:refs/heads/other'])
    expect(atomic.code).not.toBe(0)
    expect((await readRefs(forge.storage, repo))?.state.refs['refs/heads/other']).toBeUndefined()
  })

  it('rejects pushes whose LFS pointers have no uploaded object', async () => {
    const source = await newRepo()
    const oid = 'a'.repeat(64)
    writeFile(source, 'model.bin', `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 1234\n`)
    await commit(source, 'pointer')
    const forge = await startForge({ maxPushBytes: LIMIT })
    const result = await attempt(source, ['push', `forge::${forge.url}`, 'main'])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain(`missing LFS object ${oid}`)
  })

  it('points git-lfs of a named forge remote at the forge and pushes LFS objects before the pack', async () => {
    const source = await newRepo()
    await git(source, ['lfs', 'install', '--local'])
    await git(source, ['lfs', 'track', '*.bin'])
    writeFile(source, 'model.bin', randomBytes(50_000, 7))
    await commit(source, 'model')
    const forge = await startForge({ maxPushBytes: LIMIT })
    await git(source, ['remote', 'add', 'origin', `forge::${forge.url}`])
    const pushed = await attempt(source, ['push', 'origin', 'main'])
    expect(pushed.code).toBe(0)
    expect((await git(source, ['config', 'remote.origin.lfsurl'])).trim()).toBe(`${forge.url}/info/lfs`)
    const oid = (await git(source, ['lfs', 'ls-files', '--long'])).split(' ')[0] as string
    expect(await forge.storage.head(`repos/${repo.owner}/${repo.name}/lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`)).not.toBeNull()

    const clone = tempDir('git-forge-clone-')
    expect((await attempt(clone, ['clone', '-q', `forge::${forge.url}`, 'work'], { GIT_CONFIG_COUNT: '5', GIT_CONFIG_KEY_1: 'filter.lfs.process', GIT_CONFIG_VALUE_1: 'git-lfs filter-process', GIT_CONFIG_KEY_2: 'filter.lfs.required', GIT_CONFIG_VALUE_2: 'true', GIT_CONFIG_KEY_3: 'filter.lfs.smudge', GIT_CONFIG_VALUE_3: 'git-lfs smudge -- %f', GIT_CONFIG_KEY_4: 'filter.lfs.clean', GIT_CONFIG_VALUE_4: 'git-lfs clean -- %f' })).code).toBe(0)
    expect(readFileSync(join(clone, 'work', 'model.bin'))).toEqual(readFileSync(join(source, 'model.bin')))
  })

  it('deletes refs and falls back to receive-pack on servers without the upload API', async () => {
    const source = await newRepo()
    await largeHistory(source, 2, 1000)
    await git(source, ['branch', 'old'])
    const forge = await startForge({ maxPushBytes: LIMIT })
    expect((await attempt(source, ['push', `forge::${forge.url}`, 'main', 'old'])).code).toBe(0)
    expect((await attempt(source, ['push', `forge::${forge.url}`, ':old'])).code).toBe(0)
    expect((await readRefs(forge.storage, repo))?.state.refs['refs/heads/old']).toBeUndefined()

    const legacy = await startForge({ options: { uploads: false } })
    expect((await attempt(source, ['push', `forge::${legacy.url}`, 'main'])).code).toBe(0)
    expect(legacy.receivePacks).toBe(1)
    expect((await readRefs(legacy.storage, repo))?.state.refs['refs/heads/main']).toBe((await git(source, ['rev-parse', 'main'])).trim())
  })
})
