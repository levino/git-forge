import { describe, expect, it } from 'vitest'
import {
  applyMigrations,
  createAccountsStore,
  createOrganizationOperations,
  createScimHandler,
  groupValues,
  MIGRATIONS,
  OrganizationError,
  parseGroups,
  parseScimFilter,
  syncMemberships,
} from '@git-forge/accounts'
import { openSqliteDatabase } from '../src/index.ts'

const setup = async () => {
  const { db } = openSqliteDatabase()
  await applyMigrations(db, MIGRATIONS)
  const store = createAccountsStore(db)
  return { db, store }
}

const memberships = async (store: ReturnType<typeof createAccountsStore>, userId: string) => {
  const organizations = await store.organizationsOf(userId)
  const teams = await Promise.all(organizations.map(async (org) => (await store.listTeams(org.id)).map((team) => ({ org: org.login, team }))))
  const members = await Promise.all(teams.flat().map(async ({ org, team }) => ((await store.listTeamMembers(team.id)).some((member) => member.id === userId) ? [`${org}/${team.slug}`] : [])))
  return { organizations: organizations.map((org) => `${org.login}:${org.role}`), teams: members.flat() }
}

describe('group claims', () => {
  it('reads string arrays, single strings and ZITADEL role objects', () => {
    expect(groupValues(['acme', 'acme/dev'])).toEqual(['acme', 'acme/dev'])
    expect(groupValues('acme')).toEqual(['acme'])
    expect(groupValues({ 'acme:owner': { '123': 'zitadel.example' }, 'acme/dev': {} })).toEqual(['acme:owner', 'acme/dev'])
    expect(groupValues(undefined)).toEqual([])
    expect(groupValues(42)).toEqual([])
  })

  it('maps org, org:owner and org/team, ignoring anything else', () => {
    const parsed = parseGroups(['acme/dev', 'Acme:owner', 'beta', 'beta:member', 'x/y/z', 'bad name', 'gamma:admin', 'gamma/-x', ''])
    expect([...parsed.organizations.values()]).toEqual([
      { login: 'acme', role: 'owner' },
      { login: 'beta', role: 'member' },
    ])
    expect(parsed.teams).toEqual([{ organization: 'acme', slug: 'dev' }])
  })
})

describe('membership sync', () => {
  it('sets memberships exactly from the claim, creating unknown organizations and teams', async () => {
    const { store } = await setup()
    const alice = await store.createUser({ login: 'alice' })
    await store.createUser({ login: 'bob' })
    const legacy = await store.createOrganization({ login: 'legacy' })
    await store.setOrganizationMember(legacy.id, alice.id, 'owner')

    expect(await syncMemberships(store, alice.id, ['acme:owner', 'acme/dev', 'beta/ops', 'bob', 'api/x'])).toBe(true)
    expect(await memberships(store, alice.id)).toEqual({ organizations: ['acme:owner', 'beta:member'], teams: ['acme/dev', 'beta/ops'] })
    expect((await store.findAccount('bob'))?.kind).toBe('user')
    expect(await store.findAccount('api')).toBeNull()

    expect(await syncMemberships(store, alice.id, ['acme:owner', 'acme/dev', 'beta/ops'])).toBe(false)
    await syncMemberships(store, alice.id, ['acme/ops'])
    expect(await memberships(store, alice.id)).toEqual({ organizations: ['acme:member'], teams: ['acme/ops'] })
    await syncMemberships(store, alice.id, [])
    expect(await memberships(store, alice.id)).toEqual({ organizations: [], teams: [] })
  })

  it('refuses membership edits in idp mode and marks views as managed', async () => {
    const { store } = await setup()
    const owner = await store.createUser({ login: 'owner' })
    await store.createUser({ login: 'carol' })
    const org = await store.createOrganization({ login: 'acme' })
    await store.setOrganizationMember(org.id, owner.id, 'owner')
    await store.createTeam(org.id, { slug: 'dev', name: 'dev' })
    const principal = { kind: 'user', id: owner.id, login: 'owner', limits: null, tokenId: null } as const
    const operations = createOrganizationOperations(store, { membershipSource: 'idp' })
    const status = (promise: Promise<unknown>) => promise.then(() => 0, (error: unknown) => (error instanceof OrganizationError ? error.status : -1))
    expect(await status(operations.setMember(principal, 'acme', 'carol', 'member'))).toBe(409)
    expect(await status(operations.removeMember(principal, 'acme', 'owner'))).toBe(409)
    expect(await status(operations.setTeamMember(principal, 'acme', 'dev', 'owner', 'member'))).toBe(409)
    expect(await status(operations.removeTeamMember(principal, 'acme', 'dev', 'owner'))).toBe(409)
    expect(await status(operations.create(principal, 'newco'))).toBe(409)
    expect(await status(operations.createTeam(principal, 'acme', 'ops', ''))).toBe(0)
    expect((await operations.view(principal, 'acme')).managed).toBe(true)
    expect((await createOrganizationOperations(store).view(principal, 'acme')).managed).toBe(false)
  })
})

