import { generateSigningKey, type SigningKey } from '@git-forge/accounts'
import { type ImportJob, readImportState, readRefs } from '@git-forge/core'
import { initRepo, sampleHistory } from '@git-forge/core/test/git-helpers.ts'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { basicAuthorization, secretMatches } from '../../src/app.ts'
import { git } from '../e2e/history.ts'
import { DEFAULT_COMPACT_MAX_BYTES, DEFAULT_MAX_LFS_OBJECT_BYTES, parseSettings } from '../../src/config.ts'
import { upstreamRepository } from '../../src/mirrors.ts'
import { bootstrap, BOOTSTRAP_TOKEN, call, type NodeForge, nodeForge } from '../support/node-forge.ts'

const BASE = 'https://forge.example'

const basic = (password: string) => `Basic ${btoa(`git:${password}`)}`

const advertise = (forge: NodeForge, repo: string, service: string, authorization?: string) =>
  forge.fetch(
    new Request(`${BASE}/${repo}.git/info/refs?service=${service}`, {
      headers: { 'Git-Protocol': 'version=2', ...(authorization ? { Authorization: authorization } : {}) },
    }),
  )

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T

describe('settings', () => {
  it('parses vars with safe defaults', async () => {
    const settings = await parseSettings({ MAX_PUSH_BYTES: 'x', MIRROR_INTERVAL_MINUTES: '0', PUBLIC_URL: 'https://forge.example/' })
    expect(settings).toMatchObject({
      publicUrl: 'https://forge.example',
      instanceKey: undefined,
      bootstrapToken: undefined,
      maxPushBytes: undefined,
      packfileUriBase: undefined,
      compactMaxBytes: DEFAULT_COMPACT_MAX_BYTES,
      maxLfsObjectBytes: DEFAULT_MAX_LFS_OBJECT_BYTES,
      mirrorIntervalMinutes: 0,
      allowInsecureFederation: false,
    })
    expect(await parseSettings({ MAX_PUSH_BYTES: '1000', COMPACT_MAX_BYTES: '0', PACKFILE_URI_BASE: 'https://cdn.example' })).toMatchObject({
      maxPushBytes: 1000,
      compactMaxBytes: 0,
      packfileUriBase: 'https://cdn.example',
    })
    const { privateJwk, key } = await generateSigningKey()
    expect((await parseSettings({ INSTANCE_KEY: JSON.stringify(privateJwk) })).instanceKey?.kid).toBe(key.kid)
    await expect(parseSettings({ INSTANCE_KEY: 'nope' })).rejects.toThrow(/INSTANCE_KEY/)
  })

  it('compares secrets without accepting missing or different values', async () => {
    expect(await secretMatches('secret', 'secret')).toBe(true)
    expect(await secretMatches('secret', 'secreT')).toBe(false)
    expect(await secretMatches('', undefined)).toBe(false)
  })

  it('derives the upstream repository from a clone URL', () => {
    expect(upstreamRepository('https://a.example/acme/site.git')).toBe('acme/site')
    expect(upstreamRepository('https://a.example/acme/site')).toBe('acme/site')
    expect(upstreamRepository('https://a.example/acme')).toBeNull()
  })
})

