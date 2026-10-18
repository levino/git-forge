import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git, gitFails, tempDir } from './history.ts'
import { startWranglerDev, type WranglerDev } from './wrangler-dev.ts'

const BOOTSTRAP_TOKEN = `e2e-${crypto.randomUUID()}`

let dev: WranglerDev
let owner: string
let writer: string
let work: string

type Json = Record<string, any>

const call = async (method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; body: Json }> => {
  const response = await fetch(`${dev.url}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `token ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as Json) }
}

const remote = (token: string) => `${dev.url.replace('http://', `http://git:${token}@`)}/owner/guarded.git`

const commit = async (file: string) => {
  writeFileSync(join(work, file), `${file}\n`)
  await git(work, ['add', '-A'])
  await git(work, ['commit', '-q', '-m', file])
}

const remoteHeads = async () => (await git(work, ['ls-remote', '--heads', remote(owner)])).trim()

const rule = (overrides: Json = {}) => ({ required_status_checks: null, enforce_admins: null, required_pull_request_reviews: null, restrictions: null, ...overrides })

beforeAll(async () => {
  dev = await startWranglerDev({ vars: { BOOTSTRAP_TOKEN } })
  const bootstrapped = await fetch(`${dev.url}/api/bootstrap`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${BOOTSTRAP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'owner' }),
  })
  owner = ((await bootstrapped.json()) as { token: string }).token
  expect((await call('POST', '/api/admin/users', owner, { login: 'writer' })).status).toBe(201)
  writer = (await call('POST', '/api/admin/users/writer/tokens', owner, { scopes: ['repo:write'] })).body.token
  expect((await call('POST', '/api/repos', owner, { owner: 'owner', name: 'guarded' })).status).toBe(201)
  expect((await call('PUT', '/api/repos/owner/guarded/collaborators/writer', owner, { role: 'write' })).status).toBe(200)
  work = tempDir()
  await git(work, ['init', '-q', '-b', 'main'])
  await commit('one.txt')
  await commit('two.txt')
  await git(work, ['push', '-q', remote(writer), 'main', 'main:release/1'])
}, 120_000)

afterAll(async () => {
  await dev?.stop()
})

describe('branch protection on wrangler dev with real git', () => {
  it('serves the protection API from D1 to repository admins only', async () => {
    const path = '/api/repos/owner/guarded/branches/main/protection'
    expect((await call('PUT', path, null, rule())).status).toBe(401)
    expect((await call('PUT', path, writer, rule())).status).toBe(403)
    expect((await call('GET', path, owner)).status).toBe(404)
    const stored = await call('PUT', path, owner, rule())
    expect(stored.status).toBe(200)
    expect(stored.body).toMatchObject({ pattern: 'main', allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false }, enforce_admins: { enabled: false } })
    expect((await call('PUT', '/api/repos/owner/guarded/branches/release%2F*/protection', owner, rule({ allow_force_pushes: true }))).status).toBe(200)
    expect((await call('GET', '/api/repos/owner/guarded/branch-protection', owner)).body.map((entry: Json) => entry.pattern)).toEqual(['main', 'release/*'])
  })

  it('rejects a force push and a deletion of a protected branch', async () => {
    const before = await remoteHeads()
    await git(work, ['commit', '-q', '--amend', '-m', 'rewritten'])
    expect(await gitFails(work, ['push', '--force', remote(writer), 'main'])).toContain('! [remote rejected] main -> main (protected branch: force push is not allowed)')
    expect(await gitFails(work, ['push', remote(writer), ':main'])).toContain('! [remote rejected] main (protected branch: deletion is not allowed)')
    expect(await gitFails(work, ['push', '--atomic', '--force', remote(writer), 'main', 'main:release/1'])).toContain('protected branch: force push is not allowed')
    expect(await remoteHeads()).toBe(before)
  })

  it('applies only the matching rule and keeps fast-forwards working', async () => {
    await git(work, ['push', '-q', '--force', remote(writer), 'main:release/1'])
    expect(await gitFails(work, ['push', remote(writer), ':release/1'])).toContain('(protected branch: deletion is not allowed)')
    await git(work, ['fetch', '-q', remote(writer), 'main'])
    await git(work, ['reset', '-q', '--hard', 'FETCH_HEAD'])
    await commit('three.txt')
    await git(work, ['push', '-q', remote(writer), 'main'])
    expect(await remoteHeads()).toContain(`${(await git(work, ['rev-parse', 'main'])).trim()}\trefs/heads/main`)
  })

  it('lets the repository admin bypass the rule until enforce_admins is set', async () => {
    await git(work, ['commit', '-q', '--amend', '-m', 'admin rewrite'])
    await git(work, ['push', '-q', '--force', remote(owner), 'main'])
    expect((await call('PUT', '/api/repos/owner/guarded/branches/main/protection', owner, rule({ enforce_admins: true }))).status).toBe(200)
    await git(work, ['commit', '-q', '--amend', '-m', 'second admin rewrite'])
    expect(await gitFails(work, ['push', '--force', remote(owner), 'main'])).toContain('(protected branch: force push is not allowed)')
    expect((await call('DELETE', '/api/repos/owner/guarded/branches/main/protection', owner)).status).toBe(204)
    await git(work, ['push', '-q', '--force', remote(writer), 'main'])
  })
})
