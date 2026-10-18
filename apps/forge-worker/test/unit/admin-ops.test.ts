import { sha256Hex, sql } from '@git-forge/accounts'
import { beforeAll, describe, expect, it } from 'vitest'
import { estimateMonthlyCost, monthFraction } from '../../src/admin/costs.ts'
import { setupChecks } from '../../src/admin/setup.ts'
import { isNewer, readPin, repin } from '../../src/admin/updates.ts'
import { classifyKey } from '../../src/admin/usage.ts'
import type { AppJob } from '../../src/app.ts'
import { BOOTSTRAP_TOKEN, bootstrap, call, type NodeForge, nodeForge } from '../support/node-forge.ts'

const BASE = 'https://forge.example'
const SUMS = new TextEncoder().encode('abc  git-forge-worker.mjs\n')
const TOML = 'name = "x"\n[build]\ncommand = "V=0.8.3 S=' + 'a'.repeat(64) + ' && U=… && curl"\n'

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T

describe('update helpers', () => {
  it('compares versions and rewrites exactly one pin', () => {
    expect(isNewer('0.10.0', '0.9.9')).toBe(true)
    expect(isNewer('0.9.0', '0.9.0')).toBe(false)
    expect(isNewer('1.0.0', 'dev')).toBe(false)
    expect(readPin(TOML)).toEqual({ version: '0.8.3', sha256: 'a'.repeat(64) })
    expect(repin(TOML, { version: '0.9.0', sha256: 'b'.repeat(64) })).toContain(`V=0.9.0 S=${'b'.repeat(64)} && U=`)
    expect(() => repin('no pin', { version: '0.9.0', sha256: 'b'.repeat(64) })).toThrow(/exactly one/)
    expect(() => repin(TOML + TOML, { version: '0.9.0', sha256: 'b'.repeat(64) })).toThrow(/exactly one/)
  })

  it('classifies stored keys and estimates the monthly cost', () => {
    expect(classifyKey('repos/ada/site/git/objects/pack/pack-1.pack')).toEqual({ repository: 'ada/site', kind: 'git' })
    expect(classifyKey(`repos/ada/site/lfs/objects/ab/cd/ab${'c'.repeat(62)}`)).toEqual({ repository: 'ada/site', kind: 'lfs' })
    expect(classifyKey('repos/ada/site/refs.json')).toBeNull()
    expect(classifyKey('tmp/repos/ada/site/x/1')).toBeNull()
    const at = Date.parse('2026-10-16T00:00:00Z')
    expect(monthFraction(at)).toBeCloseTo(0.5)
    const idle = estimateMonthlyCost(0, {}, at)
    expect(idle.totalUsd).toBe(5)
    const busy = estimateMonthlyCost(110 * 1024 ** 3, { requests: 10_000_000 }, at)
    expect(busy.lines.find((line) => line.item === 'R2 storage')?.usd).toBeCloseTo(1.5)
    expect(busy.lines.find((line) => line.item === 'Workers requests')?.usd).toBeCloseTo(3)
  })

  it('warns about far away storage and lists the steps for presigned LFS', () => {
    const checks = setupChecks({ colo: 'FRA', databaseRegion: 'WNAM', databaseMs: 140, storageMs: 20, presigned: false, maxLfsObjectBytes: 100 * 1024 * 1024, imports: true, jobs: false, actions: false, runners: false, oidc: null, publicUrl: null })
    const by = Object.fromEntries(checks.map((check) => [check.id, check]))
    expect(by.database).toMatchObject({ status: 'warn', detail: '140 ms per query (Worker in FRA, database in WNAM).' })
    expect(by.storage?.status).toBe('ok')
    expect(by['presigned-lfs']?.steps).toHaveLength(3)
    expect(by.queues).toMatchObject({ status: 'warn', detail: 'imports present, jobs missing.' })
  })
})