describe('bootstrap and admin API', () => {
  it('bootstraps the first admin exactly once', async () => {
    expect((await call(await nodeForge({ bootstrapToken: undefined }), BASE, 'POST', '/api/bootstrap', 'x', { login: 'root' })).status).toBe(503)
    const forge = await nodeForge()
    expect((await call(forge, BASE, 'POST', '/api/bootstrap', 'wrong', { login: 'root' })).status).toBe(401)
    expect((await call(forge, BASE, 'POST', '/api/bootstrap', BOOTSTRAP_TOKEN, { login: 'bad login' })).status).toBe(400)
    const created = await call(forge, BASE, 'POST', '/api/bootstrap', BOOTSTRAP_TOKEN, { login: 'root' })
    expect(created.status).toBe(201)
    expect(await json(created)).toMatchObject({ login: 'root', token: expect.stringMatching(/^gfp_/) })
    expect((await call(forge, BASE, 'POST', '/api/bootstrap', BOOTSTRAP_TOKEN, { login: 'again' })).status).toBe(409)
    expect((await call(forge, BASE, 'GET', '/api/bootstrap')).status).toBe(405)
  })

  it('lets only instance admins create users and tokens', async () => {
    const forge = await nodeForge()
    const admin = await bootstrap(forge, BASE)
    expect((await call(forge, BASE, 'POST', '/api/admin/users', undefined, { login: 'alice' })).status).toBe(401)
    expect((await call(forge, BASE, 'POST', '/api/admin/users', admin, { login: 'alice' })).status).toBe(201)
    expect((await call(forge, BASE, 'POST', '/api/admin/users', admin, { login: 'alice' })).status).toBe(409)
    const issued = await call(forge, BASE, 'POST', '/api/admin/users/alice/tokens', admin, { name: 'cli', scopes: ['repo:admin'] })
    expect(issued.status).toBe(201)
    const alice = (await json<{ token: string }>(issued)).token
    expect((await call(forge, BASE, 'POST', '/api/admin/users', alice, { login: 'mallory' })).status).toBe(403)
    expect((await call(forge, BASE, 'POST', '/api/admin/users/alice/tokens', admin, { scopes: ['root'] })).status).toBe(400)
    expect((await call(forge, BASE, 'POST', '/api/admin/users/nobody/tokens', admin, {})).status).toBe(404)
  })
})

