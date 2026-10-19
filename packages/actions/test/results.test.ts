import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { base64UrlDecode, decodeJwt, utf8 } from '@git-forge/accounts'
import { createRepository, parseWorkflow, readAll, WorkflowError } from '@git-forge/core'
import { commitAll, gitEnv, initRepo, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { afterEach, describe, expect, it } from 'vitest'
import {
  artifactExpiry,
  cacheScopes,
  DEFAULT_CACHE_LIMITS,
  entriesOverQuota,
  evictCaches,
  generateEs256Key,
  idTokenAllowed,
  importEs256Key,
  matchCacheEntry,
  openArtifactFile,
  parseBlockList,
  planRangeParts,
  type RunnerLaunch,
  verifyToken,
} from '../src/index.ts'
import { ADMIN_TOKEN, createTestForge, SERVICE_PATH, type TestForge } from './forge.ts'
import { type DeliveredJob, FakeRunner } from './runner-client.ts'

const run = promisify(execFile)

const servers: RunningServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

const WORKFLOW = `on: push
permissions:
  contents: read
jobs:
  build:
    runs-on: self-hosted
    permissions:
      id-token: write
    steps:
      - run: echo build
`

const harness = async (workflow = WORKFLOW) => {
  const launches: RunnerLaunch[] = []
  const clock = { offset: 0 }
  const key = await importEs256Key(await generateEs256Key())
  const forge = await createTestForge({ launcher: { launch: async (launch) => void launches.push(launch) }, messageWaitMs: 0, now: () => Date.now() + clock.offset, idTokenKeys: [key] })
  const server = await startServer(forge.handler)
  servers.push(server)
  await createRepository(forge.storage, { owner: 'acme', name: 'site' })
  const source = initRepo()
  const remote = `${server.url.replace('://', `://admin:${ADMIN_TOKEN}@`)}/acme/site.git`
  const push = async (files: Record<string, string>, branch = 'main') => {
    for (const [path, content] of Object.entries(files)) writeFile(source, path, content)
    commitAll(source, 'change')
    await run('git', ['push', '-q', remote, `HEAD:refs/heads/${branch}`], { cwd: source, env: { ...process.env, ...gitEnv } })
  }
  const start = async (index: number): Promise<{ runner: FakeRunner; job: DeliveredJob }> => {
    const runner = await FakeRunner.connect(server.url, SERVICE_PATH, launches[index]!.encodedJitConfig)
    const job = await runner.take()
    expect(await runner.renew(job)).toBe(200)
    return { runner, job }
  }
  return { forge, server, launches, clock, key, push, start }
}

const authorized = (job: DeliveredJob, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { Authorization: `Bearer ${job.runtimeToken}`, 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) },
})

const twirp = async (server: RunningServer, job: DeliveredJob, service: 'CacheService' | 'ArtifactService', method: string, body: unknown) => {
  const response = await fetch(`${server.url}/twirp/github.actions.results.api.v1.${service}/${method}`, authorized(job, { method: 'POST', body: JSON.stringify(body) }))
  return { status: response.status, body: (await response.json()) as Record<string, any> }
}

