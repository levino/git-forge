import type { UserPrincipal } from '@git-forge/accounts'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { beforeAll, describe, expect, it } from 'vitest'
import type { UiSession } from '../../src/app.ts'
import Settings from '../../src/pages/[owner]/[repo]/settings.astro'
import { bootstrap, call, type NodeForge, nodeForge } from '../support/node-forge.ts'

const BASE = 'https://forge.example'

let forge: NodeForge
let container: AstroContainer
let owner: UserPrincipal
let other: UserPrincipal
let ownerToken: string

const principalFor = async (token: string) => (await forge.services.authenticate(new Request(BASE, { headers: { Authorization: `Bearer ${token}` } }))) as UserPrincipal

const page = async (principal: UserPrincipal, form?: Record<string, string>) => {
  const session: UiSession = { principal, csrf: 'csrf-token' }
  const response = await container.renderToResponse(Settings, {
    request: form
      ? new Request(`${BASE}/alice/site/settings`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: 'csrf-token', ...form }) })
      : new Request(`${BASE}/alice/site/settings`),
    params: { owner: 'alice', repo: 'site' },
    locals: { forge: { ...forge.services, verifySessionWrite: async () => session }, principal, session },
    partial: false,
  })
  return { status: response.status, html: await response.text() }
}

beforeAll(async () => {
  forge = await nodeForge()
  const token = await bootstrap(forge, BASE, 'alice')
  owner = await principalFor(token)
  ownerToken = token
  expect((await call(forge, BASE, 'POST', '/api/admin/users', token, { login: 'bob' })).status).toBe(201)
  const bobToken = ((await (await call(forge, BASE, 'POST', '/api/admin/users/bob/tokens', token, { scopes: ['repo:admin'] })).json()) as { token: string }).token
  other = await principalFor(bobToken)
  expect((await call(forge, BASE, 'POST', '/api/repos', token, { owner: 'alice', name: 'site' })).status).toBe(201)
  container = await AstroContainer.create()
})

describe('repository settings page', () => {
  it('answers 404 to people who are not admins of the repository', async () => {
    expect((await page(other)).status).toBe(404)
    expect((await page(other, { action: 'visibility', visibility: 'public' })).status).toBe(404)
  })

  it('changes visibility and manages collaborators', async () => {
    expect((await page(owner, { action: 'visibility', visibility: 'public' })).html).toContain('Visibility changed.')
    expect((await forge.services.store.findRepository('alice', 'site'))?.visibility).toBe('public')
    expect((await page(owner, { action: 'collaborator', login: 'bob', role: 'maintain' })).html).toContain('Access for bob saved.')
    expect((await page(owner)).html).toMatch(/<option selected>maintain<\/option>/)
    expect((await page(owner, { action: 'collaborator', login: 'nobody', role: 'read' })).status).toBe(404)
    expect((await page(owner, { action: 'collaborator', login: 'bob', role: 'emperor' })).status).toBe(400)
    expect((await page(owner, { action: 'remove-collaborator', login: 'bob' })).html).toContain('bob removed.')
  })

  it('protects branches through the same parser as the API', async () => {
    const saved = await page(owner, { action: 'protection', pattern: 'main', require_reviews: 'on', approvals: '2', require_checks: 'on', contexts: 'build, test' })
    expect(saved.html).toContain('Protection for main saved.')
    const api = await call(forge, BASE, 'GET', '/api/repos/alice/site/branches/main/protection', ownerToken)
    expect(api.status).toBe(200)
    expect(await api.json()).toMatchObject({ required_pull_request_reviews: { required_approving_review_count: 2 }, required_status_checks: { contexts: ['build', 'test'] } })
    expect((await page(owner, { action: 'protection', pattern: 'main', restrict_pushes: 'on', push_teams: 'core' })).status).toBe(422)
    expect((await page(owner, { action: 'remove-protection', pattern: 'main' })).html).toContain('Protection for main removed.')
  })

  it('configures a mirror and grants only trusted instances', async () => {
    const added = await page(owner, { action: 'add-mirror', url: 'https://upstream.example/acme/site.git', mode: 'manual', auth: 'none', lfs: 'on' })
    expect(added.html).toContain('Mirror configured')
    expect(added.html).toContain('https://upstream.example/acme/site.git')
    expect((await page(owner, { action: 'grant-instance', issuer: 'https://unknown.example' })).status).toBe(422)
  })
})
