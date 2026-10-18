import { describe, expect, it } from 'vitest'
import {
  type AccountsStore,
  ANONYMOUS,
  applyMigrations,
  checkRepositoryAccess,
  createAccountsStore,
  type Database,
  listReadableRepositories,
  MIGRATIONS,
  parseSearchQuery,
  type Principal,
  search,
  SEARCH_INDEX_REBUILD,
  setRepositoryStats,
  sql,
} from '@git-forge/accounts'
import { openSqliteDatabase } from '../src/index.ts'

const ISSUER = 'https://peer.example'

const user = (id: string, login: string, limits: Extract<Principal, { kind: 'user' }>['limits'] = null): Principal => ({ kind: 'user', id, login, limits, tokenId: limits ? 'token' : null })

const seed = async (store: AccountsStore) => {
  const [alice, bob, carol, dave, root] = await Promise.all(['alice', 'bob', 'carol', 'dave', 'root'].map((login) => store.createUser({ login })))
  const village = await store.createOrganization({ login: 'village' })
  const town = await store.createOrganization({ login: 'town', defaultRepositoryRole: 'read' })
  await store.setOrganizationMember(village.id, alice!.id, 'owner')
  await store.setOrganizationMember(village.id, bob!.id, 'member')
  await store.setOrganizationMember(village.id, carol!.id, 'member')
  await store.setOrganizationMember(town.id, bob!.id, 'member')
  const archivists = await store.createTeam(village.id, { slug: 'archivists', name: 'Archivists' })
  await store.setTeamMember(archivists.id, carol!.id)
  const repo = (ownerId: string, name: string, visibility: 'public' | 'private') => store.createRepository({ ownerId, name, visibility })
  const repos = {
    notes: await repo(alice!.id, 'notes', 'private'),
    site: await repo(alice!.id, 'site', 'public'),
    shared: await repo(alice!.id, 'shared', 'private'),
    vault: await repo(village.id, 'vault', 'private'),
    hidden: await repo(village.id, 'hidden', 'private'),
    wiki: await repo(town.id, 'wiki', 'private'),
  }
  await store.setCollaborator(repos.shared.id, dave!.id, 'read')
  await store.setTeamRepositoryRole(repos.vault.id, archivists.id, 'read')
  await store.setInstanceAdmin(root!.id, true)
  const app = await store.createApp({ ownerId: alice!.id, slug: 'bot', name: 'Bot' })
  await store.setAppRepositoryRole(app.id, repos.notes.id, 'read')
  await store.trustInstance({ issuer: ISSUER })
  await store.grantInstanceRepository(ISSUER, repos.hidden.id)
  const principals: Record<string, Principal> = {
    anonymous: ANONYMOUS,
    alice: user(alice!.id, 'alice'),
    bob: user(bob!.id, 'bob'),
    carol: user(carol!.id, 'carol'),
    dave: user(dave!.id, 'dave'),
    bobScoped: user(bob!.id, 'bob', { ceiling: 'read', repositoryIds: [repos.wiki.id] }),
    aliceNone: user(alice!.id, 'alice', { ceiling: 'none', repositoryIds: null }),
    app: { kind: 'app', id: app.id, slug: 'bot', limits: { ceiling: 'read', repositoryIds: null }, tokenId: 'token' },
    instance: { kind: 'instance', issuer: ISSUER, repositories: ['village/hidden'], scopes: ['git:read'], tokenId: 'jwt' },
    instanceLfsOnly: { kind: 'instance', issuer: ISSUER, repositories: ['village/hidden'], scopes: ['lfs:read'], tokenId: 'jwt' },
  }
  return { repos, principals, root: user(root!.id, 'root'), ids: { alice: alice!.id, town: town.id } }
}

const fresh = async () => {
  const { db } = openSqliteDatabase()
  await applyMigrations(db, MIGRATIONS)
  const store = createAccountsStore(db)
  return { db, store, ...(await seed(store)) }
}

const names = async (db: Database, principal: Principal, options: Parameters<typeof listReadableRepositories>[2] = {}) =>
  (await listReadableRepositories(db, principal, { sort: 'name', ...options })).items.map((repo) => `${repo.owner}/${repo.name}`)

