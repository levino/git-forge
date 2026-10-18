import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  type AccountsStore,
  applyMigrations,
  pendingMigrations,
  createAccountsStore,
  d1Database,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type Database,
  hashToken,
  MIGRATIONS,
  resolveAccess,
  sql,
} from '@git-forge/accounts'
import { nodeSqliteDatabase, openSqliteDatabase } from '../src/index.ts'

const fresh = async (clock: { now: number } = { now: Date.UTC(2026, 9, 18) }) => {
  const { db, handle } = openSqliteDatabase()
  await applyMigrations(db, MIGRATIONS)
  return { db, handle, clock, store: createAccountsStore(db, { now: () => clock.now }) }
}

const tables = (db: Database) => db.all<{ name: string }>(sql("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"))

describe('migrations on node:sqlite', () => {
  it('creates the schema once and is idempotent', async () => {
    const { db } = openSqliteDatabase()
    expect(await applyMigrations(db, MIGRATIONS)).toEqual(['0001_initial', '0002_branch_protection', '0003_instance_admins', '0004_mirror_subscriptions', '0005_actions', '0006_login', '0007_collaboration'])
    expect(await applyMigrations(db, MIGRATIONS)).toEqual([])
    expect((await tables(db)).map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'accounts',
        'external_identities',
        'organization_members',
        'teams',
        'team_members',
        'repositories',
        'repository_collaborators',
        'repository_teams',
        'apps',
        'app_repositories',
        'tokens',
        'trusted_instances',
        'instance_repositories',
        'audit_log',
        'branch_protection_rules',
        'branch_protection_push_allowances',
        'branch_protection_status_checks',
        'instance_admins',
        'schema_migrations',
      ]),
    )
  })

  it('refuses to run when an applied migration was edited or is unknown', async () => {
    const { db } = openSqliteDatabase()
    await applyMigrations(db, MIGRATIONS)
    const edited = MIGRATIONS.map((migration) => ({ ...migration, sql: `${migration.sql}\n` }))
    await expect(applyMigrations(db, edited)).rejects.toThrow(/was modified/)
    await expect(applyMigrations(db, [])).rejects.toThrow(/unknown migration 0001_initial/)
  })

  it('lists pending migrations without touching the database', async () => {
    const { db } = openSqliteDatabase()
    expect(await pendingMigrations(db, MIGRATIONS)).toEqual(MIGRATIONS.map((migration) => migration.name))
    expect(await tables(db)).toEqual([])
    await applyMigrations(db, MIGRATIONS.slice(0, 2))
    expect(await pendingMigrations(db, MIGRATIONS)).toEqual(MIGRATIONS.slice(2).map((migration) => migration.name))
    await applyMigrations(db, MIGRATIONS)
    expect(await pendingMigrations(db, MIGRATIONS)).toEqual([])
    await expect(pendingMigrations(db, MIGRATIONS.slice(1))).rejects.toThrow(/unknown migration 0001_initial/)
  })

  it('applies new migrations in order and rolls back a failing one completely', async () => {
    const { db } = openSqliteDatabase()
    await applyMigrations(db, MIGRATIONS)
    const broken = [...MIGRATIONS, { name: '9998_broken', sql: 'CREATE TABLE extra (x);\n--> statement-breakpoint\nNOT VALID SQL' }]
    await expect(applyMigrations(db, broken)).rejects.toThrow()
    expect((await tables(db)).map((row) => row.name)).not.toContain('extra')
    const good = [...MIGRATIONS, { name: '9998_extra', sql: 'CREATE TABLE extra (x);' }]
    expect(await applyMigrations(db, good)).toEqual(['9998_extra'])
    await expect(applyMigrations(db, [{ name: 'bad-name', sql: '' }])).rejects.toThrow(/invalid migration name/)
  })

  it('keeps the audit log append-only', async () => {
    const { db, store } = await fresh()
    await store.createUser({ login: 'alice' })
    await expect(db.run(sql("UPDATE audit_log SET action = 'forged'"))).rejects.toThrow(/append-only/)
    await expect(db.run(sql('DELETE FROM audit_log'))).rejects.toThrow(/append-only/)
    expect((await store.auditLog()).map((entry) => entry.action)).toEqual(['user.create'])
  })
})

const seed = async (store: AccountsStore) => {
  const alice = await store.createUser({ login: 'alice', email: 'alice@example.org' })
  const bob = await store.createUser({ login: 'bob' })
  const carol = await store.createUser({ login: 'carol' })
  const village = await store.createOrganization({ login: 'village', defaultRepositoryRole: 'read' })
  await store.setOrganizationMember(village.id, alice.id, 'owner')
  await store.setOrganizationMember(village.id, bob.id, 'member')
  const archivists = await store.createTeam(village.id, { slug: 'archivists', name: 'Archivists' })
  await store.setTeamMember(archivists.id, bob.id)
  const archive = await store.createRepository({ ownerId: village.id, name: 'archive', visibility: 'private' })
  const site = await store.createRepository({ ownerId: village.id, name: 'site', visibility: 'public' })
  await store.setTeamRepositoryRole(archive.id, archivists.id, 'write')
  await store.setCollaborator(site.id, carol.id, 'triage')
  return { alice, bob, carol, village, archivists, archive, site }
}