describe('SCIM', () => {
  const BASE = 'https://forge.example'

  const scimSetup = async (enabled = true) => {
    const { db, store } = await setup()
    const admin = await store.createUser({ login: 'admin' })
    await store.setInstanceAdmin(admin.id, true)
    const { token } = await store.createScimToken(admin.id, 'SCIM')
    const handler = createScimHandler({ db, store, origin: BASE, enabled, authenticate: store.authenticateScimToken, now: Date.now })
    const scim = async (method: string, path: string, body?: unknown, auth = token) => {
      const response = await handler(
        new Request(`${BASE}/scim/v2${path}`, {
          method,
          headers: { Authorization: `Bearer ${auth}`, ...(body ? { 'Content-Type': 'application/scim+json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      )
      return { status: response!.status, body: response!.status === 204 ? null : ((await response!.json()) as Record<string, any>) }
    }
    return { db, store, admin, token, scim }
  }

  it('parses eq filters only', () => {
    expect(parseScimFilter('userName eq "a\\"b@example.org"')).toEqual({ attribute: 'username', value: 'a"b@example.org' })
    expect(parseScimFilter(null)).toBeNull()
    expect(() => parseScimFilter('userName sw "a"')).toThrow(/eq/)
  })

  it('needs idp mode and a scim token of an instance admin, which is not a personal access token', async () => {
    const off = await scimSetup(false)
    expect((await off.scim('GET', '/Users')).status).toBe(404)
    const { store, admin, token, scim } = await scimSetup()
    expect((await scim('GET', '/Users', undefined, 'gfp_wrong')).status).toBe(401)
    expect(await store.authenticateToken(token)).toBeNull()
    const pat = await store.createPersonalAccessToken(admin.id, { name: 'pat', scopes: ['repo:admin'], expiresAt: null })
    expect((await scim('GET', '/Users', undefined, pat.token)).status).toBe(401)
    expect((await scim('GET', '/ServiceProviderConfig')).body?.patch).toEqual({ supported: true })
    await store.setInstanceAdmin(admin.id, false)
    expect((await scim('GET', '/Users')).status).toBe(401)
  })

  it('provisions, updates and deactivates users like Entra ID and Okta', async () => {
    const { db, store, scim } = await scimSetup()
    const created = await scim('POST', '/Users', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'dana@example.org',
      externalId: 'okta-1',
      name: { givenName: 'Dana', familyName: 'Scully' },
      emails: [{ value: 'dana@example.org', primary: true, type: 'work' }],
      active: true,
    })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ userName: 'dana@example.org', externalId: 'okta-1', displayName: 'Dana Scully', active: true })
    const id = created.body!.id as string
    expect((await store.findUserById(id))?.login).toBe('dana')
    expect((await scim('POST', '/Users', { userName: 'DANA@example.org' })).status).toBe(409)

    const found = await scim('GET', '/Users?filter=userName%20eq%20%22Dana%40example.org%22')
    expect(found.body).toMatchObject({ totalResults: 1, Resources: [{ id }] })
    expect((await scim('GET', '/Users?filter=externalId%20eq%20%22nobody%22')).body?.totalResults).toBe(0)

    const session = await db.run({ sql: "INSERT INTO sessions (id, token_hash, user_id, method, created_at, expires_at, last_seen_at) VALUES ('s1', 'h1', ?, 'oidc', 0, 9999999999999, 0)", params: [id] })
    expect(session.changes).toBe(1)
    const pat = await store.createPersonalAccessToken(id, { name: 'pat', scopes: ['repo:read'], expiresAt: null })

    const patched = await scim('PATCH', `/Users/${id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [
        { op: 'Replace', path: 'active', value: 'False' },
        { op: 'replace', path: 'emails[type eq "work"].value', value: 'dana@fbi.example' },
      ],
    })
    expect(patched.body).toMatchObject({ active: false, emails: [{ value: 'dana@fbi.example' }] })
    expect(await store.findUserById(id)).toBeNull()
    expect(await store.authenticateToken(pat.token)).toBeNull()
    expect(await db.all({ sql: 'SELECT revoked_at FROM sessions WHERE id = ?', params: ['s1'] })).toEqual([{ revoked_at: expect.any(Number) }])

    const okta = await scim('PATCH', `/Users/${id}`, { Operations: [{ op: 'replace', value: { active: true, displayName: 'Agent Scully' } }] })
    expect(okta.body).toMatchObject({ active: true, displayName: 'Agent Scully' })
    expect(await store.authenticateToken(pat.token)).toBeNull()

    const put = await scim('PUT', `/Users/${id}`, { userName: 'dana.scully@example.org', active: true })
    expect(put.body).toMatchObject({ userName: 'dana.scully@example.org', externalId: 'okta-1' })

    expect((await scim('DELETE', `/Users/${id}`)).status).toBe(204)
    expect((await scim('GET', `/Users/${id}`)).status).toBe(404)
    expect(await store.findUserById(id)).toBeNull()
  })

  it('adopts an existing account linked to the same identity', async () => {
    const { store, scim } = await scimSetup()
    const erin = await store.createUser({ login: 'erin' })
    await store.linkExternalIdentity(erin.id, { issuer: 'https://id.example', subject: 'sub-erin', email: 'erin@example.org' })
    const created = await scim('POST', '/Users', { userName: 'erin@example.org', externalId: 'sub-erin' })
    expect(created.body?.id).toBe(erin.id)
    expect(await store.findProvisionedUser({ issuer: 'https://other.example', subject: 'x', email: null, username: 'erin@example.org' })).toEqual({ id: erin.id, login: 'erin' })
    expect(await store.findProvisionedUser({ issuer: 'https://id.example', subject: 'x', email: null, username: 'erin@example.org' })).toBeNull()
  })

  it('maps groups to org/team and keeps organization membership in step', async () => {
    const { store, scim } = await scimSetup()
    const frank = (await scim('POST', '/Users', { userName: 'frank' })).body!.id as string
    const gina = (await scim('POST', '/Users', { userName: 'gina' })).body!.id as string
    expect((await scim('POST', '/Groups', { displayName: 'not a team' })).status).toBe(400)
    const group = await scim('POST', '/Groups', { displayName: 'acme/dev', members: [{ value: frank }] })
    expect(group.status).toBe(201)
    expect(group.body).toMatchObject({ displayName: 'acme/dev', members: [{ value: frank, display: 'frank' }] })
    const groupId = group.body!.id as string
    const acme = (await store.findAccount('acme'))!
    expect(await store.organizationRole(acme.id, frank)).toBe('member')
    expect((await scim('POST', '/Groups', { displayName: 'acme/dev' })).status).toBe(409)

    const filtered = await scim('GET', '/Groups?filter=displayName%20eq%20%22acme%2Fdev%22&excludedAttributes=members')
    expect(filtered.body).toMatchObject({ totalResults: 1, Resources: [{ id: groupId }] })
    expect(filtered.body!.Resources[0].members).toBeUndefined()

    expect((await scim('PATCH', `/Groups/${groupId}`, { Operations: [{ op: 'Add', path: 'members', value: [{ value: gina }] }] })).status).toBe(204)
    expect((await scim('PATCH', `/Groups/${groupId}`, { Operations: [{ op: 'Remove', path: `members[value eq "${frank}"]` }] })).status).toBe(204)
    expect((await scim('GET', `/Groups/${groupId}`)).body?.members).toEqual([expect.objectContaining({ value: gina })])
    expect(await store.organizationRole(acme.id, frank)).toBeNull()

    expect((await scim('PATCH', `/Groups/${groupId}`, { Operations: [{ op: 'replace', value: { id: groupId, displayName: 'acme/ops' } }] })).status).toBe(400)
    expect((await scim('PUT', `/Groups/${groupId}`, { displayName: 'acme/dev', members: [{ value: frank }] })).body?.members).toEqual([expect.objectContaining({ value: frank })])
    expect((await scim('DELETE', `/Groups/${groupId}`)).status).toBe(204)
    expect((await scim('GET', `/Groups/${groupId}`)).body?.members).toEqual([])
    expect(await memberships(store, gina)).toEqual({ organizations: [], teams: [] })
  })
})
