import type { UserPrincipal } from '@git-forge/accounts'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { beforeAll, describe, expect, it } from 'vitest'
import type { UiSession } from '../../src/app.ts'
import AppPage from '../../src/pages/apps/[slug].astro'
import Install from '../../src/pages/apps/[slug]/installations/new.astro'
import NewApp from '../../src/pages/settings/apps/new.astro'
import AppSettings from '../../src/pages/settings/apps/[slug].astro'
import Apps from '../../src/pages/settings/apps/index.astro'
import Installation from '../../src/pages/settings/installations/[id].astro'
import { bootstrap, call, type NodeForge, nodeForge } from '../support/node-forge.ts'

const BASE = 'https://forge.example'

let forge: NodeForge
let container: AstroContainer
let alice: UserPrincipal
let bob: UserPrincipal

const principalFor = async (token: string) => (await forge.services.authenticate(new Request(BASE, { headers: { Authorization: `Bearer ${token}` } }))) as UserPrincipal

const render = async (component: Parameters<AstroContainer['renderToResponse']>[0], path: string, principal: UserPrincipal | null, params: Record<string, string> = {}, form?: Record<string, string | string[]>) => {
  const session: UiSession | null = principal ? { principal, csrf: 'csrf-token', sessionId: 'session-1' } : null
  const body = new URLSearchParams()
  for (const [name, value] of Object.entries(form ?? {})) for (const entry of [value].flat()) body.append(name, entry)
  const response = await container.renderToResponse(component, {
    request: form ? new Request(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }) : new Request(`${BASE}${path}`),
    params,
    locals: { forge: { ...forge.services, verifySessionWrite: async () => session }, principal: principal ?? { kind: 'anonymous' }, session },
    partial: false,
  })
  return { status: response.status, location: response.headers.get('Location'), html: await response.text() }
}

beforeAll(async () => {
  forge = await nodeForge()
  const token = await bootstrap(forge, BASE, 'alice')
  alice = await principalFor(token)
  expect((await call(forge, BASE, 'POST', '/api/admin/users', token, { login: 'bob' })).status).toBe(201)
  bob = await principalFor(((await (await call(forge, BASE, 'POST', '/api/admin/users/bob/tokens', token, { scopes: ['repo:admin'] })).json()) as { token: string }).token)
  expect((await call(forge, BASE, 'POST', '/api/repos', token, { owner: 'alice', name: 'site' })).status).toBe(201)
  container = await AstroContainer.create()
})

describe('GitHub App pages', () => {
  it('registers, configures, installs and uninstalls an app', async () => {
    const created = await render(NewApp, '/settings/apps/new', alice, {}, { csrf: 'csrf-token', action: 'create', owner: 'alice', name: 'Deploy Bot', 'permission:contents': 'write', events: ['push', 'issues'], webhook_url: 'https://hooks.example.com/x', webhook_active: 'on' })
    expect(created.location).toBe('/settings/apps/deploy-bot')
    expect((await render(Apps, '/settings/apps', alice)).html).toContain('Deploy Bot')
    const settings = await render(AppSettings, '/settings/apps/deploy-bot', alice, { slug: 'deploy-bot' }, { csrf: 'csrf-token', action: 'generate-key' })
    expect(settings.html).toContain('BEGIN PRIVATE KEY')
    expect((await render(AppSettings, '/settings/apps/deploy-bot', bob, { slug: 'deploy-bot' })).status).toBe(404)
    expect((await render(AppPage, '/apps/deploy-bot', bob, { slug: 'deploy-bot' })).status).toBe(404)
    const page = await render(AppPage, '/apps/deploy-bot', alice, { slug: 'deploy-bot' })
    expect(page.html).toContain('read and write')
    expect((await render(Install, '/apps/deploy-bot/installations/new', alice, { slug: 'deploy-bot' })).html).toContain('site')
    const installed = await render(Install, '/apps/deploy-bot/installations/new', alice, { slug: 'deploy-bot' }, { csrf: 'csrf-token', action: 'install', account: 'alice', selection: 'all' })
    const id = /\/settings\/installations\/(\d+)$/.exec(installed.location ?? '')![1]!
    expect((await render(Installation, `/settings/installations/${id}`, alice, { id })).html).toContain('deploy-bot on alice')
    await render(AppSettings, '/settings/apps/deploy-bot', alice, { slug: 'deploy-bot' }, { csrf: 'csrf-token', action: 'update', name: 'Deploy Bot', 'permission:contents': 'write', 'permission:issues': 'read', webhook_active: 'on' })
    expect((await render(Installation, `/settings/installations/${id}`, alice, { id })).html).toContain('Review and accept')
    expect((await render(Installation, `/settings/installations/${id}`, alice, { id }, { csrf: 'csrf-token', action: 'accept' })).html).toContain('New permissions accepted.')
    expect((await render(Installation, `/settings/installations/${id}`, alice, { id }, { csrf: 'csrf-token', action: 'uninstall' })).location).toBe('/settings/apps')
  })

  it('confirms a manifest before creating the app and redirects with a code', async () => {
    const manifest = JSON.stringify({ name: 'Manifested', redirect_url: 'https://tool.example/callback' })
    const anonymous = await render(NewApp, '/settings/apps/new?state=xyz', null, {}, { manifest })
    expect(anonymous.html).toContain('Continue')
    const confirm = await render(NewApp, '/settings/apps/new?state=xyz', alice, {}, { manifest })
    expect(confirm.html).toContain('Create GitHub App for')
    const done = await render(NewApp, '/settings/apps/new', alice, {}, { csrf: 'csrf-token', action: 'manifest', owner: 'alice', manifest, state: 'xyz' })
    expect(done.location).toMatch(/^https:\/\/tool\.example\/callback\?code=[\w-]+&state=xyz$/)
  })
})
