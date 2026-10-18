import { MemoryStorage, readRefs } from '@git-forge/core'
import { describe, expect, it } from 'vitest'
import { type ForgeConfig, handleRequest, presentedToken, tokenMatches } from '../../src/app.ts'

const config = (overrides: Partial<ForgeConfig> = {}): ForgeConfig => ({
  storage: new MemoryStorage(),
  adminToken: 'secret',
  publicRead: true,
  maxPushBytes: 1024 * 1024,
  ...overrides,
})

const createRepo = (forge: ForgeConfig, body: unknown, token = 'secret') =>
  handleRequest(
    new Request('https://forge.example/api/admin/repos', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    forge,
  )

const basic = (password: string) => `Basic ${btoa(`git:${password}`)}`

describe('tokens', () => {
  it('compares tokens without accepting missing or different values', async () => {
    expect(await tokenMatches('secret', 'secret')).toBe(true)
    expect(await tokenMatches('secret', 'secreT')).toBe(false)
    expect(await tokenMatches('', undefined)).toBe(false)
    expect(await tokenMatches('', '')).toBe(false)
  })

  it('reads bearer and basic credentials', () => {
    const request = (authorization: string) => new Request('https://x/', { headers: { Authorization: authorization } })
    expect(presentedToken(request('Bearer abc'))).toBe('abc')
    expect(presentedToken(request(basic('p:w')))).toBe('p:w')
    expect(presentedToken(request('Basic !!!'))).toBeNull()
    expect(presentedToken(request('Digest abc'))).toBeNull()
    expect(presentedToken(new Request('https://x/'))).toBeNull()
  })
})

describe('admin endpoint', () => {
  it('creates a repository with the requested default branch', async () => {
    const forge = config()
    const response = await createRepo(forge, { owner: 'acme', name: 'site', defaultBranch: 'trunk' })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ owner: 'acme', name: 'site', defaultBranch: 'trunk', cloneUrl: 'https://forge.example/acme/site.git' })
    expect((await readRefs(forge.storage, { owner: 'acme', name: 'site' }))?.state).toEqual({ head: 'refs/heads/trunk', refs: {} })
  })

  it('rejects bad tokens, bad input and duplicates', async () => {
    const forge = config()
    expect((await createRepo(forge, { owner: 'acme', name: 'site' }, 'nope')).status).toBe(401)
    expect((await createRepo(forge, 'not json')).status).toBe(400)
    expect((await createRepo(forge, { owner: 'acme', name: '../x' })).status).toBe(400)
    expect((await createRepo(forge, { owner: 'acme', name: 'x', defaultBranch: 'a..b' })).status).toBe(400)
    expect((await createRepo(forge, { owner: 'acme', name: 'site' })).status).toBe(201)
    expect((await createRepo(forge, { owner: 'acme', name: 'site' })).status).toBe(409)
    expect((await handleRequest(new Request('https://forge.example/api/admin/repos'), forge)).status).toBe(405)
  })

  it('is disabled without a configured token', async () => {
    const forge = config({ adminToken: undefined })
    expect((await createRepo(forge, { owner: 'acme', name: 'site' }, '')).status).toBe(503)
  })
})

describe('git routes', () => {
  const advertise = (forge: ForgeConfig, service: string, authorization?: string) =>
    handleRequest(
      new Request(`https://forge.example/acme/site.git/info/refs?service=${service}`, {
        headers: { 'Git-Protocol': 'version=2', ...(authorization ? { Authorization: authorization } : {}) },
      }),
      forge,
    )

  it('allows public reads and requires the token for pushes', async () => {
    const forge = config()
    await createRepo(forge, { owner: 'acme', name: 'site' })
    expect((await advertise(forge, 'git-upload-pack')).status).toBe(200)
    const denied = await advertise(forge, 'git-receive-pack')
    expect(denied.status).toBe(401)
    expect(denied.headers.get('WWW-Authenticate')).toContain('Basic')
    expect((await advertise(forge, 'git-receive-pack', basic('wrong'))).status).toBe(401)
    expect((await advertise(forge, 'git-receive-pack', basic('secret'))).status).toBe(200)
  })

  it('requires the token for reads when public reads are off', async () => {
    const forge = config({ publicRead: false })
    await createRepo(forge, { owner: 'acme', name: 'site' })
    expect((await advertise(forge, 'git-upload-pack')).status).toBe(401)
    expect((await advertise(forge, 'git-upload-pack', basic('secret'))).status).toBe(200)
  })

  it('answers health checks and unknown paths', async () => {
    const forge = config()
    expect((await handleRequest(new Request('https://forge.example/api/health'), forge)).status).toBe(200)
    expect((await handleRequest(new Request('https://forge.example/acme/site/blob/main'), forge)).status).toBe(404)
  })
})
