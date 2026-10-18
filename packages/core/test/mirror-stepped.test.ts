import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { concat, readAll, utf8 } from '../src/bytes.ts'
import { githubRepositoryOf, githubSignature, listGitHubRepositories, registerGitHubWebhook, verifyGitHubSignature } from '../src/github.ts'
import { lfsObjectKey } from '../src/lfs.ts'
import { MemoryStorage } from '../src/memory-storage.ts'
import { configureMirror, type MirrorFetchState, mirrorFetchKey, mirrorPendingLfsObject, readMirrorStatus, syncMirror, type SyncResult } from '../src/mirror.ts'
import { readRefs, type RepositoryName } from '../src/repository.ts'
import { commitAll, git, gitEnv, initRepo, sampleHistory, tempDir, writeFile } from './git-helpers.ts'
import { type RunningServer, startServer } from './http-server.ts'
import { basicAuth, chain, FaultyStorage, fakeLfs, httpBackendHandler, lfsPointer, randomBytes, requireAuthorization, startForge } from './mirror-helpers.ts'

const run = promisify(execFile)

const gitAsync = async (cwd: string, args: readonly string[]): Promise<string> =>
  (await run('git', args, { cwd, env: { ...process.env, ...gitEnv }, maxBuffer: 256 * 1024 * 1024 })).stdout

const servers: RunningServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const serve = async (...handlers: Parameters<typeof chain>): Promise<RunningServer> => {
  const running = await startServer(chain(...handlers))
  servers.push(running)
  return running
}

const backup: RepositoryName = { owner: 'backup', name: 'project' }

const bareSource = (work: string): string => {
  const root = tempDir('git-forge-mirror-root-')
  git(root, ['clone', '-q', '--bare', work, 'source.git'])
  git(`${root}/source.git`, ['config', 'uploadpack.allowFilter', 'true'])
  git(`${root}/source.git`, ['repack', '-q', '-a', '-d', '-f'])
  return root
}

const largeWork = (): string => {
  const work = initRepo()
  sampleHistory(work, 6)
  for (let i = 0; i < 24; i++) writeFile(work, `bulk/${i}.bin`, randomBytes(70_000, 100 + i))
  commitAll(work, 'bulk')
  writeFile(work, 'media/big.bin', randomBytes(600_000, 7))
  commitAll(work, 'big')
  for (let i = 0; i < 4; i++) {
    writeFile(work, `after/${i}.txt`, `after ${i}\n`)
    commitAll(work, `after ${i}`)
  }
  git(work, ['tag', '-a', 'v1', '-m', 'release 1'])
  return work
}

const upstreamRefs = async (storage: MemoryStorage | FaultyStorage) =>
  Object.fromEntries(Object.entries((await readRefs(storage, backup))?.state.refs ?? {}).filter(([name]) => name.startsWith('refs/upstream/')))

const sourceRefs = (bare: string) =>
  Object.fromEntries(
    git(bare, ['for-each-ref', '--format=%(objectname) %(refname)'])
      .toString()
      .trim()
      .split('\n')
      .map((line) => line.split(' ') as [string, string])
      .map(([id, name]) => [`refs/upstream/origin/${name.slice('refs/'.length)}`, id]),
  )

describe('stepped mirror sync from a non-forge server', () => {
  it('fetches a large first sync in steps across invocations, splits a big commit and moves refs only when complete', async () => {
    const root = bareSource(largeWork())
    const remote = await serve(httpBackendHandler(root))
    const inner = new MemoryStorage()
    let packWrites = 0
    const storage = new FaultyStorage(inner, (key) => key.endsWith('.pack') && ++packWrites === 3)
    const forge = await startForge(inner)
    servers.push(forge.server)
    await forge.createRepo(backup)
    await configureMirror(inner, backup, { url: `${remote.url}/source.git` })
    const results: SyncResult[] = []
    const splits: boolean[] = []
    for (let i = 0; i < 200; i++) {
      const result = await syncMirror({ storage, repo: backup, maxSteps: 1, commitsPerStep: 4, stepLimits: { maxStepBytes: 400_000, maxObjectBytes: 200_000 } })
      results.push(result)
      const stored = await inner.get(mirrorFetchKey(backup, 'origin'))
      splits.push(stored ? Boolean((JSON.parse(new TextDecoder().decode(await readAll(stored.body))) as MirrorFetchState).split) : false)
      if (result.status === 'ok') break
      if (result.status === 'pending') expect(await upstreamRefs(inner)).toEqual({})
    }
    expect(results.at(-1)?.status).toBe('ok')
    expect(results.filter((result) => result.status === 'pending').length).toBeGreaterThan(4)
    expect(results.some((result) => result.status === 'failed' && result.error?.includes('simulated crash'))).toBe(true)
    expect(splits.some(Boolean)).toBe(true)
    expect(await upstreamRefs(inner)).toEqual(sourceRefs(`${root}/source.git`))
    const clone = tempDir('git-forge-mirror-clone-')
    await gitAsync(clone, ['clone', '-q', '--mirror', forge.url(backup), 'clone.git'])
    expect(await gitAsync(`${clone}/clone.git`, ['fsck', '--full', '--strict', '--no-dangling'])).toBe('')
    const again = await syncMirror({ storage: inner, repo: backup, maxSteps: 1 })
    expect(again).toMatchObject({ status: 'ok', updates: [] })
  }, 120_000)

  it('continues incremental syncs with the stepped fetch', async () => {
    const work = initRepo()
    sampleHistory(work, 3)
    const root = bareSource(work)
    const remote = await serve(httpBackendHandler(root))
    const storage = new MemoryStorage()
    const forge = await startForge(storage)
    servers.push(forge.server)
    await forge.createRepo(backup)
    await configureMirror(storage, backup, { url: `${remote.url}/source.git` })
    expect((await syncMirror({ storage, repo: backup })).status).toBe('ok')
    writeFile(work, 'later.bin', concat([randomBytes(50_000, 3), utf8('x')]))
    commitAll(work, 'later')
    git(work, ['push', '-q', `${root}/source.git`, 'main'])
    const result = await syncMirror({ storage, repo: backup })
    expect(result.status).toBe('ok')
    expect(result.updates.map((update) => update.kind)).toEqual(['fast-forward'])
    expect(await upstreamRefs(storage)).toEqual(sourceRefs(`${root}/source.git`))
  })
})

