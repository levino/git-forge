import { generateSigningKey, type SigningKey } from '@git-forge/accounts'
import { type ImportJob, lfsObjectKey, listMirrors, readImportState, readRefs, sha256Hex, startImport, ZERO_ID } from '@git-forge/core'
import { basicAuth, chain, fakeLfs, lfsPointer, requireAuthorization } from '@git-forge/core/test/mirror-helpers.ts'
import { S3Storage } from '@git-forge/s3'
import { commitAll, gitBytes, initRepo, sampleHistory, tempDir, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { basicAuthorization, PRESIGN_HINT, RAISE_LIMIT_HINT } from '../../src/app.ts'
import { git, gitFails } from '../e2e/history.ts'
import { DEFAULT_COMPACT_MAX_BYTES, DEFAULT_MAX_LFS_OBJECT_BYTES, loadSecretsKey, parseActionsSettings, parseR2Signing, parseSettings } from '../../src/config.ts'
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

  it('parses the CI settings', async () => {
    expect(parseActionsSettings({})).toBeUndefined()
    const settings = parseActionsSettings({
      ACTIONS: 'true',
      ACTIONS_REPOSITORIES: '{"actions/*": "mirrors/*", "pnpm/action-setup": "mirrors/pnpm-action-setup"}',
      ACTIONS_GITHUB_FALLBACK: 'true',
      ACTIONS_SECRETS_KEY: 'a'.repeat(64),
    })
    expect(settings).toMatchObject({
      repositories: { 'actions/*': 'mirrors/*', 'pnpm/action-setup': 'mirrors/pnpm-action-setup' },
      githubFallback: 'https://api.github.com',
    })
    expect((await loadSecretsKey(settings))?.id).toMatch(/^[0-9a-f]{16}$/)
    expect(await loadSecretsKey(parseActionsSettings({ ACTIONS: 'true' }))).toBeUndefined()
    await expect(loadSecretsKey(parseActionsSettings({ ACTIONS: 'true', ACTIONS_SECRETS_KEY: 'short' }))).rejects.toThrow(/ACTIONS_SECRETS_KEY/)
    expect(() => parseActionsSettings({ ACTIONS: 'true', ACTIONS_REPOSITORIES: '{"actions/checkout": "mirrors/*"}' })).toThrow(/invalid mapping/)
    expect(() => parseActionsSettings({ ACTIONS: 'true', ACTIONS_REPOSITORIES: '[]' })).toThrow(/ACTIONS_REPOSITORIES/)
    expect(() => parseActionsSettings({ ACTIONS: 'true', ACTIONS_GITHUB_FALLBACK: 'http://insecure' })).toThrow(/ACTIONS_GITHUB_FALLBACK/)
    expect(parseActionsSettings({ ACTIONS: 'true', ACTIONS_GITHUB_FALLBACK: 'https://ghe.example/api/v3/' })?.githubFallback).toBe('https://ghe.example/api/v3')
  })

  it('parses the optional R2 signing settings for direct uploads', () => {
    expect(parseR2Signing({})).toBeUndefined()
    expect(() => parseR2Signing({ R2_BUCKET_NAME: 'forge' })).toThrow(/R2_S3_ENDPOINT/)
    expect(parseR2Signing({ R2_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', R2_BUCKET_NAME: 'b', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's' })).toEqual({
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      bucket: 'b',
      accessKeyId: 'k',
      secretAccessKey: 's',
    })
  })

  it('derives the upstream repository from a clone URL', () => {
    expect(upstreamRepository('https://a.example/acme/site.git')).toBe('acme/site')
    expect(upstreamRepository('https://a.example/acme/site')).toBe('acme/site')
    expect(upstreamRepository('https://a.example/acme')).toBeNull()
  })
})

