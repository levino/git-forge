import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { lfsObjectKey, readAll, readMirrorStatus, readRefs } from '@git-forge/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Instance, quiesce, startInstance } from '../support/federated-instance.ts'
import { git, tempDir } from './history.ts'

const lfsConfig = [
  ['filter.lfs.process', 'git-lfs filter-process'],
  ['filter.lfs.smudge', 'git-lfs smudge -- %f'],
  ['filter.lfs.clean', 'git-lfs clean -- %f'],
  ['filter.lfs.required', 'true'],
  ['lfs.locksverify', 'false'],
].flatMap(([key, value]) => ['-c', `${key}=${value}`])

const lfsGit = (cwd: string, args: readonly string[]) => git(cwd, [...lfsConfig, ...args])

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

const expectStatus = async (response: Promise<Response>, status: number): Promise<Response> => {
  const resolved = await response
  if (resolved.status !== status) throw new Error(`expected ${status}, got ${resolved.status}: ${await resolved.text()}`)
  return resolved
}

type User = { readonly login: string; readonly token: string }

const createUser = async (instance: Instance, login: string): Promise<User> => {
  await expectStatus(instance.api('POST', '/api/admin/users', { login }), 201)
  const created = (await (await expectStatus(instance.api('POST', `/api/admin/users/${login}/tokens`, { scopes: ['repo:admin'] }), 201)).json()) as { token: string }
  return { login, token: created.token }
}