describe('mirror LFS endpoint', () => {
  it('takes the endpoint from .lfsconfig and sends the token only to the upstream origin', async () => {
    const assets = [randomBytes(30_000, 41), randomBytes(20_000, 42)]
    const pointers = assets.map((asset) => lfsPointer(asset))
    const lfs = fakeLfs({ read: async (oid) => assets[pointers.findIndex((pointer) => pointer.oid === oid)] ?? null })
    const lfsServer = await serve(lfs.handler)
    const work = initRepo()
    sampleHistory(work, 2)
    pointers.forEach((pointer, i) => writeFile(work, `media/${i}.bin`, pointer.text))
    writeFile(work, '.lfsconfig', `[lfs]\n\turl = ${lfsServer.url}/store/info/lfs\n`)
    commitAll(work, 'media')
    const root = bareSource(work)
    const token = basicAuth('x-access-token', 'github-token')
    const remote = await serve(requireAuthorization(token), httpBackendHandler(root))
    const storage = new MemoryStorage()
    const forge = await startForge(storage)
    servers.push(forge.server)
    await forge.createRepo(backup)
    await configureMirror(storage, backup, { url: `${remote.url}/source.git` })
    const result = await syncMirror({ storage, repo: backup, getAuthorization: async () => token, deferLfs: true })
    expect(result.status).toBe('ok')
    const status = await readMirrorStatus(storage, backup)
    expect(status?.lfsEndpoint).toEqual({ url: `${lfsServer.url}/store/info/lfs`, source: 'lfsconfig', ref: 'refs/heads/main' })
    expect(status?.lfsPending.map((pending) => pending.oid).sort()).toEqual(pointers.map((pointer) => pointer.oid).sort())
    for (const pointer of pointers) {
      const unit = await mirrorPendingLfsObject({ storage, repo: backup, getAuthorization: async () => token }, pointer)
      expect(unit.missing).toEqual([])
    }
    expect(lfs.batches.length).toBe(2)
    expect(lfs.batches.every((batch) => batch.authorization === null)).toBe(true)
    const stored = await storage.get(lfsObjectKey(backup, pointers[0]!.oid))
    expect(stored && (await readAll(stored.body))).toEqual(assets[0])
    expect((await readMirrorStatus(storage, backup))?.lfsPending).toEqual([])
  })
})