describe('accounts store', () => {
  it('resolves GitHub-style access from stored memberships', async () => {
    const { store } = await fresh()
    const ids = await seed(store)
    const archive = (await store.findRepository('Village', 'ARCHIVE'))!
    expect(archive).toMatchObject({ id: ids.archive.id, owner: 'village', ownerKind: 'organization', visibility: 'private', defaultRole: 'read' })
    const user = (id: string, login: string) => ({ kind: 'user' as const, id, login, limits: null, tokenId: null })
    const access = async (principal: ReturnType<typeof user>) => resolveAccess(principal, archive, await store.grantsFor(principal, archive))
    expect(await access(user(ids.alice.id, 'alice'))).toBe('admin')
    expect(await access(user(ids.bob.id, 'bob'))).toBe('write')
    expect(await access(user(ids.carol.id, 'carol'))).toBe('none')
    await store.removeOrganizationMember(ids.village.id, ids.bob.id)
    expect(await access(user(ids.bob.id, 'bob'))).toBe('none')
  })

  it('validates names and relationships', async () => {
    const { store } = await fresh()
    const ids = await seed(store)
    await expect(store.createUser({ login: 'alice' })).rejects.toThrow()
    await expect(store.createUser({ login: 'ALICE' })).rejects.toThrow()
    await expect(store.createUser({ login: '-bad' })).rejects.toThrow(/invalid login/)
    await expect(store.createRepository({ ownerId: ids.alice.id, name: 'x.git', visibility: 'public' })).rejects.toThrow(/invalid repository/)
    await expect(store.setTeamMember(ids.archivists.id, ids.carol.id)).rejects.toThrow(/belong to the organization/)
    const personal = await store.createRepository({ ownerId: ids.alice.id, name: 'notes', visibility: 'private' })
    await expect(store.setTeamRepositoryRole(personal.id, ids.archivists.id, 'read')).rejects.toThrow(/their organization/)
    await expect(store.setCollaborator(personal.id, ids.bob.id, 'owner' as 'admin')).rejects.toThrow(/invalid role/)
  })

  it('links external identities for later OIDC login', async () => {
    const { store } = await fresh()
    const { alice } = await seed(store)
    await store.linkExternalIdentity(alice.id, { issuer: 'https://id.example', subject: '1234' })
    expect(await store.findUserByExternalIdentity('https://id.example', '1234')).toEqual({ id: alice.id, login: 'alice' })
    expect(await store.findUserByExternalIdentity('https://other.example', '1234')).toBeNull()
    await expect(store.linkExternalIdentity(alice.id, { issuer: 'https://id.example', subject: '1234' })).rejects.toThrow()
  })

  it('stores only a hash of personal access tokens and enforces expiry, revocation and scopes', async () => {
    const { db, store, clock } = await fresh()
    const { alice, archive } = await seed(store)
    const created = await store.createPersonalAccessToken(alice.id, { name: 'laptop', scopes: ['repo:read'], expiresAt: clock.now + 60_000 })
    const rows = await db.all(sql('SELECT * FROM tokens'))
    expect(JSON.stringify(rows)).not.toContain(created.token)
    expect(rows[0]).toMatchObject({ token_hash: await hashToken(created.token), display_prefix: created.token.slice(0, 10), scopes: 'repo:read' })
    expect(JSON.stringify(await store.auditLog())).not.toContain(created.token)

    const principal = await store.authenticateToken(created.token)
    expect(principal).toMatchObject({ kind: 'user', id: alice.id, login: 'alice', limits: { ceiling: 'read', repositoryIds: null }, tokenId: created.id })
    const repo = (await store.findRepository('village', 'archive'))!
    expect(resolveAccess(principal!, repo, await store.grantsFor(principal!, repo))).toBe('read')
    expect((await store.listTokens({ accountId: alice.id }))[0]).toMatchObject({ name: 'laptop', lastUsedAt: clock.now, status: 'active' })

    clock.now += 30_000
    await store.authenticateToken(created.token)
    expect((await store.listTokens({ accountId: alice.id }))[0]?.lastUsedAt).toBe(clock.now - 30_000)

    clock.now += 30_000
    expect(await store.authenticateToken(created.token)).toBeNull()
    expect((await store.listTokens({ accountId: alice.id }))[0]?.status).toBe('expired')

    const second = await store.createPersonalAccessToken(alice.id, { name: 'ci', scopes: ['repo:write'], expiresAt: null, repositoryIds: [archive.id] })
    expect(await store.authenticateToken(second.token)).toMatchObject({ limits: { ceiling: 'write', repositoryIds: [archive.id] } })
    await store.revokeToken(second.id)
    expect(await store.authenticateToken(second.token)).toBeNull()
    expect(await store.authenticateToken(`${second.token.slice(0, -1)}A`)).toBeNull()
    await expect(store.createPersonalAccessToken(alice.id, { name: 'past', scopes: [], expiresAt: clock.now })).rejects.toThrow(/future/)
  })

  it('rejects tokens of disabled accounts', async () => {
    const { store } = await fresh()
    const { bob } = await seed(store)
    const { token } = await store.createPersonalAccessToken(bob.id, { name: 'x', scopes: ['repo:read'], expiresAt: null })
    expect(await store.authenticateToken(token)).not.toBeNull()
    await store.disableAccount(bob.id)
    expect(await store.authenticateToken(token)).toBeNull()
  })

  it('issues short-lived app tokens bound to app grants', async () => {
    const { store, clock } = await fresh()
    const { village, archive, site } = await seed(store)
    const app = await store.createApp({ ownerId: village.id, slug: 'importer', name: 'Importer' })
    await store.setAppRepositoryRole(app.id, archive.id, 'write')
    await expect(store.createAppToken(app.id, { scopes: ['repo:write'], ttlSeconds: 7200 })).rejects.toThrow(/at most/)
    const created = await store.createAppToken(app.id, { scopes: ['repo:write'], ttlSeconds: 600 })
    expect(created.token).toMatch(/^gfa_/)
    expect(created.expiresAt).toBe(clock.now + 600_000)
    const principal = (await store.authenticateToken(created.token))!
    expect(principal).toMatchObject({ kind: 'app', id: app.id, slug: 'importer' })
    const archiveRepo = (await store.findRepository('village', 'archive'))!
    const siteRepo = (await store.findRepository('village', 'site'))!
    expect(resolveAccess(principal, archiveRepo, await store.grantsFor(principal, archiveRepo))).toBe('write')
    expect(resolveAccess(principal, siteRepo, await store.grantsFor(principal, siteRepo))).toBe('read')
    expect(site.id).toBe(siteRepo.id)
    await store.disableApp(app.id)
    expect(await store.authenticateToken(created.token)).toBeNull()
    await expect(store.createAppToken(app.id, { scopes: ['repo:read'] })).rejects.toThrow(/no active app/)
  })

  it('stores instance trust per repository', async () => {
    const { store } = await fresh()
    const { archive } = await seed(store)
    await store.trustInstance({ issuer: 'https://b.example/' })
    await store.grantInstanceRepository('https://b.example', archive.id)
    expect(await store.lookupTrustedIssuer('https://b.example')).toEqual({ issuer: 'https://b.example', pinnedThumbprint: null })
    const repo = (await store.findRepository('village', 'archive'))!
    const principal = { kind: 'instance' as const, issuer: 'https://b.example', repositories: ['village/archive'], scopes: ['git:read'], tokenId: 'j' }
    expect(resolveAccess(principal, repo, await store.grantsFor(principal, repo))).toBe('read')
    await store.distrustInstance('https://b.example')
    expect(await store.lookupTrustedIssuer('https://b.example')).toBeNull()
    expect(resolveAccess(principal, repo, await store.grantsFor(principal, repo))).toBe('none')
    await store.trustInstance({ issuer: 'https://b.example', pinnedThumbprint: 'abc' })
    expect(await store.lookupTrustedIssuer('https://b.example')).toEqual({ issuer: 'https://b.example', pinnedThumbprint: 'abc' })
    await store.revokeInstanceRepository('https://b.example', archive.id)
    expect(resolveAccess(principal, repo, await store.grantsFor(principal, repo))).toBe('none')
  })

  it('bootstraps exactly one first instance admin', async () => {
    const { store } = await fresh()
    const admin = await store.bootstrapInstanceAdmin({ login: 'root', email: 'root@example.org' })
    expect(admin).not.toBeNull()
    expect(await store.isInstanceAdmin(admin!.id)).toBe(true)
    expect(await store.bootstrapInstanceAdmin({ login: 'second' })).toBeNull()
    expect(await store.findAccount('second')).toBeNull()
    expect((await store.auditLog()).map((entry) => entry.action)).toEqual(['instance.bootstrap'])
    const other = await store.createUser({ login: 'other' })
    expect(await store.isInstanceAdmin(other.id)).toBe(false)
    await store.setInstanceAdmin(other.id, true)
    expect(await store.isInstanceAdmin(other.id)).toBe(true)
    await store.setInstanceAdmin(other.id, false)
    expect(await store.isInstanceAdmin(other.id)).toBe(false)
    await store.disableAccount(admin!.id)
    expect(await store.isInstanceAdmin(admin!.id)).toBe(false)
  })

  it('lists repositories of enabled owners', async () => {
    const { store } = await fresh()
    const { alice } = await seed(store)
    await store.createRepository({ ownerId: alice.id, name: 'notes', visibility: 'private' })
    expect((await store.listRepositories()).map((repo) => `${repo.owner}/${repo.name}:${repo.visibility}`)).toEqual([
      'alice/notes:private',
      'village/archive:private',
      'village/site:public',
    ])
    await store.disableAccount(alice.id)
    expect((await store.listRepositories()).map((repo) => repo.name)).toEqual(['archive', 'site'])
  })

  it('stores mirror subscriptions only for trusted instances', async () => {
    const { store } = await fresh()
    const subscription = { issuer: 'https://beta.example/', repository: 'Village/Archive', callback: 'https://beta.example/api/federation/notify/b/a/origin' }
    await expect(store.subscribeMirror(subscription)).rejects.toThrow()
    await store.trustInstance({ issuer: 'https://beta.example' })
    await store.subscribeMirror(subscription)
    await store.subscribeMirror(subscription)
    const expected = { issuer: 'https://beta.example', repository: 'village/archive', callback: subscription.callback }
    expect(await store.mirrorSubscriptions('village/ARCHIVE')).toEqual([expected])
    await store.distrustInstance('https://beta.example')
    expect(await store.mirrorSubscriptions('village/archive')).toEqual([])
    await store.trustInstance({ issuer: 'https://beta.example' })
    expect(await store.unsubscribeMirror(subscription)).toBe(true)
    expect(await store.unsubscribeMirror(subscription)).toBe(false)
    expect(await store.mirrorSubscriptions('village/archive')).toEqual([])
    expect((await store.auditLog()).map((entry) => entry.action)).toEqual(expect.arrayContaining(['mirror.subscribe', 'mirror.unsubscribe']))
  })

  it('writes every change and its audit entry atomically', async () => {
    const { store } = await fresh()
    const { archive, alice } = await seed(store)
    const before = (await store.auditLog()).length
    await expect(store.createRepository({ ownerId: alice.id, name: 'dup', visibility: 'public' })).resolves.toBeDefined()
    await expect(store.createRepository({ ownerId: alice.id, name: 'DUP', visibility: 'public' })).rejects.toThrow()
    const entries = await store.auditLog({ afterSeq: 0, limit: 1000 })
    expect(entries).toHaveLength(before + 1)
    expect(entries.at(-1)).toMatchObject({ action: 'repository.create', data: { name: 'dup' } })
    expect((await store.auditLog({ repositoryId: archive.id })).map((entry) => entry.action)).toEqual(['repository.create', 'repository.team.set'])
  })
})