const as = (instance: Instance, user: User, method: string, path: string, body?: unknown) =>
  fetch(`${instance.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

let alpha: Instance
let beta: Instance
let anna: User
let mira: User
let installation: string
let source: string
const scan = new Uint8Array(150_000).map((_, index) => (index * 7919) % 251)
const vault = { owner: 'mira', name: 'vault' }

const pushUrl = () => `${alpha.url}/anna/vault.git`.replace('http://', `http://git:${anna.token}@`)

const consent = async (selection: 'all' | 'selected', repositories: string[]) => {
  const started = (await (await expectStatus(as(beta, mira, 'POST', '/api/federation/connections', { upstream: alpha.url }), 201)).json()) as { authorizeUrl: string }
  const authorize = new URL(started.authorizeUrl)
  expect(authorize.origin + authorize.pathname).toBe(`${alpha.url}/federation/authorize`)
  const params = Object.fromEntries(authorize.searchParams)
  const granted = (await (await expectStatus(as(alpha, anna, 'POST', '/api/federation/authorize', { ...params, account: 'anna', selection, repositories }), 200)).json()) as { redirect: string }
  const callback = new URL(granted.redirect)
  expect(callback.origin + callback.pathname).toBe(`${beta.url}/federation/callback`)
  expect(callback.searchParams.get('state')).toBe(params.state)
  return { code: callback.searchParams.get('code')!, state: params.state! }
}

beforeAll(async () => {
  ;[alpha, beta] = await Promise.all([startInstance('alpha'), startInstance('beta')])
  anna = await createUser(alpha, 'anna')
  mira = await createUser(beta, 'mira')
  await expectStatus(as(alpha, anna, 'POST', '/api/repos', { owner: 'anna', name: 'vault' }), 201)
  await expectStatus(as(alpha, anna, 'POST', '/api/repos', { owner: 'anna', name: 'diary' }), 201)
  await expectStatus(as(beta, mira, 'POST', '/api/repos', { owner: 'mira', name: 'vault' }), 201)
  source = tempDir()
  await git(source, ['init', '-q', '-b', 'main'])
  await lfsGit(source, ['lfs', 'track', '*.bin'])
  writeFileSync(join(source, 'scan.bin'), scan)
  writeFileSync(join(source, 'README.md'), '# Vault\n')
  await lfsGit(source, ['add', '-A'])
  await lfsGit(source, ['commit', '-q', '-m', 'first scan'])
  await lfsGit(source, ['push', '-q', pushUrl(), 'main'])
}, 60_000)

afterAll(async () => {
  await Promise.all([alpha, beta].filter(Boolean).map((instance) => instance.close()))
})

describe('federation installations: beta mirrors a private alpha repository with per-user consent', () => {
  it('refuses redirect URIs outside the client and unknown scopes', async () => {
    const base = { client_id: beta.url, state: 'x'.repeat(32), code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', sub: 'someone', account: 'anna', selection: 'all' }
    await expectStatus(as(alpha, anna, 'POST', '/api/federation/authorize', { ...base, redirect_uri: `${alpha.url}/federation/callback` }), 400)
    await expectStatus(as(alpha, anna, 'POST', '/api/federation/authorize', { ...base, redirect_uri: `${beta.url}/federation/callback`, scope: 'git:write' }), 400)
    await expectStatus(as(alpha, anna, 'POST', '/api/federation/authorize', { ...base, redirect_uri: `${beta.url}/federation/callback`, account: 'village' }), 403)
  })

  it('connects through consent and a single-use code', async () => {
    const { code, state } = await consent('selected', ['vault'])
    const connection = (await (await expectStatus(as(beta, mira, 'POST', '/api/federation/connections/complete', { state, code }), 201)).json()) as { installation: string; upstream: string }
    installation = connection.installation
    expect(connection.upstream).toBe(alpha.url)
    await expectStatus(as(beta, mira, 'POST', '/api/federation/connections/complete', { state, code }), 400)
    const remote = (await (await expectStatus(as(beta, mira, 'GET', `/api/federation/connections/${installation}`), 200)).json()) as { active: boolean; repositories: { name: string }[] }
    expect(remote.active).toBe(true)
    expect(remote.repositories.map((repository) => repository.name)).toEqual(['anna/vault'])
    const listed = (await (await expectStatus(as(alpha, anna, 'GET', '/api/user/federation/installations'), 200)).json()) as { id: string; issuer: string; subject: string }[]
    expect(listed).toEqual([expect.objectContaining({ id: installation, issuer: beta.url, account: 'anna', selection: 'selected' })])
  })

  it('does not let a code be redeemed by another state or user', async () => {
    const { code } = await consent('all', [])
    const other = await consent('all', [])
    await expectStatus(as(beta, mira, 'POST', '/api/federation/connections/complete', { state: other.state, code }), 502)
    const third = await consent('all', [])
    await expectStatus(beta.api('POST', '/api/federation/connections/complete', third), 400)
    await expectStatus(as(beta, mira, 'POST', '/api/federation/connections/complete', third), 201)
  })

  it('lets only the connecting user attach the installation', async () => {
    const url = `${alpha.url}/anna/vault.git`
    await expectStatus(beta.api('POST', '/api/repos', { owner: 'village', name: 'vault' }), 201)
    await expectStatus(beta.api('POST', '/api/repos/village/vault/mirrors', { url, auth: 'installation', installation }), 403)
    await expectStatus(as(beta, mira, 'POST', '/api/repos/mira/vault/mirrors', { url: `${alpha.url}/anna/diary.git`, auth: 'installation', installation }), 201)
    await quiesce([alpha, beta])
    expect((await readMirrorStatus(beta.storage, vault))?.lastRun?.ok).toBe(false)
    await expectStatus(as(beta, mira, 'POST', '/api/repos/mira/vault/mirrors', { url, auth: 'installation', installation, remote: 'alpha' }), 201)
  })

  it('syncs Git and LFS content and follows pushes through the subscription', async () => {
    await quiesce([alpha, beta])
    const tip = (await git(source, ['rev-parse', 'main'])).trim()
    const refs = (await readRefs(beta.storage, vault))?.state.refs ?? {}
    expect(refs['refs/upstream/alpha/heads/main']).toBe(tip)
    const stored = await beta.storage.get(lfsObjectKey(vault, sha256(scan)))
    expect(stored && sha256(await readAll(stored.body))).toBe(sha256(scan))
    const subscriptions = await alpha.store.mirrorSubscriptions('anna/vault')
    expect(subscriptions).toEqual([{ issuer: beta.url, repository: 'anna/vault', callback: `${beta.url}/api/federation/notify/mira/vault/alpha`, installation: { id: installation, subject: expect.any(String) } }])
    writeFileSync(join(source, 'README.md'), '# Vault\n\nsecond\n')
    await lfsGit(source, ['commit', '-q', '-am', 'second'])
    await lfsGit(source, ['push', '-q', pushUrl(), 'main'])
    await quiesce([alpha, beta])
    expect((await readRefs(beta.storage, vault))?.state.refs['refs/upstream/alpha/heads/main']).toBe((await git(source, ['rev-parse', 'main'])).trim())
  })

  it('stops syncing once the installation is revoked', async () => {
    await expectStatus(as(alpha, anna, 'DELETE', `/api/federation/installations/${installation}`), 204)
    writeFileSync(join(source, 'README.md'), '# Vault\n\nthird\n')
    await lfsGit(source, ['commit', '-q', '-am', 'third'])
    await lfsGit(source, ['push', '-q', pushUrl(), 'main'])
    await quiesce([alpha, beta])
    const third = (await git(source, ['rev-parse', 'main'])).trim()
    const before = (await readRefs(beta.storage, vault))?.state.refs['refs/upstream/alpha/heads/main']
    expect(before).not.toBe(third)
    const sync = await as(beta, mira, 'POST', '/api/repos/mira/vault/mirrors/alpha/sync')
    const result = (await sync.json()) as { status?: string }
    expect(result.status).toBe('failed')
    expect((await readRefs(beta.storage, vault))?.state.refs['refs/upstream/alpha/heads/main']).toBe(before)
    const remote = (await (await expectStatus(as(beta, mira, 'GET', `/api/federation/connections/${installation}`), 200)).json()) as { active: boolean }
    expect(remote.active).toBe(false)
    expect(await alpha.store.mirrorSubscriptions('anna/vault')).toEqual([])
  })
})
