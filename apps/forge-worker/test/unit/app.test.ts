import { type ImportJob, MemoryStorage, readImportState, readRefs } from '@git-forge/core'
import { describe, expect, it } from 'vitest'
import { basicAuthorization, type ForgeConfig, handleRequest, presentedToken, tokenMatches } from '../../src/app.ts'

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

  it('lets the read token read but not push', async () => {
    const forge = config({ publicRead: false, readToken: 'reader' })
    await createRepo(forge, { owner: 'acme', name: 'site' })
    expect((await advertise(forge, 'git-upload-pack', basic('reader'))).status).toBe(200)
    expect((await advertise(forge, 'git-receive-pack', basic('reader'))).status).toBe(401)
    expect((await advertise(forge, 'git-upload-pack', basic('wrong'))).status).toBe(401)
  })

  it('routes media and raw URLs through the same authorization', async () => {
    const forge = config({ publicRead: false, readToken: 'reader' })
    await createRepo(forge, { owner: 'acme', name: 'site' })
    const media = (authorization?: string) =>
      handleRequest(
        new Request(`https://forge.example/acme/site/media/${'0'.repeat(64)}`, authorization ? { headers: { Authorization: authorization } } : {}),
        forge,
      )
    expect((await media()).status).toBe(401)
    const missing = await media('Bearer reader')
    expect(missing.status).toBe(404)
    expect(await missing.text()).toBe('object does not exist\n')
    const raw = await handleRequest(new Request('https://forge.example/acme/site/raw/main/README.md', { headers: { Authorization: 'Bearer reader' } }), forge)
    expect(raw.status).toBe(404)
    expect(await raw.text()).toBe('unknown ref\n')
  })

  it('answers health checks and unknown paths', async () => {
    const forge = config()
    expect((await handleRequest(new Request('https://forge.example/api/health'), forge)).status).toBe(200)
    expect((await handleRequest(new Request('https://forge.example/acme/site/blob/main'), forge)).status).toBe(404)
  })
})

describe('import endpoint', () => {
  const importRequest = (forge: ForgeConfig, body: unknown, { token = 'secret', method = 'POST', path = '/api/admin/repos/acme/site/import' } = {}) =>
    handleRequest(
      new Request(`https://forge.example${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}` },
        ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
      }),
      forge,
    )

  const withQueue = () => {
    const jobs: { job: ImportJob; delay: number }[] = []
    const forge = config({ scheduleImport: async (job, delay) => void jobs.push({ job, delay }) })
    return { forge, jobs }
  }

  it('starts an import, creates the repository and schedules the first step with the credentials', async () => {
    const { forge, jobs } = withQueue()
    const response = await importRequest(forge, { url: 'https://github.com/acme/site.git', token: 'ghp_x', commitsPerStep: 50, defaultBranch: 'trunk' })
    expect(response.status).toBe(202)
    expect(response.headers.get('Location')).toBe('https://forge.example/api/admin/repos/acme/site/import')
    expect(await response.json()).toMatchObject({ phase: 'discover', url: 'https://github.com/acme/site.git', commitsPerStep: 50, cloneUrl: 'https://forge.example/acme/site.git' })
    expect(jobs).toEqual([{ job: { owner: 'acme', name: 'site', authorization: basicAuthorization('git', 'ghp_x') }, delay: 0 }])
    expect((await readRefs(forge.storage, { owner: 'acme', name: 'site' }))?.state.head).toBe('refs/heads/trunk')
    expect(JSON.stringify(await readImportState(forge.storage, { owner: 'acme', name: 'site' }))).not.toContain('ghp_x')
    const status = await importRequest(forge, null, { method: 'GET' })
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({ phase: 'discover' })
    expect((await importRequest(forge, { url: 'https://github.com/acme/site.git' })).status).toBe(409)
  })

  it('validates the request', async () => {
    const { forge, jobs } = withQueue()
    expect((await importRequest(forge, { url: 'https://x/y.git' }, { token: 'nope' })).status).toBe(401)
    expect((await importRequest(forge, 'nope')).status).toBe(400)
    expect((await importRequest(forge, { url: 'ftp://x/y.git' })).status).toBe(400)
    expect((await importRequest(forge, { url: 'https://user:pw@x/y.git' })).status).toBe(400)
    expect((await importRequest(forge, { url: 'https://x/y.git', commitsPerStep: -1 })).status).toBe(400)
    expect((await importRequest(forge, { url: 'https://x/y.git', token: 5 })).status).toBe(400)
    expect((await importRequest(forge, { url: 'https://x/y.git' }, { path: '/api/admin/repos/acme/x.git/import' })).status).toBe(400)
    expect((await importRequest(forge, null, { method: 'GET' })).status).toBe(404)
    expect((await importRequest(forge, null, { method: 'DELETE' })).status).toBe(405)
    expect(jobs).toEqual([])
  })

  it('needs a queue', async () => {
    expect((await importRequest(config(), { url: 'https://x/y.git' })).status).toBe(503)
  })

  it('encodes non-ASCII credentials as UTF-8', () => {
    expect(basicAuthorization('git', 'pässword')).toBe(`Basic ${Buffer.from('git:pässword').toString('base64')}`)
  })
})