describe('repositories with accounts', () => {
  let forge: NodeForge
  let admin: string
  let alice: string
  let aliceRead: string
  let bob: string

  beforeAll(async () => {
    forge = await nodeForge({ maxLfsObjectBytes: 10 })
    admin = await bootstrap(forge, BASE)
    for (const login of ['alice', 'bob']) await call(forge, BASE, 'POST', '/api/admin/users', admin, { login })
    const token = async (login: string, scopes: string[]) =>
      (await json<{ token: string }>(await call(forge, BASE, 'POST', `/api/admin/users/${login}/tokens`, admin, { scopes }))).token
    alice = await token('alice', ['repo:admin'])
    aliceRead = await token('alice', ['repo:read'])
    bob = await token('bob', ['repo:write'])
  })

  it('creates private repositories by default, in storage and database', async () => {
    const created = await call(forge, BASE, 'POST', '/api/repos', alice, { owner: 'alice', name: 'notes', defaultBranch: 'trunk' })
    expect(created.status).toBe(201)
    expect(await json(created)).toEqual({
      owner: 'alice',
      name: 'notes',
      visibility: 'private',
      defaultBranch: 'trunk',
      cloneUrl: 'https://forge.example/alice/notes.git',
    })
    expect((await readRefs(forge.storage, { owner: 'alice', name: 'notes' }))?.state.head).toBe('refs/heads/trunk')
    expect((await call(forge, BASE, 'POST', '/api/repos', alice, { owner: 'alice', name: 'notes' })).status).toBe(409)
    expect((await call(forge, BASE, 'POST', '/api/repos', alice, { owner: 'bob', name: 'x' })).status).toBe(403)
    expect((await call(forge, BASE, 'POST', '/api/repos', aliceRead, { owner: 'alice', name: 'x' })).status).toBe(403)
    expect((await call(forge, BASE, 'POST', '/api/repos', alice, { owner: 'alice', name: 'x', visibility: 'internal' })).status).toBe(400)
    expect((await call(forge, BASE, 'POST', '/api/repos', admin, { owner: 'bob', name: 'tools' })).status).toBe(201)
  })

  it('authorizes git with personal access tokens', async () => {
    const challenge = await advertise(forge, 'alice/notes', 'git-upload-pack')
    expect(challenge.status).toBe(401)
    expect(challenge.headers.get('WWW-Authenticate')).toContain('Basic')
    expect((await advertise(forge, 'alice/notes', 'git-upload-pack', basic(aliceRead))).status).toBe(200)
    expect((await advertise(forge, 'alice/notes', 'git-receive-pack', basic(aliceRead))).status).toBe(403)
    expect((await advertise(forge, 'alice/notes', 'git-receive-pack', basic(alice))).status).toBe(200)
    expect((await advertise(forge, 'alice/notes', 'git-upload-pack', basic(bob))).status).toBe(404)
    expect((await advertise(forge, 'alice/notes', 'git-upload-pack', basic('gfp_wrong'))).status).toBe(401)
  })

  it('manages visibility and collaborators through repository admins', async () => {
    expect((await call(forge, BASE, 'PATCH', '/api/repos/alice/notes', bob, { visibility: 'public' })).status).toBe(403)
    expect((await call(forge, BASE, 'PUT', '/api/repos/alice/notes/collaborators/bob', alice, { role: 'write' })).status).toBe(200)
    expect((await advertise(forge, 'alice/notes', 'git-receive-pack', basic(bob))).status).toBe(200)
    expect((await call(forge, BASE, 'PUT', '/api/repos/alice/notes/collaborators/bob', alice, { role: 'owner' })).status).toBe(400)
    expect((await call(forge, BASE, 'PATCH', '/api/repos/alice/notes', alice, { visibility: 'public' })).status).toBe(200)
    expect((await advertise(forge, 'alice/notes', 'git-upload-pack')).status).toBe(200)
    expect((await call(forge, BASE, 'PATCH', '/api/repos/alice/missing', alice, { visibility: 'public' })).status).toBe(404)
  })

  it('limits the size of LFS uploads', async () => {
    const put = await forge.fetch(
      new Request(`${BASE}/alice/notes.git/info/lfs/objects/${'a'.repeat(64)}`, {
        method: 'PUT',
        headers: { Authorization: basic(alice), 'Content-Length': '11' },
        body: new Uint8Array(11),
      }),
    )
    expect(put.status).toBe(413)
  })

  it('lets a read-only token read but not push, for example for a CDN pull zone', async () => {
    const reader = (await json<{ token: string }>(await call(forge, BASE, 'POST', '/api/admin/users/bob/tokens', admin, { scopes: ['repo:read'] }))).token
    expect((await advertise(forge, 'bob/tools', 'git-upload-pack', basic(reader))).status).toBe(200)
    expect((await advertise(forge, 'bob/tools', 'git-receive-pack', basic(reader))).status).toBe(403)
    const media = (authorization?: string) =>
      forge.fetch(new Request(`${BASE}/bob/tools/media/${'0'.repeat(64)}`, authorization ? { headers: { Authorization: authorization } } : {}))
    expect((await media()).status).toBe(401)
    expect((await media(`Bearer ${aliceRead}`)).status).toBe(404)
    const missing = await media(`Bearer ${reader}`)
    expect(missing.status).toBe(404)
    expect(await missing.text()).toBe('object does not exist\n')
    const raw = await forge.fetch(new Request(`${BASE}/bob/tools/raw/main/README.md`, { headers: { Authorization: `Bearer ${reader}` } }))
    expect(raw.status).toBe(404)
    expect(await raw.text()).toBe('unknown ref\n')
  })

  it('serves the branch protection API to repository admins', async () => {
    const path = '/api/repos/alice/notes/branches/main/protection'
    expect((await call(forge, BASE, 'PUT', path, bob, { allow_force_pushes: false })).status).toBe(403)
    expect((await call(forge, BASE, 'PUT', path, alice, { allow_force_pushes: false })).status).toBe(200)
    expect((await call(forge, BASE, 'GET', '/api/repos/alice/notes/branch-protection', alice)).status).toBe(200)
  })

  it('answers health checks and unknown paths', async () => {
    expect((await call(forge, BASE, 'GET', '/api/health')).status).toBe(200)
    expect((await call(forge, BASE, 'GET', '/alice/notes/blob/main')).status).toBe(404)
    expect((await call(forge, BASE, 'GET', '/.well-known/jwks.json')).status).toBe(404)
  })
})

