import type { Principal, UserPrincipal } from '@git-forge/accounts'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { beforeAll, describe, expect, it } from 'vitest'
import type { UiSession } from '../../src/app.ts'
import Admin from '../../src/pages/-/admin.astro'
import Setup from '../../src/pages/-/setup.astro'
import { BOOTSTRAP_TOKEN, bootstrap, call, type NodeForge, nodeForge } from '../support/node-forge.ts'

const BASE = 'https://forge.example'

let forge: NodeForge
let container: AstroContainer
let ada: UserPrincipal
let bob: UserPrincipal

const principalFor = async (token: string) => (await forge.services.authenticate(new Request(BASE, { headers: { Authorization: `Bearer ${token}` } }))) as UserPrincipal

const releases = async (request: Request): Promise<Response> => {
  if (request.url === 'https://github.com/levino/git-forge/releases/latest') return new Response(null, { status: 302, headers: { Location: 'https://github.com/levino/git-forge/releases/tag/v9.0.0' } })
  if (request.url.endsWith('/v9.0.0/SHA256SUMS')) return new Response('sums\n')
  return new Response('not found', { status: 404 })
}

const render = async (principal: Principal, form?: Record<string, string>, page = Admin, target = forge) => {
  const session: UiSession | null = principal.kind === 'user' ? { principal, csrf: 'csrf-token', sessionId: 'session-1' } : null
  const path = page === Admin ? '/-/admin' : '/-/setup'
  const response = await container.renderToResponse(page, {
    request: form
      ? new Request(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: 'csrf-token', ...form }) })
      : new Request(`${BASE}${path}`),
    locals: { forge: { ...target.services, verifySessionWrite: async () => session }, principal, session },
    partial: false,
  })
  return { status: response.status, location: response.headers.get('Location'), html: await response.text() }
}

beforeAll(async () => {
  forge = await nodeForge({ fetch: releases, version: '1.0.0' })
  const token = await bootstrap(forge, BASE, 'ada')
  ada = await principalFor(token)
  expect((await call(forge, BASE, 'POST', '/api/admin/users', token, { login: 'bob' })).status).toBe(201)
  bob = await principalFor(((await (await call(forge, BASE, 'POST', '/api/admin/users/bob/tokens', token, { scopes: ['repo:admin'] })).json()) as { token: string }).token)
  expect((await call(forge, BASE, 'POST', '/api/repos', token, { owner: 'ada', name: 'copy' })).status).toBe(201)
  expect((await call(forge, BASE, 'POST', '/api/repos/ada/copy/mirrors', token, { url: 'http://127.0.0.1:9/upstream.git', mode: 'manual' })).status).toBe(201)
  container = await AstroContainer.create()
})

describe('instance administration page', () => {
  it('is only for instance admins', async () => {
    expect((await render({ kind: 'anonymous' })).status).toBe(302)
    expect((await render(bob)).status).toBe(404)
    expect((await render(bob, { action: 'add-admin', login: 'bob' })).status).toBe(404)
    const page = await render(ada)
    expect(page.status).toBe(200)
    expect(page.html).toContain('Instance administration')
  })

  it('shows every mirror of the instance with its state', async () => {
    const page = await render(ada)
    expect(page.html).toContain('href="/ada/copy/settings#mirrors"')
    expect(page.html).toContain('http://127.0.0.1:9/upstream.git')
    expect(page.html).toContain('Not synced yet')
  })

  it('manages admins and trusted instances', async () => {
    expect((await render(ada, { action: 'remove-admin', login: 'ada' })).html).toContain('an instance needs at least one admin')
    expect((await render(ada, { action: 'add-admin', login: 'bob' })).html).toContain('bob is now an instance admin.')
    expect((await render(bob)).status).toBe(200)
    const trusted = await render(bob, { action: 'trust', issuer: 'https://mirror.example/', thumbprint: '' })
    expect(trusted.html).toContain('https://mirror.example is now trusted.')
    expect(trusted.html).toContain('Stop trusting https://mirror.example')
    const invalid = await render(bob, { action: 'trust', issuer: 'mirror', thumbprint: '' })
    expect(invalid.status).toBe(422)
    const removed = await render(bob, { action: 'distrust', issuer: 'https://mirror.example' })
    expect(removed.html).toContain('No trusted instances.')
    expect((await render(bob, { action: 'remove-admin', login: 'ada' })).html).toContain('ada is no longer an instance admin.')
    expect((await render(ada)).status).toBe(404)
  })
})

describe('instance operations on the admin page', () => {
  it('shows the running version, the available release and its pin', async () => {
    const page = await render(bob)
    expect(page.html).toContain('Running <strong class="font-mono">1.0.0</strong>')
    expect(page.html).toContain('9.0.0 available')
    expect(page.html).toMatch(/value="V=9\.0\.0 S=[0-9a-f]{64}"/)
    expect(page.html).toContain('aria-label="Connect the instance repository"')
    expect((await render(bob, { action: 'update' })).html).toContain('connect the instance repository first')
  })

  it('lists failed jobs with a retry button and the storage per repository', async () => {
    await expect(forge.runJob({ kind: 'mirror-sync', repository: 'ada/copy', remote: 'origin', reason: 'schedule' }, 1)).rejects.toThrow()
    const page = await render(bob)
    expect(page.html).toContain('aria-label="Failed jobs"')
    expect(page.html).toContain('Retry mirror-sync ada/copy')
    expect(page.html).toContain('retrying')
    expect(page.html).toContain('Monthly cost estimate')
    expect(page.html).toContain('Workers Paid plan')
  })
})

describe('setup wizard', () => {
  it('lets the deployer claim a fresh instance with the bootstrap token and hands out an invite', async () => {
    const fresh = await nodeForge({ fetch: releases })
    const anonymous: Principal = { kind: 'anonymous' }
    const form = await render(anonymous, undefined, Setup, fresh)
    expect(form.status).toBe(200)
    expect(form.html).toContain('Claim the first admin')
    const wrong = await render(anonymous, { token: 'nope', login: 'root' }, Setup, fresh)
    expect(wrong.status).toBe(401)
    expect(wrong.html).toContain('invalid bootstrap token')
    const claimed = await render(anonymous, { token: BOOTSTRAP_TOKEN, login: 'root' }, Setup, fresh)
    expect(claimed.status).toBe(200)
    expect(claimed.html).toMatch(/href="\/login\/invite\/gfi_[A-Za-z0-9_-]+"/)
    expect((await render(anonymous, undefined, Setup, fresh)).status).toBe(302)
  })

  it('shows the OIDC form and the checks to admins only', async () => {
    expect((await render(ada, undefined, Setup)).status).toBe(404)
    const page = await render(bob, undefined, Setup)
    expect(page.status).toBe(200)
    expect(page.html).toContain('https://forge.example/login/oidc/callback')
    expect(page.html).toContain('data-check="presigned-lfs"')
    expect(page.html).toContain('R2_ACCESS_KEY_ID')
    expect((await render(bob, { action: 'save-oidc', issuer: 'https://id.invalid', 'client-id': 'x', 'client-secret': '', name: '' }, Setup)).status).toBe(422)
  })
})