const issue = (db: Database, repositoryId: string, number: number, title: string, body: string | null, isPull = 0) =>
  db.run(
    sql(
      "INSERT INTO issues (node_id, repository_id, number, is_pull, title, body, author_kind, author_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'user', 'x', 'open', 1, 1)",
      `I_${repositoryId}_${number}`,
      repositoryId,
      number,
      isPull,
      title,
      body,
    ),
  )

const issueId = async (db: Database, repositoryId: string, number: number) =>
  (await db.all<{ id: number }>(sql('SELECT id FROM issues WHERE repository_id = ? AND number = ?', repositoryId, number)))[0]!.id

const comment = (db: Database, issue: number, body: string) =>
  db.run(sql("INSERT INTO issue_comments (node_id, issue_id, author_kind, author_id, body, created_at, updated_at) VALUES (?, ?, 'user', 'x', ?, 1, 1)", `C_${issue}_${body}`, issue, body))

describe('access-filtered repository listing', () => {
  it('matches checkRepositoryAccess for every principal and repository', async () => {
    const { db, store, repos, principals } = await fresh()
    for (const [label, principal] of Object.entries(principals)) {
      const expected: string[] = []
      for (const repo of Object.values(repos)) {
        const subject = (await store.listRepositories()).find((candidate) => candidate.id === repo.id)!
        if ((await checkRepositoryAccess(store, principal, subject, 'read')).decision === 'allow') expected.push(`${subject.owner}/${subject.name}`)
      }
      expect(await names(db, principal), label).toEqual(expected.sort())
    }
  })

  it('gives instance admins every repository', async () => {
    const { db, root } = await fresh()
    expect(await names(db, root)).toEqual(['alice/notes', 'alice/shared', 'alice/site', 'town/wiki', 'village/hidden', 'village/vault'])
  })

  it('keeps private repositories out of other listings', async () => {
    const { db, principals } = await fresh()
    expect(await names(db, principals.anonymous!)).toEqual(['alice/site'])
    expect(await names(db, principals.dave!, { owner: 'alice' })).toEqual(['alice/shared', 'alice/site'])
    expect(await names(db, principals.carol!, { owner: 'village' })).toEqual(['village/vault'])
    expect(await names(db, principals.bob!)).toEqual(['alice/site', 'town/wiki'])
  })

  it('sorts by last commit and paginates with a total', async () => {
    const { db, repos, principals } = await fresh()
    await setRepositoryStats(db, repos.shared.id, { defaultBranch: 'main', lastCommitAt: 3000 }, 1)
    await setRepositoryStats(db, repos.notes.id, { defaultBranch: 'trunk', lastCommitAt: 5000 }, 1)
    const first = await listReadableRepositories(db, principals.alice!, { owner: 'alice', perPage: 2 })
    expect(first.items.map((repo) => [repo.name, repo.defaultBranch, repo.lastCommitAt])).toEqual([
      ['notes', 'trunk', 5000],
      ['shared', 'main', 3000],
    ])
    expect(first.total).toBe(3)
    const second = await listReadableRepositories(db, principals.alice!, { owner: 'alice', perPage: 2, page: 2 })
    expect(second.items.map((repo) => [repo.name, repo.statsAt])).toEqual([['site', null]])
  })
})

