import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { type AccountsStore, applyMigrations, authenticateRequest, createAccountsStore, type Database, MIGRATIONS, type UserPrincipal } from '@git-forge/accounts'
import { openSqliteDatabase } from '@git-forge/accounts-node'
import { lfsObjectKey, MemoryStorage, type PushOutcome, type RepositoryName, storeLfsObject, streamOf, ZERO_ID } from '@git-forge/core'
import { commitAll, git, initRepo, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { loadRepository } from '@git-forge/core/test/repo-helpers.ts'
import { beforeEach, describe, expect, it } from 'vitest'
import { type ArtifactSource, createPages, manifestKey, type Pages, type PagesJob, parsePagesHosts } from '../src/index.ts'

const FORGE = 'https://forge.test'
const hosts = parsePagesHosts('http://{owner}.pages.test', '{"docs.acme.test": "alice/blog"}')!

const photo = new Uint8Array(Array.from({ length: 3000 }, (_, i) => (i * 7) % 256))
const photoOid = createHash('sha256').update(photo).digest('hex')
const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${photoOid}\nsize ${photo.length}\n`

type Fixture = {
  db: Database
  storage: MemoryStorage
  store: AccountsStore
  pages: Pages
  tokens: Record<'alice' | 'bob' | 'carol', string>
  users: Record<'alice' | 'bob' | 'carol', UserPrincipal>
  dir: string
  jobs: PagesJob[]
  sessionAs: { user: UserPrincipal | null }
  jobRepo: { repo: RepositoryName | null }
  api: (method: string, path: string, token: string | null, body?: unknown, headers?: Record<string, string>) => Promise<Response>
  page: (url: string, headers?: Record<string, string>, method?: string) => Promise<Response>
  push: (repo: RepositoryName) => Promise<string>
}

const tar = (files: Record<string, string>): Uint8Array => {
  const dir = initRepo()
  for (const [path, content] of Object.entries(files)) writeFile(dir, `out/${path}`, content)
  return new Uint8Array(execFileSync('tar', ['-czf', '-', '-C', `${dir}/out`, '.']))
}

const setup = async (options: { artifacts?: ArtifactSource; queue?: boolean } = {}): Promise<Fixture> => {
  const { db } = openSqliteDatabase()
  await applyMigrations(db, MIGRATIONS)
  const store = createAccountsStore(db)
  const storage = new MemoryStorage()
  const tokens = {} as Fixture['tokens']
  const users = {} as Fixture['users']
  for (const login of ['alice', 'bob', 'carol'] as const) {
    const user = await store.createUser({ login })
    users[login] = { kind: 'user', id: user.id, login, limits: null, tokenId: null }
    tokens[login] = (await store.createPersonalAccessToken(user.id, { name: 't', scopes: ['repo:admin'], expiresAt: null })).token
  }
  const blog = await store.createRepository({ ownerId: users.alice.id, name: 'blog', visibility: 'public' })
  const notes = await store.createRepository({ ownerId: users.alice.id, name: 'notes', visibility: 'private' })
  await store.createRepository({ ownerId: users.alice.id, name: 'alice.pages.test', visibility: 'public' })
  await store.setCollaborator(blog.id, users.bob.id, 'write')
  await store.setCollaborator(notes.id, users.bob.id, 'read')
  const dir = initRepo()
  writeFile(dir, 'index.html', '<h1>home</h1>')
  writeFile(dir, 'about.html', '<p>about</p>')
  writeFile(dir, 'docs/index.html', '<p>docs</p>')
  writeFile(dir, 'assets/style.css', 'body{}')
  writeFile(dir, '404.html', '<p>gone</p>')
  writeFile(dir, 'photo.jpg', pointer)
  commitAll(dir, 'site')
  const jobs: PagesJob[] = []
  const sessionAs: Fixture['sessionAs'] = { user: null }
  const jobRepo: Fixture['jobRepo'] = { repo: null }
  const authenticateToken = (request: Request) => authenticateRequest(request, { directory: store })
  const pages = createPages({
    db,
    storage,
    directory: store,
    hosts,
    forgeUrl: FORGE,
    baseUrl: () => FORGE,
    authenticate: authenticateToken,
    authenticateToken,
    sessionUser: async () => sessionAs.user,
    isInstanceAdmin: store.isInstanceAdmin,
    jobTokenRepository: async () => jobRepo.repo,
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
    ...(options.queue ? { schedule: async (job: PagesJob) => void jobs.push(job) } : {}),
  })
  const push = async (repo: RepositoryName): Promise<string> => {
    await loadRepository(dir, repo, storage).catch(async () => {
      const { ObjectDatabase, updateRefs, readRefs } = await import('@git-forge/core')
      const { gitBytes } = await import('@git-forge/core/test/git-helpers.ts')
      const odb = new ObjectDatabase(storage, repo)
      await odb.ingest(streamOf(gitBytes(dir, ['pack-objects', '--stdout', '--all'], '')))
      const current = (await readRefs(storage, repo))!.state.refs['refs/heads/main'] ?? ZERO_ID
      await updateRefs(storage, repo, [{ name: 'refs/heads/main', oldId: current, newId: git(dir, ['rev-parse', 'HEAD']).trim() }], odb)
    })
    return git(dir, ['rev-parse', 'HEAD']).trim()
  }
  for (const name of ['blog', 'notes', 'alice.pages.test']) {
    await push({ owner: 'alice', name })
    await storeLfsObject(storage, { owner: 'alice', name }, { oid: photoOid, size: photo.length }, streamOf(photo))
  }
  const api = async (method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) => {
    const init: RequestInit & { duplex?: string } = { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } }
    if (body instanceof Uint8Array) {
      init.body = streamOf(body) as ReadableStream<Uint8Array<ArrayBuffer>>
      init.duplex = 'half'
    } else if (body !== undefined) {
      init.body = JSON.stringify(body)
      ;(init.headers as Record<string, string>)['Content-Type'] = 'application/json'
    }
    const response = await pages.api(new Request(`${FORGE}${path}`, init))
    if (!response) throw new Error(`no route for ${method} ${path}`)
    return response
  }
  const page = async (url: string, headers: Record<string, string> = {}, method = 'GET') => {
    const response = await pages.serve(new Request(url, { method, headers }))
    if (!response) throw new Error(`not a pages request: ${url}`)
    return response
  }
  return { db, storage, store, pages, tokens, users, dir, jobs, sessionAs, jobRepo, api, page, push }
}

let f: Fixture

describe('branch deployments', () => {
  beforeEach(async () => {
    f = await setup()
  })

  it('enables Pages from a branch and serves the site with correct types, redirects and 404 page', async () => {
    const created = await f.api('POST', '/api/v3/repos/alice/blog/pages', f.tokens.alice, { source: { branch: 'main', path: '/' } })
    expect(created.status).toBe(201)
    const site = (await created.json()) as Record<string, unknown>
    expect(site).toMatchObject({ build_type: 'legacy', source: { branch: 'main', path: '/' }, html_url: 'http://docs.acme.test/', status: 'built', custom_404: true, cname: 'docs.acme.test', public: true })
    expect(f.pages.isPagesRequest(new Request('http://alice.pages.test/blog/'))).toBe(true)
    expect(f.pages.isPagesRequest(new Request('https://forge.test/blog/'))).toBe(false)

    const slashless = await f.page('http://alice.pages.test/blog?x=1')
    expect(slashless.status).toBe(301)
    expect(slashless.headers.get('Location')).toBe('/blog/?x=1')
    const home = await f.page('http://alice.pages.test/blog/')
    expect(home.status).toBe(200)
    expect(home.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(home.headers.get('Cache-Control')).toBe('public, max-age=60')
    expect(await home.text()).toBe('<h1>home</h1>')
    expect((await f.page('http://alice.pages.test/blog/assets/style.css')).headers.get('Content-Type')).toBe('text/css; charset=utf-8')
    expect(await (await f.page('http://alice.pages.test/blog/about')).text()).toBe('<p>about</p>')
    const docs = await f.page('http://alice.pages.test/blog/docs')
    expect(docs.status).toBe(301)
    expect(docs.headers.get('Location')).toBe('docs/')
    const missing = await f.page('http://alice.pages.test/blog/nope')
    expect(missing.status).toBe(404)
    expect(await missing.text()).toBe('<p>gone</p>')
    expect(await (await f.page('http://docs.acme.test/about.html')).text()).toBe('<p>about</p>')
    expect((await f.page('http://alice.pages.test/blog/', {}, 'POST')).status).toBe(405)
  })

  it('answers conditional, range and HEAD requests and redirects public LFS files to the media URL', async () => {
    await f.api('POST', '/api/v3/repos/alice/blog/pages', f.tokens.alice, { source: 'main' })
    const home = await f.page('http://alice.pages.test/blog/index.html')
    const etag = home.headers.get('ETag')!
    expect((await f.page('http://alice.pages.test/blog/index.html', { 'If-None-Match': etag })).status).toBe(304)
    const partial = await f.page('http://alice.pages.test/blog/index.html', { Range: 'bytes=1-2' })
    expect(partial.status).toBe(206)
    expect(await partial.text()).toBe('h1')
    const head = await f.page('http://alice.pages.test/blog/index.html', {}, 'HEAD')
    expect(head.headers.get('Content-Length')).toBe('13')
    const lfs = await f.page('http://alice.pages.test/blog/photo.jpg')
    expect(lfs.status).toBe(302)
    expect(lfs.headers.get('Location')).toBe(`${FORGE}/alice/blog/media/${photoOid}/photo.jpg`)
  })

  it('deploys again on push to the source branch and switches atomically to the newest deployment', async () => {
    await f.api('POST', '/api/v3/repos/alice/blog/pages', f.tokens.alice, { source: { branch: 'main' } })
    writeFile(f.dir, 'index.html', '<h1>v2</h1>')
    commitAll(f.dir, 'v2')
    const head = await f.push({ owner: 'alice', name: 'blog' })
    const outcome: PushOutcome = { unpack: 'ok', results: [{ name: 'refs/heads/main', oldId: ZERO_ID, newId: head, ok: true }], pack: null, objectCount: 0, archived: [] }
    await f.pages.onPush({ owner: 'alice', name: 'blog' }, outcome, f.users.alice)
    expect(await (await f.page('http://alice.pages.test/blog/')).text()).toBe('<h1>v2</h1>')
    const builds = (await (await f.api('GET', '/api/v3/repos/alice/blog/pages/builds', f.tokens.bob)).json()) as { status: string; commit: string }[]
    expect(builds.map((build) => build.status)).toEqual(['built', 'built'])
    expect(builds[0]!.commit).toBe(head)
    const repository = (await f.store.findRepository('alice', 'blog'))!
    const stale = await f.pages.store.createDeployment(repository.id, { source: 'branch', commitSha: head }, { kind: 'system', id: null, login: null })
    const newest = await f.pages.store.createDeployment(repository.id, { source: 'branch', commitSha: head }, { kind: 'system', id: null, login: null })
    await f.pages.store.start(newest.id)
    await f.pages.store.start(stale.id)
    const active = (await f.pages.store.activeDeployment(repository.id))!
    expect(await f.pages.store.complete(newest, { manifest: active.manifest!, fileCount: 1, totalBytes: 1 })).toBe(true)
    expect(await f.pages.store.complete(stale, { manifest: active.manifest!, fileCount: 1, totalBytes: 1 })).toBe(true)
    expect((await f.pages.store.activeDeployment(repository.id))!.id).toBe(newest.id)
    expect(await f.storage.head(manifestKey({ owner: 'alice', name: 'blog' }, active.manifest!))).not.toBeNull()
  })

  it('serves the user site at the root from /docs or / and validates updates', async () => {
    const created = await f.api('POST', '/api/v3/repos/alice/alice.pages.test/pages', f.tokens.alice, { source: { branch: 'main', path: '/docs' } })
    expect(created.status).toBe(201)
    expect(await (await f.page('http://alice.pages.test/')).text()).toBe('<p>docs</p>')
    await f.api('PUT', '/api/v3/repos/alice/alice.pages.test/pages', f.tokens.alice, { source: { branch: 'main', path: '/' } })
    expect(await (await f.page('http://alice.pages.test/about')).text()).toBe('<p>about</p>')
    expect((await f.api('PUT', '/api/v3/repos/alice/alice.pages.test/pages', f.tokens.alice, { cname: 'www.example.com' })).status).toBe(422)
    expect((await f.api('PUT', '/api/v3/repos/alice/alice.pages.test/pages', f.tokens.bob, { source: 'main' })).status).toBe(403)
    expect((await f.api('POST', '/api/v3/repos/alice/alice.pages.test/pages', f.tokens.alice, { source: 'main' })).status).toBe(409)
    expect((await f.api('POST', '/api/v3/repos/alice/notes/pages', f.tokens.alice, { source: 'gh-pages' })).status).toBe(201)
    expect(await (await f.api('GET', '/api/v3/repos/alice/notes/pages', f.tokens.alice)).json()).toMatchObject({ status: null })
    expect((await f.api('POST', '/api/v3/repos/alice/notes/pages/builds', f.tokens.alice)).status).toBe(422)
  })

  it('queues deployments as jobs when a scheduler is configured', async () => {
    f = await setup({ queue: true })
    await f.api('POST', '/api/v3/repos/alice/blog/pages', f.tokens.alice, { source: 'main' })
    expect(f.jobs).toHaveLength(1)
    expect((await f.page('http://alice.pages.test/blog/')).status).toBe(404)
    expect((await (await f.api('GET', '/api/v3/repos/alice/blog/pages/builds/latest', f.tokens.alice)).json()) as { status: string }).toMatchObject({ status: 'queued' })
    await f.pages.runJob(f.jobs[0]!)
    expect(await (await f.page('http://alice.pages.test/blog/')).text()).toBe('<h1>home</h1>')
  })

  it('deletes the site configuration', async () => {
    await f.api('POST', '/api/v3/repos/alice/blog/pages', f.tokens.alice, { source: 'main' })
    expect((await f.api('DELETE', '/api/v3/repos/alice/blog/pages', f.tokens.alice)).status).toBe(204)
    expect((await f.page('http://alice.pages.test/blog/')).status).toBe(404)
    expect((await f.api('GET', '/api/v3/repos/alice/blog/pages', f.tokens.alice)).status).toBe(404)
  })
})

describe('artifact and upload deployments', () => {
  it('deploys a tar body, resolving LFS pointers and keeping the last good deployment on failure', async () => {
    f = await setup()
    await f.api('POST', '/api/v3/repos/alice/blog/pages', f.tokens.alice, { build_type: 'workflow' })
    const deployed = await f.api('POST', '/api/v3/repos/alice/blog/pages/deployments?pages_build_version=abc', f.tokens.bob, tar({ 'index.html': 'built', 'nested/page.html': 'nested', 'big.jpg': pointer }), {
      'Content-Type': 'application/x-tar',
    })
    expect(deployed.status).toBe(200)
    const body = (await deployed.json()) as { id: number; status: string; status_url: string }
    expect(body).toMatchObject({ status: 'succeed', status_url: `${FORGE}/api/v3/repos/alice/blog/pages/deployments/${body.id}` })
    expect(await (await f.page('http://alice.pages.test/blog/')).text()).toBe('built')
    expect(await (await f.page('http://alice.pages.test/blog/nested/page')).text()).toBe('nested')
    expect((await f.page('http://alice.pages.test/blog/big.jpg')).headers.get('Location')).toBe(`${FORGE}/alice/blog/media/${photoOid}/big.jpg`)
    expect(await (await f.api('GET', `/api/v3/repos/alice/blog/pages/deployments/${body.id}`, f.tokens.alice)).json()).toMatchObject({ status: 'succeed', commit: 'abc' })
    const broken = await f.api('POST', '/api/v3/repos/alice/blog/pages/deployments', f.tokens.alice, new Uint8Array(1024).fill(7), { 'Content-Type': 'application/x-tar' })
    expect(broken.status).toBe(422)
    expect(await broken.json()).toMatchObject({ status: 'deployment_failed' })
    expect(await (await f.page('http://alice.pages.test/blog/')).text()).toBe('built')
    expect((await f.api('POST', '/api/v3/repos/alice/blog/pages/deployments', f.tokens.carol, tar({ 'index.html': 'x' }), { 'Content-Type': 'application/x-tar' })).status).toBe(403)
  })

  it('deploys a workflow artifact through the artifact source, authorized by a job token', async () => {
    const seen: string[] = []
    f = await setup({
      artifacts: async (repository, artifact) => {
        seen.push(`${repository.owner}/${repository.name}#${artifact.id}`)
        return artifact.id === '42' ? streamOf(tar({ 'index.html': 'from ci' })) : null
      },
    })
    await f.api('POST', '/api/v3/repos/alice/blog/pages', f.tokens.alice, { build_type: 'workflow' })
    expect((await f.api('POST', '/api/v3/repos/alice/blog/pages/deployments', null, { artifact_id: 42 })).status).toBe(401)
    f.jobRepo.repo = { owner: 'alice', name: 'blog' }
    const response = await f.api('POST', '/api/v3/repos/alice/blog/pages/deployments', null, { artifact_id: 42, pages_build_version: 'deadbeef', oidc_token: 'x' })
    expect(response.status).toBe(200)
    const created = (await response.json()) as { id: number; status: string; page_url: string }
    expect(created).toMatchObject({ status: 'succeed', page_url: 'http://docs.acme.test/' })
    expect(seen).toEqual(['alice/blog#42'])
    expect(await (await f.page('http://alice.pages.test/blog/')).text()).toBe('from ci')
    const missing = (await (await f.api('POST', '/api/v3/repos/alice/blog/pages/deployments', null, { artifact_id: 7 })).json()) as { status: string; error: string }
    expect(missing).toMatchObject({ status: 'deployment_failed', error: 'artifact not found' })
    f.jobRepo.repo = { owner: 'alice', name: 'notes' }
    expect((await f.api('POST', '/api/v3/repos/alice/blog/pages/deployments', null, { artifact_id: 42 })).status).toBe(401)
  })

  it('refuses artifact deployments when the instance cannot read artifacts', async () => {
    f = await setup()
    await f.api('POST', '/api/v3/repos/alice/blog/pages', f.tokens.alice, { build_type: 'workflow' })
    expect((await f.api('POST', '/api/v3/repos/alice/blog/pages/deployments', f.tokens.alice, { artifact_id: 1 })).status).toBe(422)
  })
})