describe('admin operations', () => {
  let forge: NodeForge
  let ada: string
  let bob: string
  const queued: AppJob[] = []
  const commits: { content: string; sha: string }[] = []
  let latest = '0.9.0'

  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.href === 'https://github.com/levino/git-forge/releases/latest') return new Response(null, { status: 302, headers: { Location: `https://github.com/levino/git-forge/releases/tag/v${latest}` } })
    if (url.pathname.endsWith('/SHA256SUMS')) return new Response(SUMS)
    if (url.href === 'https://api.github.com/repos/ada/instance/contents/wrangler.toml') {
      if (request.headers.get('Authorization') !== 'Bearer ghp_good') return new Response('{"message":"Bad credentials"}', { status: 401 })
      if (request.method === 'PUT') {
        const body = (await request.json()) as { content: string; sha: string }
        commits.push({ content: Buffer.from(body.content, 'base64').toString('utf8'), sha: body.sha })
        return Response.json({ commit: { html_url: 'https://github.com/ada/instance/commit/1' } })
      }
      if (request.headers.get('Accept') === 'application/vnd.github.raw+json') return new Response(TOML)
      return Response.json({ content: Buffer.from(TOML).toString('base64'), sha: 'blob-1' })
    }
    if (url.href === 'https://id.example/.well-known/openid-configuration') {
      return Response.json({ issuer: 'https://id.example', authorization_endpoint: 'https://id.example/auth', token_endpoint: 'https://id.example/token', jwks_uri: 'https://id.example/jwks' })
    }
    return new Response('not found', { status: 404 })
  }

  beforeAll(async () => {
    forge = await nodeForge({ fetch, version: '0.8.3', jobs: { enqueue: async (job) => void queued.push(job) } })
    expect(await forge.services.instance.claimable()).toBe(true)
    ada = await bootstrap(forge, BASE, 'ada')
    expect(await forge.services.instance.claimable()).toBe(false)
    expect((await call(forge, BASE, 'POST', '/api/admin/users', ada, { login: 'bob' })).status).toBe(201)
    bob = (await json<{ token: string }>(await call(forge, BASE, 'POST', '/api/admin/users/bob/tokens', ada, { scopes: ['repo:admin'] }))).token
  })

  it('claims only once and only with the bootstrap token', async () => {
    const claim = (token: string) => forge.fetch(new Request(`${BASE}/api/bootstrap`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ login: 'eve' }) }))
    expect((await claim('wrong')).status).toBe(401)
    expect((await claim(BOOTSTRAP_TOKEN)).status).toBe(409)
  })

  it('reports a newer release and commits the pin to the connected repository', async () => {
    expect((await call(forge, BASE, 'GET', '/api/admin/update', bob)).status).toBe(403)
    const view = await json<{ running: string; newer: boolean; pin: string }>(await call(forge, BASE, 'GET', '/api/admin/update', ada))
    const sha256 = await sha256Hex(SUMS)
    expect(view).toMatchObject({ running: '0.8.3', newer: true, pin: `V=0.9.0 S=${sha256}` })
    expect((await call(forge, BASE, 'POST', '/api/admin/update', ada)).status).toBe(409)
    expect((await call(forge, BASE, 'PUT', '/api/admin/update/repository', ada, { repository: 'ada/instance', token: 'ghp_bad' })).status).toBe(422)
    expect(await json(await call(forge, BASE, 'PUT', '/api/admin/update/repository', ada, { repository: 'https://github.com/ada/instance', token: 'ghp_good' }))).toEqual({ repository: 'ada/instance' })
    const stored = await forge.db.all<{ value: string }>(sql("SELECT value FROM instance_settings WHERE name = 'update:token'"))
    expect(stored[0]?.value).not.toContain('ghp_good')
    expect(await json(await call(forge, BASE, 'POST', '/api/admin/update', ada))).toEqual({ version: '0.9.0', commitUrl: 'https://github.com/ada/instance/commit/1' })
    expect(commits).toEqual([{ content: TOML.replace(`V=0.8.3 S=${'a'.repeat(64)}`, `V=0.9.0 S=${sha256}`), sha: 'blob-1' }])
    latest = '0.8.3'
    expect((await call(forge, BASE, 'POST', '/api/admin/update', ada)).status).toBe(409)
  })

  it('stores OIDC settings encrypted and uses them for sign-in, unless vars are set', async () => {
    expect((await call(forge, BASE, 'PUT', '/api/admin/oidc', ada, { issuer: 'https://nowhere.example', clientId: 'forge' })).status).toBe(422)
    const saved = await json<{ source: string; hasSecret: boolean }>(await call(forge, BASE, 'PUT', '/api/admin/oidc', ada, { issuer: 'https://id.example', clientId: 'forge', clientSecret: 'top-secret', name: 'Example ID' }))
    expect(saved).toMatchObject({ source: 'settings', hasSecret: true })
    const rows = await forge.db.all<{ value: string }>(sql('SELECT value FROM instance_settings'))
    expect(rows.map((row) => row.value).join()).not.toContain('top-secret')
    expect(await forge.services.loginMethods()).toEqual({ oidcName: 'Example ID', passkeys: true })
    const login = await forge.fetch(new Request(`${BASE}/login/oidc`))
    expect(login.status).toBe(303)
    expect(login.headers.get('Location')).toMatch(/^https:\/\/id\.example\/auth\?/)
    expect((await call(forge, BASE, 'DELETE', '/api/admin/oidc', ada)).status).toBe(204)
    expect(await forge.services.loginMethods()).toEqual({ oidcName: null, passkeys: true })
    const pinned = await nodeForge({ fetch, login: { oidc: { issuer: 'https://vars.example', clientId: 'v', scopes: ['openid'], name: 'Vars' }, selfSignup: false, breakGlassKey: undefined } })
    const owner = await bootstrap(pinned, BASE, 'owner')
    expect((await call(pinned, BASE, 'PUT', '/api/admin/oidc', owner, { issuer: 'https://id.example', clientId: 'forge' })).status).toBe(409)
  })

  it('records failed jobs and queues them again on retry', async () => {
    const job: AppJob = { kind: 'mirror-sync', repository: 'ada/site', remote: 'origin', reason: 'schedule' }
    await expect(forge.runJob(job, 2)).rejects.toThrow(/jobs need/)
    await expect(forge.runJob(job, 8)).rejects.toThrow(/jobs need/)
    const overview = await json<{ failures: { id: string; kind: string; label: string; attempts: number; final: boolean }[] }>(await call(forge, BASE, 'GET', '/api/admin/overview', ada))
    expect(overview.failures).toEqual([expect.objectContaining({ kind: 'mirror-sync', label: 'ada/site', attempts: 8, final: true })])
    expect((await call(forge, BASE, 'POST', `/api/admin/jobs/${overview.failures[0]!.id}/retry`, bob)).status).toBe(403)
    expect((await call(forge, BASE, 'POST', `/api/admin/jobs/${overview.failures[0]!.id}/retry`, ada)).status).toBe(202)
    expect(queued.at(-1)).toEqual(job)
    expect((await call(forge, BASE, 'POST', `/api/admin/jobs/${overview.failures[0]!.id}/retry`, ada)).status).toBe(404)
  })

  it('counts stored bytes per repository incrementally and recounts on demand', async () => {
    expect((await call(forge, BASE, 'POST', '/api/repos', ada, { owner: 'ada', name: 'site' })).status).toBe(201)
    const content = new TextEncoder().encode('hello lfs\n')
    const oid = await sha256Hex(content)
    const put = await forge.fetch(new Request(`${BASE}/ada/site.git/info/lfs/objects/${oid}`, { method: 'PUT', headers: { Authorization: `Bearer ${ada}`, 'Content-Length': String(content.length) }, body: content }))
    expect(put.status).toBe(200)
    const usage = async () => (await json<{ usage: { repository: string; lfsBytes: number; objects: number }[] }>(await call(forge, BASE, 'GET', '/api/admin/overview', ada))).usage
    expect(await usage()).toEqual([expect.objectContaining({ repository: 'ada/site', lfsBytes: content.length, objects: 1 })])
    await forge.db.run(sql('DELETE FROM storage_objects'))
    await forge.db.run(sql('DELETE FROM repository_usage'))
    expect(await json(await call(forge, BASE, 'POST', '/api/admin/usage/recount', ada))).toEqual({ repositories: 1 })
    for (const job of queued.splice(0).filter((entry) => entry.kind === 'usage-scan')) await forge.runJob(job)
    expect(await usage()).toEqual([expect.objectContaining({ repository: 'ada/site', lfsBytes: content.length, objects: 1 })])
    expect((await call(forge, BASE, 'PATCH', '/api/repos/ada/site', ada, { name: 'web' })).status).toBe(200)
    const more = new TextEncoder().encode('more\n')
    const renamed = await forge.fetch(new Request(`${BASE}/ada/web.git/info/lfs/objects/${await sha256Hex(more)}`, { method: 'PUT', headers: { Authorization: `Bearer ${ada}`, 'Content-Length': String(more.length) }, body: more }))
    expect(renamed.status).toBe(200)
    expect(await usage()).toEqual([expect.objectContaining({ repository: 'ada/web', path: 'ada/site', lfsBytes: content.length + more.length, objects: 2 })])
  })

  it('runs the setup checks for admins only', async () => {
    expect((await call(forge, BASE, 'GET', '/api/admin/setup', bob)).status).toBe(403)
    const setup = await json<{ checks: { id: string; status: string }[]; canSeal: boolean }>(await call(forge, BASE, 'GET', '/api/admin/setup', ada))
    expect(setup.canSeal).toBe(true)
    expect(setup.checks.map((check) => check.id)).toEqual(['public-url', 'oidc', 'database', 'storage', 'presigned-lfs', 'queues', 'actions'])
    expect(setup.checks.find((check) => check.id === 'queues')?.status).toBe('warn')
  })
})