describe('GitHub helpers', () => {
  it('verifies X-Hub-Signature-256 like GitHub', async () => {
    const secret = "It's a Secret to Everybody"
    const body = utf8('Hello, World!')
    const signature = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17'
    expect(await githubSignature(secret, body)).toBe(signature)
    expect(await verifyGitHubSignature(secret, body, signature)).toBe(true)
    expect(await verifyGitHubSignature(secret, body, signature.toUpperCase().replace('SHA256', 'sha256'))).toBe(true)
    expect(await verifyGitHubSignature(secret, utf8('Hello, World?'), signature)).toBe(false)
    expect(await verifyGitHubSignature('other', body, signature)).toBe(false)
    expect(await verifyGitHubSignature(secret, body, null)).toBe(false)
    expect(await verifyGitHubSignature(secret, body, 'sha1=abc')).toBe(false)
    expect(await verifyGitHubSignature('', body, signature)).toBe(false)
  })

  it('recognizes github.com repository URLs', () => {
    expect(githubRepositoryOf('https://github.com/levino/git-forge.git')).toBe('levino/git-forge')
    expect(githubRepositoryOf('https://github.com/levino/git-forge')).toBe('levino/git-forge')
    expect(githubRepositoryOf('https://forge.example.org/levino/git-forge.git')).toBeNull()
  })

  const fakeGitHub = (pages: number) => {
    const seen: { method: string; path: string; authorization: string | null; body: unknown }[] = []
    const repo = (i: number, extra: Record<string, unknown> = {}) => ({
      name: `repo-${i}`,
      full_name: `levino/repo-${i}`,
      clone_url: `https://github.com/levino/repo-${i}.git`,
      private: i % 2 === 0,
      fork: false,
      archived: false,
      default_branch: 'main',
      owner: { login: 'levino' },
      ...extra,
    })
    const hooks: { id: number; config: { url: string } }[] = [{ id: 7, config: { url: 'https://other.example/hook' } }]
    const fetch = async (request: Request): Promise<Response> => {
      const url = new URL(request.url)
      seen.push({ method: request.method, path: `${url.pathname}${url.search}`, authorization: request.headers.get('Authorization'), body: request.body ? await request.json() : null })
      const json = (value: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', ...headers } })
      if (url.pathname === '/user') return json({ login: 'Levino' })
      if (url.pathname === '/users/acme') return json({ type: 'Organization' })
      if (url.pathname === '/user/repos' || url.pathname === '/orgs/acme/repos') {
        const page = Number(url.searchParams.get('page') ?? '1')
        const items = page === 1 ? [repo(1), repo(2, { fork: true }), repo(3, { archived: true }), repo(9, { owner: { login: 'someone' } })] : [repo(page * 10)]
        const link = page < pages ? { Link: `<${url.origin}${url.pathname}?page=${page + 1}>; rel="next"` } : {}
        return json(items, link)
      }
      if (url.pathname === '/repos/levino/repo-1/hooks' && request.method === 'GET') return json(hooks)
      if (url.pathname === '/repos/levino/repo-1/hooks' && request.method === 'POST') return json({ id: 8, config: {} }, {})
      if (url.pathname === '/repos/levino/repo-1/hooks/8' && request.method === 'PATCH') return json({ id: 8 })
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
    }
    return { fetch, seen, hooks }
  }

  it('lists the repositories of the authenticated user over all pages with filters', async () => {
    const github = fakeGitHub(3)
    const all = await listGitHubRepositories({ account: 'levino', token: 'tok', fetch: github.fetch })
    expect(all.map((repo) => repo.name)).toEqual(['repo-1', 'repo-3', 'repo-20', 'repo-30'])
    expect(all[2]).toMatchObject({ fullName: 'levino/repo-20', private: true, cloneUrl: 'https://github.com/levino/repo-20.git' })
    expect(github.seen.every((request) => request.authorization === 'Bearer tok')).toBe(true)
    expect(github.seen[1]?.path).toBe('/user/repos?affiliation=owner&per_page=100')
    const filtered = await listGitHubRepositories({ account: 'levino', token: 'tok', fetch: github.fetch, forks: true, archived: false, maxPages: 1 })
    expect(filtered.map((repo) => repo.name)).toEqual(['repo-1', 'repo-2'])
  })

  it('lists organization repositories and reports API errors without credentials', async () => {
    const github = fakeGitHub(1)
    const org = await listGitHubRepositories({ account: 'acme', fetch: github.fetch })
    expect(github.seen.map((request) => request.path)).toEqual(['/users/acme', '/orgs/acme/repos?type=all&per_page=100'])
    expect(org).toHaveLength(0)
    await expect(listGitHubRepositories({ account: 'nobody', token: 'secret-token', fetch: github.fetch })).rejects.toThrow(/HTTP 404: Not Found/)
    await expect(listGitHubRepositories({ account: 'nobody', token: 'secret-token', fetch: github.fetch })).rejects.not.toThrow(/secret-token/)
  })

  it('registers a push webhook once and updates it on the next call', async () => {
    const github = fakeGitHub(1)
    const created = await registerGitHubWebhook({ repository: 'levino/repo-1', url: 'https://forge.example/hook', secret: 's3cret', token: 'admin', fetch: github.fetch })
    expect(created).toEqual({ id: 8, created: true })
    expect(github.seen.at(-1)).toMatchObject({
      method: 'POST',
      body: { name: 'web', active: true, events: ['push'], config: { url: 'https://forge.example/hook', content_type: 'json', secret: 's3cret' } },
    })
    github.hooks.push({ id: 8, config: { url: 'https://forge.example/hook' } })
    expect(await registerGitHubWebhook({ repository: 'levino/repo-1', url: 'https://forge.example/hook', secret: 'new', token: 'admin', fetch: github.fetch })).toEqual({ id: 8, created: false })
    expect(github.seen.at(-1)).toMatchObject({ method: 'PATCH', body: { config: { secret: 'new' } } })
  })
})
