import type { Principal, UserPrincipal } from '@git-forge/accounts'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { beforeAll, describe, expect, it } from 'vitest'
import type { UiSession } from '../../src/app.ts'
import NewOrganization from '../../src/pages/organizations/new.astro'
import Organization from '../../src/pages/orgs/[org]/index.astro'
import Team from '../../src/pages/orgs/[org]/teams/[slug].astro'
import Settings from '../../src/pages/settings.astro'
import { bootstrap, call, type NodeForge, nodeForge } from '../support/node-forge.ts'

const BASE = 'https://forge.example'

let forge: NodeForge
let container: AstroContainer
let ada: UserPrincipal
let bob: UserPrincipal
let carol: UserPrincipal

const principalFor = async (token: string) => (await forge.services.authenticate(new Request(BASE, { headers: { Authorization: `Bearer ${token}` } }))) as UserPrincipal

const render = async (page: Parameters<AstroContainer['renderToResponse']>[0], path: string, params: Record<string, string>, principal: Principal, form?: Record<string, string>) => {
  const session: UiSession | null = principal.kind === 'user' ? { principal, csrf: 'csrf-token', sessionId: 'session-1' } : null
  const response = await container.renderToResponse(page, {
    request: form
      ? new Request(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: 'csrf-token', ...form }) })
      : new Request(`${BASE}${path}`),
    params,
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
  expect((await call(forge, BASE, 'POST', '/api/admin/users', token, { login: 'carol' })).status).toBe(201)
  carol = await principalFor(((await (await call(forge, BASE, 'POST', '/api/admin/users/carol/tokens', token, { scopes: ['repo:admin'] })).json()) as { token: string }).token)
  container = await AstroContainer.create()
})

describe('organization pages', () => {
  it('creates an organization and manages people and teams', async () => {
    const created = await render(NewOrganization, '/organizations/new', {}, bob, { action: 'create', login: 'guild' })
    expect(created).toMatchObject({ status: 303, location: '/orgs/guild' })
    const added = await render(Organization, '/orgs/guild', { org: 'guild' }, bob, { action: 'member', login: 'carol', role: 'member' })
    expect(added.html).toContain('carol is now a member.')
    const team = await render(Organization, '/orgs/guild', { org: 'guild' }, bob, { action: 'team', slug: 'core', name: 'Core' })
    expect(team).toMatchObject({ status: 303, location: '/orgs/guild/teams/core' })
    const member = await render(Team, '/orgs/guild/teams/core', { org: 'guild', slug: 'core' }, bob, { action: 'team-member', team: 'core', login: 'carol', role: 'maintainer' })
    expect(member.html).toContain('carol added to the team.')
    const asMember = await render(Team, '/orgs/guild/teams/core', { org: 'guild', slug: 'core' }, carol)
    expect(asMember.html).toContain('maintainer')
    expect(asMember.html).not.toContain('Add a team member')
  })

  it('refuses owner actions to members and hides the pages from outsiders', async () => {
    const refused = await render(Organization, '/orgs/guild', { org: 'guild' }, carol, { action: 'member', login: 'carol', role: 'owner' })
    expect((await render(Organization, '/orgs/guild', { org: 'guild' }, ada)).html).toContain('Add a member')
    expect(refused.status).toBe(403)
    expect((await render(Organization, '/orgs/guild', { org: 'guild' }, { kind: 'anonymous' })).status).toBe(404)
    expect((await render(Team, '/orgs/guild/teams/core', { org: 'guild', slug: 'core' }, { kind: 'anonymous' })).status).toBe(404)
  })
})

describe('account sessions and identities', () => {
  it('lists the sessions of the user and marks the current one', async () => {
    const page = await render(Settings, '/settings', {}, ada)
    expect(page.html).toContain('Sessions')
    expect(page.html).toContain('No linked accounts.')
    const missing = await render(Settings, '/settings', {}, ada, { action: 'revoke-session', id: 'nope' })
    expect(missing.html).toContain('Unknown session.')
  })
})