class FakeD1Statement implements D1PreparedStatementLike {
  constructor(
    readonly handle: DatabaseSync,
    readonly query: string,
    readonly values: unknown[] = [],
  ) {}
  bind(...values: unknown[]) {
    return new FakeD1Statement(this.handle, this.query, values)
  }
  async all<T>() {
    return { results: this.handle.prepare(this.query).all(...(this.values as never[])) as T[] }
  }
  async run() {
    return { meta: { changes: Number(this.handle.prepare(this.query).run(...(this.values as never[])).changes) } }
  }
}

const fakeD1 = (handle: DatabaseSync): D1DatabaseLike => ({
  prepare: (query) => new FakeD1Statement(handle, query),
  batch: async (statements) => {
    handle.exec('BEGIN')
    try {
      const results = []
      for (const statement of statements) results.push(await statement.run())
      handle.exec('COMMIT')
      return results
    } catch (error) {
      handle.exec('ROLLBACK')
      throw error
    }
  },
})

describe('D1 adapter', () => {
  it('runs migrations and the store through the D1 interface', async () => {
    const handle = new DatabaseSync(':memory:')
    handle.exec('PRAGMA foreign_keys = ON')
    const db = d1Database(fakeD1(handle))
    expect(await applyMigrations(db, MIGRATIONS)).toEqual(['0001_initial', '0002_branch_protection', '0003_instance_admins', '0004_mirror_subscriptions', '0005_actions', '0006_login', '0007_collaboration'])
    const store = createAccountsStore(db)
    const { alice } = await seed(store)
    const { token } = await store.createPersonalAccessToken(alice.id, { name: 'd1', scopes: ['repo:admin'], expiresAt: null })
    expect(await store.authenticateToken(token)).toMatchObject({ kind: 'user', id: alice.id })
    expect(await applyMigrations(nodeSqliteDatabase(handle), MIGRATIONS)).toEqual([])
  })
})