describe('full-text search', () => {
  it('parses terms and qualifiers into a safe MATCH expression', () => {
    expect(parseSearchQuery('Zebra "crossing" repo:alice/notes is:pr is:open x"*)')).toEqual({
      match: '"zebra"* "crossing"* "x"*',
      repo: { owner: 'alice', name: 'notes' },
      owner: null,
      kind: 'pr',
      state: 'open',
    })
    expect(parseSearchQuery('  ').match).toBeNull()
  })

  it('finds repositories by name and never leaks private ones', async () => {
    const { db, principals } = await fresh()
    const found = async (principal: Principal, q: string) => ((await search(db, principal, 'repositories', q)).page.items as unknown as { owner: string; name: string }[]).map((repo) => `${repo.owner}/${repo.name}`)
    expect(await found(principals.carol!, 'vau')).toEqual(['village/vault'])
    expect(await found(principals.anonymous!, 'vault')).toEqual([])
    expect(await found(principals.bob!, 'vault')).toEqual([])
    expect(await found(principals.anonymous!, 'alice')).toEqual(['alice/site'])
  })

  it('finds issues through titles, bodies and comments, filtered by access', async () => {
    const { db, repos, principals } = await fresh()
    await issue(db, repos.site.id, 1, 'Public zebra', 'stripes')
    await issue(db, repos.notes.id, 1, 'Secret plans', 'the zebra escapes')
    await issue(db, repos.notes.id, 2, 'Merge me', null, 1)
    await comment(db, await issueId(db, repos.notes.id, 2), 'mentions a zebra too')
    const titles = async (principal: Principal, q: string) => ((await search(db, principal, 'issues', q)).page.items as unknown as { title: string }[]).map((hit) => hit.title).sort()
    expect(await titles(principals.anonymous!, 'zebra')).toEqual(['Public zebra'])
    expect(await titles(principals.bob!, 'zebra')).toEqual(['Public zebra'])
    expect(await titles(principals.alice!, 'zebra')).toEqual(['Merge me', 'Public zebra', 'Secret plans'])
    expect(await titles(principals.alice!, 'zebra is:pr')).toEqual(['Merge me'])
    expect(await titles(principals.alice!, 'zebra repo:alice/site')).toEqual(['Public zebra'])
    expect(await titles(principals.app!, 'secret')).toEqual(['Secret plans'])
    await db.run(sql("UPDATE issues SET body = 'nothing here' WHERE repository_id = ? AND number = 1", repos.notes.id))
    await db.run(sql('UPDATE issue_comments SET deleted_at = 1'))
    expect(await titles(principals.alice!, 'zebra')).toEqual(['Public zebra'])
    const result = await search(db, principals.alice!, 'issues', 'nothing')
    expect(result.page.total).toBe(1)
  })

  it('finds discussions and accounts', async () => {
    const { db, store, repos, principals, ids } = await fresh()
    await db.run(sql("INSERT INTO discussion_categories (node_id, repository_id, slug, name, created_at) VALUES ('DC', ?, 'general', 'General', 1)", repos.wiki.id))
    await db.run(
      sql(
        "INSERT INTO discussions (node_id, repository_id, number, category_id, title, body, author_kind, author_id, state, created_at, updated_at) VALUES ('D1', ?, 1, (SELECT id FROM discussion_categories), 'Town hall', 'agenda', 'user', 'x', 'open', 1, 1)",
        repos.wiki.id,
      ),
    )
    expect((await search(db, principals.bob!, 'discussions', 'agenda')).page.total).toBe(1)
    expect((await search(db, principals.carol!, 'discussions', 'agenda')).page.total).toBe(0)
    expect(((await search(db, ANONYMOUS, 'users', 'vil')).page.items as unknown as { login: string }[]).map((hit) => hit.login)).toEqual(['village'])
    await store.disableAccount(ids.town)
    expect((await search(db, principals.bob!, 'discussions', 'agenda')).page.total).toBe(0)
    expect((await search(db, ANONYMOUS, 'users', 'town')).page.total).toBe(0)
  })

  it('backfills existing data when the migration runs and rebuilds on demand', async () => {
    const { db } = openSqliteDatabase()
    await applyMigrations(db, MIGRATIONS.filter((migration) => migration.name < '0026'))
    const store = createAccountsStore(db)
    const { repos, principals } = await seed(store)
    await issue(db, repos.site.id, 1, 'Older zebra', null)
    await applyMigrations(db, MIGRATIONS)
    expect((await search(db, principals.anonymous!, 'issues', 'zebra')).page.total).toBe(1)
    expect((await search(db, principals.anonymous!, 'repositories', 'site')).page.total).toBe(1)
    await db.batch(SEARCH_INDEX_REBUILD)
    expect((await search(db, principals.anonymous!, 'issues', 'zebra')).page.total).toBe(1)
    expect((await search(db, principals.anonymous!, 'users', 'alice')).page.total).toBe(1)
  })
})
