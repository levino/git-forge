import type { Principal, UserPrincipal } from '@git-forge/accounts'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { beforeAll, describe, expect, it } from 'vitest'
import type { UiSession } from '../../src/app.ts'
import Admin from '../../src/pages/-/admin.astro'
import { bootstrap, call, type NodeForge, nodeForge } from '../support/node-forge.ts'

const BASE = 'https://forge.example'

let forge: NodeForge
let container: AstroContainer
let ada: UserPrincipal
let bob: UserPrincipal

const principalFor = async (token: string) => (await forge.services.authenticate(new Request(BASE, { headers: { Authorization: `Bearer ${token}` } }))) as UserPrincipal

const render = async (principal: Principal, form?: Record<string, string>) => {
  const session: UiSession | null = principal.kind === 'user' ? { principal, csrf: 'csrf-token', sessionId: 'session-1' } : null
  const response = await container.renderToResponse(Admin, {
    request: form
      ? new Request(`${BASE}/-/admin`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: 'csrf-token', ...form }) })
      : new Request(`${BASE}/-/admin`),
    locals: { forge: { ...forge.services, verifySessionWrite: async () => session }, principal, session },
    partial: false,
  })
  return { status: response.status, location: response.headers.get('Location'), html: await response.text() }
}

beforeAll(async () => {
  forge = await nodeForge()
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

  it('shows the backup panel', async () => {
    const page = await render(ada)
    expect(page.html).toContain('No backup target.')
    expect((await render(ada, { action: 'backup-run' })).html).toContain('no backup target is configured')
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