describe('presigned LFS URLs on R2', () => {
  const ACCOUNT = '0123456789abcdef0123456789abcdef'
  const repo = { owner: 'admin', name: 'assets' }
  const big = { oid: 'b'.repeat(64), size: 600 * 1024 * 1024 }

  const setup = async (presign: boolean) => {
    const presigner = new S3Storage({ endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`, region: 'auto', bucket: 'levins-git-forge', accessKeyId: 'key-id', secretAccessKey: 'secret', forcePathStyle: true })
    const forge = await nodeForge({ maxLfsObjectBytes: 1024 * 1024 * 1024, ...(presign ? { presigner } : {}) })
    const admin = await bootstrap(forge, BASE)
    expect((await call(forge, BASE, 'POST', '/api/repos', admin, repo)).status).toBe(201)
    const lfs = (path: string, body: unknown) =>
      forge.fetch(
        new Request(`${BASE}/admin/assets.git/info/lfs/objects/${path}`, {
          method: 'POST',
          headers: { Authorization: basic(admin), 'Content-Type': 'application/vnd.git-lfs+json' },
          body: JSON.stringify(body),
        }),
      )
    const batch = async (operation: string, objects: readonly { oid: string; size: number }[]) =>
      (await json<{ objects: { actions?: Record<string, { href: string; header?: Record<string, string> }> }[] }>(await lfs('batch', { operation, objects }))).objects[0]
        ?.actions
    return { forge, lfs, batch }
  }

  it('hands out R2 URLs signed for the exact length and SHA-256, on the binding key layout, and re-hashes on verify', async () => {
    const { forge, lfs, batch } = await setup(true)
    const upload = await batch('upload', [big])
    const put = new URL(upload?.upload?.href ?? '')
    expect(`${put.origin}${put.pathname}`).toBe(`https://${ACCOUNT}.r2.cloudflarestorage.com/levins-git-forge/${lfsObjectKey(repo, big.oid)}`)
    expect(put.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host;x-amz-checksum-sha256')
    expect(put.searchParams.get('X-Amz-Credential')).toMatch(/^key-id\/\d{8}\/auto\/s3\/aws4_request$/)
    expect(upload?.upload?.header).toEqual({ 'content-length': String(big.size), 'x-amz-checksum-sha256': btoa('»'.repeat(32)) })
    expect(upload?.verify?.href).toBe(`${BASE}/admin/assets.git/info/lfs/objects/verify`)

    const data = new TextEncoder().encode('stored through the binding')
    const oid = sha256Hex(data)
    await forge.storage.put(lfsObjectKey(repo, oid), data, data.length)
    const download = new URL((await batch('download', [{ oid, size: data.length }]))?.download?.href ?? '')
    expect(download.host).toBe(`${ACCOUNT}.r2.cloudflarestorage.com`)
    expect(download.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)

    expect((await lfs('verify', { oid, size: data.length })).status).toBe(200)
    const forged = 'c'.repeat(64)
    await forge.storage.put(lfsObjectKey(repo, forged), data, data.length)
    expect((await lfs('verify', { oid: forged, size: data.length })).status).toBe(422)
  })

  it('keeps proxying LFS through the Worker without R2 credentials', async () => {
    const { batch } = await setup(false)
    expect((await batch('upload', [big]))?.upload?.href).toBe(`${BASE}/admin/assets.git/info/lfs/objects/${big.oid}`)
  })

  it('tells the client how the admin can allow an object above the limit', async () => {
    const tooBig = { oid: 'd'.repeat(64), size: 2 * 1024 * 1024 * 1024 }
    for (const [presign, hint] of [
      [false, PRESIGN_HINT],
      [true, RAISE_LIMIT_HINT],
    ] as const) {
      const { lfs } = await setup(presign)
      const body = await json<{ objects: { error?: { code: number; message: string } }[] }>(await lfs('batch', { operation: 'upload', objects: [tooBig] }))
      expect(body.objects[0]?.error).toEqual({ code: 422, message: `object exceeds ${1024 * 1024 * 1024} bytes; ${hint}` })
    }
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

  it('lets organization owners, but not members, create repositories in the organization', async () => {
    const { store } = forge.services
    const org = await store.createOrganization({ login: 'acme' })
    const [aliceId, bobId] = await Promise.all(['alice', 'bob'].map(async (login) => (await store.findAccount(login))!.id))
    await store.setOrganizationMember(org.id, aliceId!, 'owner')
    await store.setOrganizationMember(org.id, bobId!, 'member')
    expect((await call(forge, BASE, 'POST', '/api/repos', alice, { owner: 'acme', name: 'site' })).status).toBe(201)
    const bobAdmin = (await json<{ token: string }>(await call(forge, BASE, 'POST', '/api/admin/users/bob/tokens', admin, { scopes: ['repo:admin'] }))).token
    expect((await call(forge, BASE, 'POST', '/api/repos', bobAdmin, { owner: 'acme', name: 'other' })).status).toBe(403)
    const aliceUser = { kind: 'user', id: aliceId!, login: 'alice', limits: null, tokenId: null } as const
    expect(await forge.services.repositories.owners(aliceUser)).toEqual(['alice', 'acme'])
    expect(await forge.services.repositories.owners({ ...aliceUser, id: bobId!, login: 'bob' })).toEqual(['bob'])
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
    expect(((await put.json()) as { message: string }).message).toBe(`object exceeds 10 bytes; ${PRESIGN_HINT}`)
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

  it('accepts pack uploads with the permissions and branch protection of receive-pack', async () => {
    const uploads = `${BASE}/alice/notes.git/forge/uploads`
    const request = (method: string, url: string, authorization?: string, body?: unknown) =>
      forge.fetch(
        new Request(url, {
          method,
          headers: { ...(authorization ? { Authorization: authorization } : {}), ...(body instanceof Uint8Array ? { 'Content-Length': String(body.length) } : {}) },
          ...(body instanceof Uint8Array ? { body: body as Uint8Array<ArrayBuffer> } : body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
      )
    expect((await request('GET', uploads)).status).toBe(401)
    expect((await request('GET', uploads, basic(aliceRead))).status).toBe(403)
    expect(await json(await request('GET', uploads, basic(bob)))).toMatchObject({ maxPartBytes: 1024 * 1024, direct: false })
    const source = initRepo()
    const [tip] = sampleHistory(source, 1)
    const pack = gitBytes(source, ['pack-objects', '--revs', '--stdout', '-q'], `${tip}\n`)
    const created = await json<{ id: string }>(await request('POST', uploads, basic(bob), { parts: [{ size: pack.length, sha256: sha256Hex(pack) }] }))
    expect((await request('PUT', `${uploads}/${created.id}/parts/1`, basic(aliceRead), pack)).status).toBe(403)
    expect((await request('PUT', `${uploads}/${created.id}/parts/1`, basic(bob), pack)).status).toBe(201)
    const finalize = (commands: unknown[]) => request('POST', `${uploads}/${created.id}/finalize`, basic(bob), { commands })
    expect(await json(await finalize([{ name: 'refs/heads/main', oldId: ZERO_ID, newId: tip }]))).toEqual({ unpack: 'ok', results: [{ name: 'refs/heads/main', ok: true }] })
    const deletion = await json<{ results: { ok: boolean; reason?: string }[] }>(await finalize([{ name: 'refs/heads/main', oldId: tip, newId: ZERO_ID }]))
    expect(deletion.results[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/^protected branch: /) })
    expect((await readRefs(forge.storage, { owner: 'alice', name: 'notes' }))?.state.refs['refs/heads/main']).toBe(tip)
  })

  it('answers health checks and unknown paths', async () => {
    expect((await call(forge, BASE, 'GET', '/api/health')).status).toBe(200)
    expect((await call(forge, BASE, 'GET', '/alice/notes/blob/main')).status).toBe(404)
    expect((await call(forge, BASE, 'GET', '/.well-known/jwks.json')).status).toBe(404)
  })
})

describe('branch protection on push', () => {
  let forge: NodeForge
  let server: RunningServer
  let owner: string
  let writer: string

  const bearer = (token: string) => ['-c', `http.extraHeader=Authorization: Bearer ${token}`]
  const remote = () => `${server.url}/owner/guarded.git`
  const refs = async () => (await readRefs(forge.storage, { owner: 'owner', name: 'guarded' }))!.state.refs
  const clone = async (token: string) => {
    const dir = tempDir()
    await git(dir, [...bearer(token), 'clone', '-q', remote(), 'out'])
    return `${dir}/out`
  }
  const protect = async (body: unknown) =>
    expect((await call(forge, server.url, 'PUT', '/api/repos/owner/guarded/branches/main/protection', owner, body)).status).toBe(200)

  beforeAll(async () => {
    let handler = (_request: Request) => Promise.resolve(new Response('starting', { status: 503 }))
    server = await startServer((request) => handler(request))
    forge = await nodeForge()
    handler = forge.fetch
    owner = await bootstrap(forge, server.url, 'owner')
    await call(forge, server.url, 'POST', '/api/admin/users', owner, { login: 'wanda' })
    writer = (await json<{ token: string }>(await call(forge, server.url, 'POST', '/api/admin/users/wanda/tokens', owner, { scopes: ['repo:write'] }))).token
    expect((await call(forge, server.url, 'POST', '/api/repos', owner, { owner: 'owner', name: 'guarded' })).status).toBe(201)
    expect((await call(forge, server.url, 'PUT', '/api/repos/owner/guarded/collaborators/wanda', owner, { role: 'write' })).status).toBe(200)
    const seed = initRepo()
    sampleHistory(seed, 2)
    await git(seed, [...bearer(writer), 'push', '-q', remote(), 'main', 'main:refs/heads/topic'])
    await protect({ required_status_checks: null, enforce_admins: null, required_pull_request_reviews: null, restrictions: null })
  })

  afterAll(async () => {
    await server.close()
  })

  it('rejects force pushes and deletions of a protected branch and archives nothing', async () => {
    const dir = await clone(writer)
    const before = await refs()
    await git(dir, ['commit', '-q', '--amend', '-m', 'rewritten'])
    expect(await gitFails(dir, [...bearer(writer), 'push', '--force', 'origin', 'main'])).toContain('! [remote rejected] main -> main (protected branch: force push is not allowed)')
    expect(await gitFails(dir, [...bearer(writer), 'push', 'origin', ':main'])).toContain('! [remote rejected] main (protected branch: deletion is not allowed)')
    expect(await refs()).toEqual(before)
    await git(dir, [...bearer(writer), 'push', '-q', '--force', 'origin', 'main:topic'])
    await git(dir, [...bearer(writer), 'push', '-q', 'origin', ':topic'])
    await git(dir, ['reset', '-q', '--hard', 'origin/main'])
    writeFile(dir, 'next.txt', 'next\n')
    commitAll(dir, 'next')
    await git(dir, [...bearer(writer), 'push', '-q', 'origin', 'main'])
    expect((await refs())['refs/heads/main']).toBe((await git(dir, ['rev-parse', 'main'])).trim())
    expect((await refs())['refs/heads/topic']).toBeUndefined()
  })

  it('lets repository admins bypass the rule unless enforce_admins is set', async () => {
    const dir = await clone(owner)
    await git(dir, ['commit', '-q', '--amend', '-m', 'admin rewrite'])
    await git(dir, [...bearer(owner), 'push', '-q', '--force', 'origin', 'main'])
    await protect({ required_status_checks: null, enforce_admins: true, required_pull_request_reviews: null, restrictions: null })
    await git(dir, ['commit', '-q', '--amend', '-m', 'second admin rewrite'])
    expect(await gitFails(dir, [...bearer(owner), 'push', '--force', 'origin', 'main'])).toContain('(protected branch: force push is not allowed)')
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

  it('lets only instance admins add mirrors with instance authentication', async () => {
    await call(downstream, downstreamServer.url, 'POST', '/api/admin/users', downstreamAdmin, { login: 'carol' })
    const carol = (await json<{ token: string }>(await call(downstream, downstreamServer.url, 'POST', '/api/admin/users/carol/tokens', downstreamAdmin, { scopes: ['repo:admin'] }))).token
    await call(downstream, downstreamServer.url, 'POST', '/api/repos', carol, { owner: 'carol', name: 'copy' })
    const url = `${upstreamServer.url}/admin/archive.git`
    expect((await call(downstream, downstreamServer.url, 'POST', '/api/repos/carol/copy/mirrors', carol, { url, auth: 'instance' })).status).toBe(403)
    expect(await listMirrors(downstream.storage, { owner: 'carol', name: 'copy' })).toEqual([])
    expect((await call(downstream, downstreamServer.url, 'POST', '/api/repos/carol/copy/mirrors', carol, { url, mode: 'manual' })).status).toBe(201)
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

  it('runs an import LFS job without federation and sends the import token to the LFS endpoint', async () => {
    const asset = new TextEncoder().encode('large asset\n')
    const pointer = lfsPointer(asset)
    const token = basicAuth('git', 'lfs-job-token')
    const lfs = fakeLfs({ read: async (oid) => (oid === pointer.oid ? asset : null) })
    const server = await startServer(chain(requireAuthorization(token), lfs.handler))
    try {
      const repo = { owner: 'alice', name: 'media' }
      const url = `${server.url}/acme/media.git`
      await startImport(forge.storage, repo, { url })
      await forge.runJob({ kind: 'import-lfs', ...repo, oid: pointer.oid, size: pointer.size, endpoint: { url: `${url}/info/lfs`, source: 'default' }, authorization: token })
      expect(lfs.batches).toEqual([{ authorization: token, oids: [pointer.oid] }])
      expect(await forge.storage.head(lfsObjectKey(repo, pointer.oid))).toMatchObject({ size: pointer.size })
    } finally {
      await server.close()
    }
  })

  it('encodes non-ASCII credentials as UTF-8', () => {
    expect(basicAuthorization('git', 'pässword')).toBe(`Basic ${Buffer.from('git:pässword').toString('base64')}`)
  })
})

describe('deployment configuration', () => {
  it('gives every wrangler environment its own Worker, bucket, database, job queue and runner container with the same vars and migrations', async () => {
    const { readFileSync } = await import('node:fs')
    const { env, ...app } = JSON.parse(readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8')) as Record<string, unknown> & {
      env: Record<string, Record<string, unknown>>
    }
    const migrations = '../../packages/accounts/migrations'
    expect(app.d1_databases).toEqual([{ binding: 'DB', database_name: 'git-forge', migrations_dir: migrations }])
    expect(app.secrets).toBeUndefined()
    const queues = (prefix: string) => ({
      producers: [
        { binding: 'IMPORTS', queue: `${prefix}-imports` },
        { binding: 'JOBS', queue: `${prefix}-jobs` },
      ],
      consumers: [
        { queue: `${prefix}-imports`, max_batch_size: 1, max_batch_timeout: 1, max_retries: 3 },
        { queue: `${prefix}-jobs`, max_batch_size: 1, max_batch_timeout: 1, max_retries: 10 },
      ],
    })
    expect(app.queues).toEqual(queues('git-forge'))
    expect(Object.keys(env)).toEqual(['alpha', 'beta', 'gamma'])
    for (const [name, config] of Object.entries(env)) {
      expect(config).toEqual({
        name: `git-forge-${name}`,
        queues: queues(`git-forge-${name}`),
        r2_buckets: [{ binding: 'BUCKET', bucket_name: `git-forge-${name}` }],
        d1_databases: [{ binding: 'DB', database_name: `git-forge-${name}`, migrations_dir: migrations }],
        vars: app.vars,
        containers: app.containers,
        durable_objects: app.durable_objects,
        migrations: app.migrations,
      })
    }
    expect(app.containers).toEqual([{ class_name: 'RunnerContainer', image: './runner/Dockerfile', instance_type: 'basic', max_instances: 4 }])
    expect(app.durable_objects).toEqual({ bindings: [{ name: 'RUNNER', class_name: 'RunnerContainer' }] })
    expect(app.migrations).toEqual([{ tag: 'v1', new_sqlite_classes: ['RunnerContainer'] }])
    expect(app.dev).toEqual({ enable_containers: false })
  })
})