describe('federation between two instances', () => {
  let upstream: NodeForge
  let downstream: NodeForge
  let upstreamServer: RunningServer
  let downstreamServer: RunningServer
  let downstreamKey: SigningKey
  let upstreamAdmin: string
  let downstreamAdmin: string
  let pushed: string

  beforeAll(async () => {
    let upstreamHandler = (_request: Request) => Promise.resolve(new Response('starting', { status: 503 }))
    let downstreamHandler = upstreamHandler
    upstreamServer = await startServer((request) => upstreamHandler(request))
    downstreamServer = await startServer((request) => downstreamHandler(request))
    downstreamKey = (await generateSigningKey()).key
    upstream = await nodeForge({ publicUrl: upstreamServer.url, allowInsecureFederation: true })
    downstream = await nodeForge({ publicUrl: downstreamServer.url, instanceKey: downstreamKey, allowInsecureFederation: true })
    upstreamHandler = upstream.fetch
    downstreamHandler = downstream.fetch
    upstreamAdmin = await bootstrap(upstream, upstreamServer.url)
    downstreamAdmin = await bootstrap(downstream, downstreamServer.url)
    await call(upstream, upstreamServer.url, 'POST', '/api/repos', upstreamAdmin, { owner: 'admin', name: 'archive' })
    const source = initRepo()
    sampleHistory(source, 3)
    await git(source, ['-c', `http.extraHeader=Authorization: Bearer ${upstreamAdmin}`, 'push', '-q', `${upstreamServer.url}/admin/archive.git`, 'main'])
    pushed = (await git(source, ['rev-parse', 'main'])).trim()
    await call(downstream, downstreamServer.url, 'POST', '/api/repos', downstreamAdmin, { owner: 'admin', name: 'archive' })
  })

  afterAll(async () => {
    await upstreamServer.close()
    await downstreamServer.close()
  })

  const sync = () => call(downstream, downstreamServer.url, 'POST', '/api/repos/admin/archive/mirrors/origin/sync', downstreamAdmin)

  it('publishes discovery documents only with an instance key', async () => {
    const config = await json<{ issuer: string; jwks_uri: string }>(await call(downstream, downstreamServer.url, 'GET', '/.well-known/openid-configuration'))
    expect(config).toMatchObject({ issuer: downstreamServer.url, jwks_uri: `${downstreamServer.url}/.well-known/jwks.json` })
    expect((await json<{ keys: { kid: string }[] }>(await call(downstream, downstreamServer.url, 'GET', '/.well-known/jwks.json'))).keys[0]?.kid).toBe(downstreamKey.kid)
    expect((await call(upstream, upstreamServer.url, 'GET', '/.well-known/openid-configuration')).status).toBe(404)
  })

  it('mirrors a private repository only after trust and grant', async () => {
    const added = await call(downstream, downstreamServer.url, 'POST', '/api/repos/admin/archive/mirrors', downstreamAdmin, {
      url: `${upstreamServer.url}/admin/archive.git`,
      auth: 'instance',
    })
    expect(added.status).toBe(201)
    const denied = await sync()
    expect(denied.status).toBe(502)
    expect((await json<{ error: string }>(denied)).error).toMatch(/401/)
    expect((await call(upstream, upstreamServer.url, 'POST', '/api/repos/admin/archive/instances', upstreamAdmin, { issuer: downstreamServer.url })).status).toBe(422)
    expect((await call(upstream, upstreamServer.url, 'POST', '/api/admin/instances', upstreamAdmin, { issuer: downstreamServer.url })).status).toBe(200)
    expect((await sync()).status).toBe(502)
    expect((await call(upstream, upstreamServer.url, 'POST', '/api/repos/admin/archive/instances', upstreamAdmin, { issuer: downstreamServer.url })).status).toBe(200)
    const synced = await sync()
    expect(synced.status).toBe(200)
    expect((await json<{ status: string }>(synced)).status).toBe('ok')
    expect((await readRefs(downstream.storage, { owner: 'admin', name: 'archive' }))?.state.refs['refs/upstream/origin/heads/main']).toBe(pushed)
  })

  it('runs due mirrors from the scheduled handler', async () => {
    expect(await downstream.scheduled(new Date())).toEqual([])
    const later = new Date(Date.now() + 31 * 60_000)
    expect(await downstream.scheduled(later)).toEqual([{ repository: 'admin/archive', remote: 'origin', status: 'ok', updates: 0, alarms: 0 }])
    const listed = await json<{ config: { remote: string }; status: { lastSuccessAt: string } }[]>(
      await call(downstream, downstreamServer.url, 'GET', '/api/repos/admin/archive/mirrors', downstreamAdmin),
    )
    expect(listed[0]?.status.lastSuccessAt).toBeDefined()
    expect((await call(downstream, downstreamServer.url, 'POST', '/api/repos/admin/archive/mirrors/origin/detach', downstreamAdmin)).status).toBe(200)
    expect(await downstream.scheduled(new Date(Date.now() + 120 * 60_000))).toEqual([])
  })
})