const zipOf = async (entries: readonly { name: string; data: Uint8Array; deflate: boolean }[]): Promise<Uint8Array> => {
  const header = (size: number, write: (view: DataView) => void) => {
    const bytes = new Uint8Array(size)
    write(new DataView(bytes.buffer))
    return bytes
  }
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const name = utf8(entry.name)
    const data = entry.deflate ? await readAll(new Blob([entry.data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate-raw'))) : entry.data
    const method = entry.deflate ? 8 : 0
    locals.push(header(30, (v) => (v.setUint32(0, 0x04034b50, true), v.setUint16(8, method, true), v.setUint32(18, data.length, true), v.setUint32(22, entry.data.length, true), v.setUint16(26, name.length, true))), name, data)
    centrals.push(
      header(46, (v) => (v.setUint32(0, 0x02014b50, true), v.setUint16(10, method, true), v.setUint32(20, data.length, true), v.setUint32(24, entry.data.length, true), v.setUint16(28, name.length, true), v.setUint32(42, offset, true))),
      name,
    )
    offset += 30 + name.length + data.length
  }
  const size = centrals.reduce((total, part) => total + part.length, 0)
  const end = header(22, (v) => (v.setUint32(0, 0x06054b50, true), v.setUint16(10, entries.length, true), v.setUint32(12, size, true), v.setUint32(16, offset, true)))
  return new Uint8Array(await new Blob([...locals, ...centrals, end] as Uint8Array<ArrayBuffer>[]).arrayBuffer())
}

const endpointData = (job: DeliveredJob): Record<string, string> => job.message.resources.endpoints[0].data

const backendIds = (job: DeliveredJob) => {
  const scope = String(decodeJwt(job.runtimeToken)!.payload['scp'])
  const [, runId, jobId] = scope.split(':')
  return { workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId }
}

describe('results service', () => {
  it('advertises the cache, results and ID token URLs to the runner', async () => {
    const h = await harness()
    await h.push({ '.github/workflows/ci.yml': WORKFLOW })
    const { job } = await h.start(0)
    expect(endpointData(job)).toEqual({
      CacheServerUrl: `${h.server.url}/_services/cache/`,
      ResultsServiceUrl: `${h.server.url}/`,
      GenerateIdTokenUrl: `${h.server.url}/_services/token/idtoken?api-version=2.0`,
    })
    expect(job.message.variables['actions_uses_cache_service_v2']).toEqual({ value: 'true' })
    expect(backendIds(job).workflow_job_run_backend_id).toBe(job.jobId)
  })

  it('stores, finds and downloads caches over the v1 protocol with chunks in any order', async () => {
    const h = await harness()
    await h.push({ '.github/workflows/ci.yml': WORKFLOW })
    const { runner, job } = await h.start(0)
    const base = `${endpointData(job)['CacheServerUrl']}_apis/artifactcache/`
    const version = 'a'.repeat(64)
    expect((await fetch(`${base}cache?keys=deps-linux-123,deps-linux-&version=${version}`, authorized(job))).status).toBe(204)
    const reserve = await fetch(`${base}caches`, authorized(job, { method: 'POST', body: JSON.stringify({ key: 'deps-linux-123', version, cacheSize: 10 }) }))
    expect(reserve.status).toBe(201)
    const { cacheId } = (await reserve.json()) as { cacheId: number }
    expect((await fetch(`${base}caches`, authorized(job, { method: 'POST', body: JSON.stringify({ key: 'deps-linux-123', version }) }))).status).toBe(409)
    const patch = (start: number, data: string) =>
      fetch(`${base}caches/${cacheId}`, authorized(job, { method: 'PATCH', body: data, headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${start + data.length - 1}/*` } }))
    expect((await patch(6, 'world')).status).toBe(204)
    expect((await patch(0, 'hello ')).status).toBe(204)
    expect((await fetch(`${base}caches/${cacheId}`, authorized(job, { method: 'POST', body: JSON.stringify({ size: 12 }) }))).status).toBe(400)
    expect((await fetch(`${base}caches/${cacheId}`, authorized(job, { method: 'POST', body: JSON.stringify({ size: 11 }) }))).status).toBe(204)
    const hit = await fetch(`${base}cache?keys=deps-linux-999,deps-linux-&version=${version}`, authorized(job))
    expect(hit.status).toBe(200)
    const entry = (await hit.json()) as { cacheKey: string; scope: string; archiveLocation: string }
    expect(entry).toMatchObject({ cacheKey: 'deps-linux-123', scope: 'refs/heads/main' })
    const download = await fetch(entry.archiveLocation)
    expect(download.headers.get('content-length')).toBe('11')
    expect(await download.text()).toBe('hello world')
    const ranged = await fetch(entry.archiveLocation, { headers: { Range: 'bytes=4-7' } })
    expect(ranged.status).toBe(206)
    expect(await ranged.text()).toBe('o wo')
    expect((await fetch(`${base}cache?keys=deps-linux-123&version=${'b'.repeat(64)}`, authorized(job))).status).toBe(204)
    const listed = (await (await fetch(`${h.server.url}/api/v3/repos/acme/site/actions/caches`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } })).json()) as { actions_caches: { key: string; size_in_bytes: number }[] }
    expect(listed.actions_caches).toMatchObject([{ key: 'deps-linux-123', size_in_bytes: 11 }])
    await runner.finish(job, 'succeeded')
    expect((await fetch(entry.archiveLocation)).status).toBe(403)
    expect(await verifyToken(h.forge.db, job.runtimeToken, 'runtime', Date.now())).toBeNull()
  })

  it('stores caches over the twirp v2 protocol with Azure block blob uploads and scopes them by ref', async () => {
    const h = await harness()
    await h.push({ '.github/workflows/ci.yml': WORKFLOW })
    const main = await h.start(0)
    const version = 'c'.repeat(64)
    const created = await twirp(h.server, main.job, 'CacheService', 'CreateCacheEntry', { key: 'npm-abc', version })
    expect(created.body).toMatchObject({ ok: true })
    const put = await fetch(created.body['signed_upload_url'], { method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Length': '7' }, body: 'archive' })
    expect(put.status).toBe(201)
    expect((await fetch(created.body['signed_upload_url'], { method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob' }, body: 'again' })).status).toBe(409)
    expect((await twirp(h.server, main.job, 'CacheService', 'FinalizeCacheEntryUpload', { key: 'npm-abc', version, size_bytes: '7' })).body).toMatchObject({ ok: true })
    expect((await twirp(h.server, main.job, 'CacheService', 'CreateCacheEntry', { key: 'npm-abc', version })).body).toMatchObject({ ok: false })
    await main.runner.finish(main.job, 'succeeded')

    await h.push({ 'feature.txt': 'x\n' }, 'feature')
    const feature = await h.start(1)
    const found = await twirp(h.server, feature.job, 'CacheService', 'GetCacheEntryDownloadURL', { key: 'npm-xyz', restore_keys: ['npm-'], version })
    expect(found.body).toMatchObject({ ok: true, matched_key: 'npm-abc' })
    expect(await (await fetch(found.body['signed_download_url'])).text()).toBe('archive')
    const own = await twirp(h.server, feature.job, 'CacheService', 'CreateCacheEntry', { key: 'npm-feature', version })
    await fetch(own.body['signed_upload_url'], { method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob' }, body: 'feat' })
    expect((await twirp(h.server, feature.job, 'CacheService', 'FinalizeCacheEntryUpload', { key: 'npm-feature', version, size_bytes: '4' })).body).toMatchObject({ ok: true })
    await feature.runner.finish(feature.job, 'succeeded')

    await h.push({ 'main.txt': 'y\n' })
    const later = await h.start(2)
    expect((await twirp(h.server, later.job, 'CacheService', 'GetCacheEntryDownloadURL', { key: 'npm-feature', version })).body).toEqual({ ok: false })
  })

  it('evicts unused caches and caches over the repository quota without deleting bytes', async () => {
    const h = await harness()
    await h.push({ '.github/workflows/ci.yml': WORKFLOW })
    const { job } = await h.start(0)
    const version = 'd'.repeat(64)
    for (const key of ['one', 'two']) {
      const created = await twirp(h.server, job, 'CacheService', 'CreateCacheEntry', { key, version })
      await fetch(created.body['signed_upload_url'], { method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob' }, body: '12345' })
      await twirp(h.server, job, 'CacheService', 'FinalizeCacheEntryUpload', { key, version, size_bytes: '5' })
    }
    const objects = async () => {
      let count = 0
      for await (const _ of h.forge.storage.list('repos/')) count++
      return count
    }
    const before = await objects()
    expect(await evictCaches(h.forge.db, Date.now(), { ...DEFAULT_CACHE_LIMITS, repositoryBytes: 7 })).toBe(1)
    expect(await evictCaches(h.forge.db, Date.now() + 8 * 24 * 3_600_000)).toBe(1)
    expect(await objects()).toBe(before)
    expect((await twirp(h.server, job, 'CacheService', 'GetCacheEntryDownloadURL', { key: 'one', restore_keys: ['t'], version })).body).toEqual({ ok: false })
  })

  it('uploads, lists and downloads v4 artifacts and enforces the token scope', async () => {
    const h = await harness()
    await h.push({ '.github/workflows/ci.yml': WORKFLOW })
    const { runner, job } = await h.start(0)
    const ids = backendIds(job)
    const created = await twirp(h.server, job, 'ArtifactService', 'CreateArtifact', { ...ids, name: 'dist', version: 4, expires_at: new Date(Date.now() + 86_400_000).toISOString() })
    expect(created.body).toMatchObject({ ok: true })
    const url = created.body['signed_upload_url'] as string
    const block = (id: string, data: string) => fetch(`${url}?comp=block&blockid=${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Length': String(data.length) }, body: data })
    expect((await block('YmxvY2stMg==', 'PK-second')).status).toBe(201)
    expect((await block('YmxvY2stMQ==', 'PK-first;')).status).toBe(201)
    const list = '<?xml version="1.0" encoding="utf-8"?><BlockList><Latest>YmxvY2stMQ==</Latest><Latest>YmxvY2stMg==</Latest></BlockList>'
    expect((await fetch(`${url}?comp=blocklist`, { method: 'PUT', body: list })).status).toBe(201)
    expect((await twirp(h.server, job, 'ArtifactService', 'FinalizeArtifact', { ...ids, name: 'dist', size: '18', hash: 'sha256:abc' })).body).toMatchObject({ ok: true })
    expect((await twirp(h.server, job, 'ArtifactService', 'CreateArtifact', { ...ids, name: 'dist', version: 4 })).status).toBe(409)
    expect((await twirp(h.server, job, 'ArtifactService', 'CreateArtifact', { ...ids, workflow_job_run_backend_id: 'other', name: 'x', version: 4 })).status).toBe(403)
    const listed = await twirp(h.server, job, 'ArtifactService', 'ListArtifacts', { ...ids, name_filter: 'dist' })
    expect(listed.body['artifacts']).toMatchObject([{ name: 'dist', size: '18', digest: 'sha256:abc' }])
    const signed = await twirp(h.server, job, 'ArtifactService', 'GetSignedArtifactURL', { ...ids, name: 'dist' })
    const download = await fetch(signed.body['signed_url'])
    expect(download.headers.get('content-type')).toBe('application/zip')
    expect(download.headers.get('content-disposition')).toContain('dist.zip')
    expect(await download.text()).toBe('PK-first;PK-second')
    await runner.finish(job, 'succeeded')

    const api = (path: string, init: RequestInit = {}) => fetch(`${h.server.url}/api/v3/repos/acme/site/actions${path}`, { redirect: 'manual', ...init, headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } })
    const rest = (await (await api('/artifacts')).json()) as { artifacts: { id: number; name: string; expired: boolean; size_in_bytes: number }[] }
    expect(rest.artifacts).toMatchObject([{ name: 'dist', expired: false, size_in_bytes: 18 }])
    const zip = await api(`/artifacts/${rest.artifacts[0]!.id}/zip`)
    expect(zip.status).toBe(302)
    expect(await (await fetch(zip.headers.get('location')!)).text()).toBe('PK-first;PK-second')
    expect((await api(`/artifacts/${rest.artifacts[0]!.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(((await (await api('/artifacts')).json()) as { total_count: number }).total_count).toBe(0)
  })

  it('serves artifact blobs as sandboxed attachments whatever mime_type the uploader chose', async () => {
    const h = await harness()
    await h.push({ '.github/workflows/ci.yml': WORKFLOW })
    const { job } = await h.start(0)
    const ids = backendIds(job)
    const created = await twirp(h.server, job, 'ArtifactService', 'CreateArtifact', { ...ids, name: 'page', version: 7, mime_type: 'text/html' })
    const url = created.body['signed_upload_url'] as string
    await fetch(url, { method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob' }, body: '<script>1</script>' })
    await twirp(h.server, job, 'ArtifactService', 'FinalizeArtifact', { ...ids, name: 'page', size: '18' })
    const signed = await twirp(h.server, job, 'ArtifactService', 'GetSignedArtifactURL', { ...ids, name: 'page' })
    const download = await fetch(signed.body['signed_url'])
    expect(download.headers.get('content-disposition')).toMatch(/^attachment; filename="page/)
    expect(download.headers.get('x-content-type-options')).toBe('nosniff')
    expect(download.headers.get('content-security-policy')).toMatch(/sandbox$/)
    expect(await download.text()).toBe('<script>1</script>')
  })

  it('opens artifact.tar inside a stored artifact zip for Pages', async () => {
    const h = await harness()
    await h.push({ '.github/workflows/ci.yml': WORKFLOW })
    const { job } = await h.start(0)
    const ids = backendIds(job)
    const tar = utf8('tar bytes '.repeat(100))
    const zip = await zipOf([
      { name: 'other.txt', data: utf8('x'), deflate: false },
      { name: 'artifact.tar', data: tar, deflate: true },
    ])
    const created = await twirp(h.server, job, 'ArtifactService', 'CreateArtifact', { ...ids, name: 'github-pages', version: 4 })
    const url = created.body['signed_upload_url'] as string
    const half = Math.floor(zip.length / 2)
    await fetch(`${url}?comp=block&blockid=YQ==`, { method: 'PUT', body: zip.slice(0, half) })
    await fetch(`${url}?comp=block&blockid=Yg==`, { method: 'PUT', body: zip.slice(half) })
    await fetch(`${url}?comp=blocklist`, { method: 'PUT', body: '<BlockList><Latest>YQ==</Latest><Latest>Yg==</Latest></BlockList>' })
    const finalized = await twirp(h.server, job, 'ArtifactService', 'FinalizeArtifact', { ...ids, name: 'github-pages', size: String(zip.length) })
    const id = Number(finalized.body['artifact_id'])
    const stream = await openArtifactFile(h.forge.db, h.forge.storage, 'acme', 'site', id, Date.now())
    expect(await readAll(stream!)).toEqual(tar)
    expect(await openArtifactFile(h.forge.db, h.forge.storage, 'acme', 'other', id, Date.now())).toBeNull()
  })

  it('issues ID tokens with GitHub-shaped claims signed with the published key', async () => {
    const h = await harness()
    await h.push({ '.github/workflows/ci.yml': WORKFLOW })
    const { job } = await h.start(0)
    const response = await fetch(`${endpointData(job)['GenerateIdTokenUrl']}&audience=sts.amazonaws.com`, authorized(job))
    expect(response.status).toBe(200)
    const token = ((await response.json()) as { value: string }).value
    const decoded = decodeJwt(token)!
    expect(decoded.header).toMatchObject({ alg: 'ES256', kid: h.key.kid })
    expect(decoded.payload).toMatchObject({
      iss: `${h.server.url}/_services/token`,
      aud: 'sts.amazonaws.com',
      sub: 'repo:acme/site:ref:refs/heads/main',
      repository: 'acme/site',
      repository_owner: 'acme',
      ref: 'refs/heads/main',
      event_name: 'push',
      workflow: '.github/workflows/ci.yml',
      job_workflow_ref: 'acme/site/.github/workflows/ci.yml@refs/heads/main',
      runner_environment: 'self-hosted',
    })
    const discovery = (await (await fetch(`${h.server.url}/_services/token/.well-known/openid-configuration`)).json()) as { issuer: string; jwks_uri: string }
    expect(discovery.issuer).toBe(decoded.payload['iss'])
    const jwks = (await (await fetch(discovery.jwks_uri)).json()) as { keys: JsonWebKey[] }
    const publicKey = await crypto.subtle.importKey('jwk', jwks.keys[0]!, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, decoded.signature, utf8(decoded.signingInput))).toBe(true)
    expect(base64UrlDecode(token.split('.')[2]!).length).toBe(64)
  })

  it('refuses ID tokens to jobs without id-token: write', async () => {
    const h = await harness()
    await h.push({ '.github/workflows/ci.yml': WORKFLOW.replace('      id-token: write', '      contents: read') })
    const { job } = await h.start(0)
    expect(endpointData(job)['GenerateIdTokenUrl']).toBeUndefined()
    expect((await fetch(`${h.server.url}/_services/token/idtoken?api-version=2.0`, authorized(job))).status).toBe(403)
  })
})

describe('results service functions', () => {
  it('orders cache scopes like GitHub: own ref, pull request base, default branch', () => {
    expect(cacheScopes({ ref: 'refs/pull/4/merge', baseRef: 'develop', defaultBranch: 'refs/heads/main' })).toEqual(['refs/pull/4/merge', 'refs/heads/develop', 'refs/heads/main'])
    expect(cacheScopes({ ref: 'refs/heads/main', baseRef: null, defaultBranch: 'refs/heads/main' })).toEqual(['refs/heads/main'])
  })

  it('matches the primary key exactly, then restore keys exactly and by prefix, newest first, scope by scope', () => {
    const entries = [
      { id: 1, scope: 'refs/heads/main', key: 'deps-a', created_at: 1 },
      { id: 2, scope: 'refs/heads/main', key: 'deps-b', created_at: 2 },
      { id: 3, scope: 'refs/heads/feature', key: 'deps-c', created_at: 0 },
    ]
    const scopes = ['refs/heads/feature', 'refs/heads/main']
    expect(matchCacheEntry(entries, scopes, 'deps-a', [])?.id).toBe(1)
    expect(matchCacheEntry(entries, scopes, 'deps-x', ['deps-'])?.id).toBe(3)
    expect(matchCacheEntry(entries, ['refs/heads/main'], 'deps-x', ['deps-'])?.id).toBe(2)
    expect(matchCacheEntry(entries, ['refs/heads/main'], 'deps', [])).toBeNull()
  })

  it('evicts least recently used entries until the repository fits its quota', () => {
    const entries = [
      { id: 1, size: 5, last_accessed_at: 30 },
      { id: 2, size: 5, last_accessed_at: 10 },
      { id: 3, size: 5, last_accessed_at: 20 },
    ]
    expect(entriesOverQuota(entries, 10).map((entry) => entry.id)).toEqual([2])
    expect(entriesOverQuota(entries, 4).map((entry) => entry.id)).toEqual([2, 3, 1])
  })

  it('assembles v1 chunks by offset and rejects gaps', () => {
    const staged = [
      { block_id: 'range:5-9', key: 'b', size: 5 },
      { block_id: 'range:0-4', key: 'a', size: 5 },
    ]
    expect(planRangeParts(staged, 10).map((part) => [part.key, part.offset])).toEqual([
      ['a', 0],
      ['b', 5],
    ])
    expect(() => planRangeParts(staged.slice(0, 1), 10)).toThrow(/missing bytes 0-4/)
  })

  it('parses Azure block lists', () => {
    expect(parseBlockList('<?xml version="1.0"?><BlockList><Latest>a&#61;</Latest><Uncommitted>b</Uncommitted></BlockList>')).toEqual(['a=', 'b'])
    expect(parseBlockList('<nope/>')).toBeNull()
  })

  it('clamps artifact retention to the instance maximum', () => {
    expect(artifactExpiry(0, null, 90)).toBe(90 * 86_400_000)
    expect(artifactExpiry(0, 86_400_000, 90)).toBe(86_400_000)
    expect(artifactExpiry(0, 1000 * 86_400_000, 90)).toBe(90 * 86_400_000)
  })

  it('parses permissions and only grants ID tokens to trusted runs with id-token: write', () => {
    const workflow = parseWorkflow(WORKFLOW)
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.jobs[0]!.permissions).toEqual({ 'id-token': 'write' })
    const definition = { workflow, inputs: {}, payload: {} }
    const job = { job: workflow.jobs[0]!, workflowEnv: {} }
    expect(idTokenAllowed({ trusted: 1 }, definition, job)).toBe(true)
    expect(idTokenAllowed({ trusted: 0 }, definition, job)).toBe(false)
    expect(idTokenAllowed({ trusted: 1 }, { ...definition, workflow: { ...workflow, permissions: 'write-all' } }, { ...job, job: { ...job.job, permissions: undefined } } as never)).toBe(true)
    expect(idTokenAllowed({ trusted: 1 }, { ...definition, workflow: { ...workflow, permissions: 'read-all' } }, { ...job, job: { ...job.job, permissions: undefined } } as never)).toBe(false)
    expect(() => parseWorkflow(WORKFLOW.replace('id-token: write', 'id-token: read'))).toThrow(WorkflowError)
    expect(() => parseWorkflow(WORKFLOW.replace('contents: read', 'kontents: read'))).toThrow(/not a known permission scope/)
  })
})