describe('private pages', () => {
  beforeEach(async () => {
    f = await setup()
    await f.api('POST', '/api/v3/repos/alice/notes/pages', f.tokens.alice, { source: 'main' })
  })

  it('sends anonymous visitors through the forge sign-in and sets a host cookie', async () => {
    const anonymous = await f.page('http://alice.pages.test/notes/about?q=1')
    expect(anonymous.status).toBe(302)
    const authorizeUrl = new URL(anonymous.headers.get('Location')!)
    expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(`${FORGE}/_pages/authorize`)
    expect(authorizeUrl.searchParams.get('redirect')).toBe('http://alice.pages.test/notes/about?q=1')

    const login = await f.api('GET', `${authorizeUrl.pathname}${authorizeUrl.search}`, null)
    expect(login.status).toBe(302)
    expect(login.headers.get('Location')).toBe(`/login?return_to=${encodeURIComponent(`${authorizeUrl.pathname}${authorizeUrl.search}`)}`)

    f.sessionAs.user = f.users.bob
    const granted = await f.api('GET', `${authorizeUrl.pathname}${authorizeUrl.search}`, null)
    const callback = new URL(granted.headers.get('Location')!)
    expect(callback.origin).toBe('http://alice.pages.test')
    expect(callback.searchParams.get('path')).toBe('/notes/about?q=1')
    const signedIn = await f.page(callback.toString())
    expect(signedIn.status).toBe(302)
    expect(signedIn.headers.get('Location')).toBe('/notes/about?q=1')
    const setCookie = signedIn.headers.get('Set-Cookie')!
    expect(setCookie).toMatch(/^forge_pages=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200$/)
    const cookie = setCookie.split(';')[0]!
    expect((await f.page(callback.toString())).status).toBe(400)

    const page = await f.page('http://alice.pages.test/notes/about', { Cookie: cookie })
    expect(page.status).toBe(200)
    expect(page.headers.get('Cache-Control')).toBe('private, no-cache')
    expect(page.headers.get('Vary')).toBe('Cookie, Authorization')
    expect(await page.text()).toBe('<p>about</p>')
    const lfs = await f.page('http://alice.pages.test/notes/photo.jpg', { Cookie: cookie })
    expect(lfs.status).toBe(200)
    expect(new Uint8Array(await lfs.arrayBuffer())).toEqual(photo)
    expect((await f.page('http://bob.pages.test/notes/about', { Cookie: cookie })).status).toBe(404)
  })

  it('denies users without read access and accepts tokens', async () => {
    f.sessionAs.user = f.users.carol
    const granted = await f.api('GET', `/_pages/authorize?redirect=${encodeURIComponent('http://alice.pages.test/notes/')}`, null)
    const signedIn = await f.page(granted.headers.get('Location')!)
    const cookie = signedIn.headers.get('Set-Cookie')!.split(';')[0]!
    expect((await f.page('http://alice.pages.test/notes/', { Cookie: cookie })).status).toBe(404)
    expect((await f.page('http://alice.pages.test/notes/', { Authorization: `Bearer ${f.tokens.bob}` })).status).toBe(200)
    expect((await f.page('http://alice.pages.test/notes/', { Authorization: `Bearer ${f.tokens.carol}` })).status).toBe(404)
  })

  it('refuses redirects outside the pages hosts', async () => {
    f.sessionAs.user = f.users.bob
    for (const target of ['https://evil.example/', 'https://alice.pages.test/', 'javascript:alert(1)', 'http://user:pw@alice.pages.test/']) {
      expect((await f.api('GET', `/_pages/authorize?redirect=${encodeURIComponent(target)}`, null)).status).toBe(400)
    }
  })
})

describe('storage layout', () => {
  it('stores site files content-addressed next to LFS objects', async () => {
    f = await setup()
    await f.api('POST', '/api/v3/repos/alice/blog/pages', f.tokens.alice, { source: 'main' })
    const oid = createHash('sha256').update('<h1>home</h1>').digest('hex')
    expect(await f.storage.head(lfsObjectKey({ owner: 'alice', name: 'blog' }, oid))).not.toBeNull()
  })
})