describe('import endpoint', () => {
  let forge: NodeForge
  let admin: string
  let alice: string
  let aliceWrite: string
  let bob: string
  const jobs: { job: ImportJob; delay: number }[] = []

  beforeAll(async () => {
    forge = await nodeForge({ scheduleImport: async (job, delay) => void jobs.push({ job, delay }) })
    admin = await bootstrap(forge, BASE)
    for (const login of ['alice', 'bob']) await call(forge, BASE, 'POST', '/api/admin/users', admin, { login })
    const token = async (login: string, scopes: string[]) =>
      (await json<{ token: string }>(await call(forge, BASE, 'POST', `/api/admin/users/${login}/tokens`, admin, { scopes }))).token
    alice = await token('alice', ['repo:admin'])
    aliceWrite = await token('alice', ['repo:write'])
    bob = await token('bob', ['repo:admin'])
  })

  it('creates the repository for its owner and schedules the first step with the credentials', async () => {
    const response = await call(forge, BASE, 'POST', '/api/repos/alice/site/import', alice, {
      url: 'https://github.com/acme/site.git',
      token: 'ghp_x',
      commitsPerStep: 50,
      defaultBranch: 'trunk',
    })
    expect(response.status).toBe(202)
    expect(response.headers.get('Location')).toBe('https://forge.example/api/repos/alice/site/import')
    expect(await json(response)).toMatchObject({ phase: 'discover', url: 'https://github.com/acme/site.git', commitsPerStep: 50, cloneUrl: 'https://forge.example/alice/site.git' })
    expect(jobs).toEqual([{ job: { owner: 'alice', name: 'site', authorization: basicAuthorization('git', 'ghp_x') }, delay: 0 }])
    expect((await readRefs(forge.storage, { owner: 'alice', name: 'site' }))?.state.head).toBe('refs/heads/trunk')
    expect(JSON.stringify(await readImportState(forge.storage, { owner: 'alice', name: 'site' }))).not.toContain('ghp_x')
    const status = await call(forge, BASE, 'GET', '/api/repos/alice/site/import', alice)
    expect(status.status).toBe(200)
    expect(await json(status)).toMatchObject({ phase: 'discover' })
    expect((await call(forge, BASE, 'POST', '/api/repos/alice/site/import', alice, { url: 'https://github.com/acme/site.git' })).status).toBe(409)
  })

  it('needs repository admin or instance admin from the verified token', async () => {
    const url = 'https://example.org/x.git'
    expect((await call(forge, BASE, 'POST', '/api/repos/alice/site/import', undefined, { url })).status).toBe(401)
    expect((await call(forge, BASE, 'POST', '/api/repos/alice/site/import', aliceWrite, { url })).status).toBe(403)
    expect((await call(forge, BASE, 'POST', '/api/repos/alice/site/import', bob, { url })).status).toBe(404)
    expect((await call(forge, BASE, 'GET', '/api/repos/alice/site/import', bob)).status).toBe(404)
    expect((await call(forge, BASE, 'POST', '/api/repos/alice/fresh/import', bob, { url })).status).toBe(403)
    expect((await call(forge, BASE, 'POST', '/api/repos/bob/tools/import', admin, { url })).status).toBe(202)
  })

  it('validates the request', async () => {
    const before = jobs.length
    expect((await call(forge, BASE, 'POST', '/api/repos/alice/v1/import', alice, { url: 'ftp://x/y.git' })).status).toBe(400)
    expect((await call(forge, BASE, 'POST', '/api/repos/alice/v2/import', alice, { url: 'https://user:pw@x/y.git' })).status).toBe(400)
    expect((await call(forge, BASE, 'POST', '/api/repos/alice/v3/import', alice, { url: 'https://x/y.git', commitsPerStep: -1 })).status).toBe(400)
    expect((await call(forge, BASE, 'POST', '/api/repos/alice/v4/import', alice, { url: 'https://x/y.git', token: 5 })).status).toBe(400)
    expect((await call(forge, BASE, 'POST', '/api/repos/alice/v5/import', alice, {})).status).toBe(400)
    expect((await call(forge, BASE, 'DELETE', '/api/repos/alice/site/import', alice)).status).toBe(405)
    expect(jobs.length).toBe(before)
    expect((await call(forge, BASE, 'GET', '/api/repos/alice/v1/import', alice)).status).toBe(404)
    expect(await readRefs(forge.storage, { owner: 'alice', name: 'v2' })).toBeNull()
  })

  it('needs a queue', async () => {
    const plain = await nodeForge()
    const token = await bootstrap(plain, BASE)
    expect((await call(plain, BASE, 'POST', '/api/repos/admin/x/import', token, { url: 'https://x/y.git' })).status).toBe(503)
  })

  it('encodes non-ASCII credentials as UTF-8', () => {
    expect(basicAuthorization('git', 'pässword')).toBe(`Basic ${Buffer.from('git:pässword').toString('base64')}`)
  })
})

describe('deployment configuration', () => {
  it('gives every wrangler environment its own Worker, bucket and database with the same vars and migrations', async () => {
    const { readFileSync } = await import('node:fs')
    const { env, ...app } = JSON.parse(readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8')) as Record<string, unknown> & {
      env: Record<string, Record<string, unknown>>
    }
    const migrations = '../../packages/accounts/migrations'
    expect(app.d1_databases).toEqual([{ binding: 'DB', database_name: 'git-forge', migrations_dir: migrations }])
    expect(app.secrets).toEqual({ required: ['BOOTSTRAP_TOKEN'] })
    expect(Object.keys(env)).toEqual(['alpha', 'beta', 'gamma'])
    for (const [name, config] of Object.entries(env)) {
      expect(config).toEqual({
        name: `git-forge-${name}`,
        queues: {
          producers: [{ binding: 'IMPORTS', queue: `git-forge-${name}-imports` }],
          consumers: [{ queue: `git-forge-${name}-imports`, max_batch_size: 1, max_batch_timeout: 1, max_retries: 3 }],
        },
        r2_buckets: [{ binding: 'BUCKET', bucket_name: `git-forge-${name}` }],
        d1_databases: [{ binding: 'DB', database_name: `git-forge-${name}`, migrations_dir: migrations }],
        vars: app.vars,
        secrets: { required: ['BOOTSTRAP_TOKEN'] },
      })
    }
  })
})
