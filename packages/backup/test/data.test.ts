import { applyMigrations, createAccountsStore, type Database, MIGRATIONS, sql } from '@git-forge/accounts'
import { openSqliteDatabase } from '@git-forge/accounts-node'
import { describe, expect, it } from 'vitest'
import { DataImportError, exportRepositoryData, importRepositoryData, parseRepositoryExport } from '../src/data.ts'

const database = async () => {
  const { db } = openSqliteDatabase(':memory:')
  await applyMigrations(db, MIGRATIONS)
  return { db, store: createAccountsStore(db) }
}

const seed = async (db: Database, repositoryId: string, alice: string, bob: string) => {
  const at = 1760781600
  await db.batch([
    sql("INSERT INTO labels (node_id, repository_id, name, color, created_at) VALUES ('LA_1', ?, 'bug', 'ff0000', ?)", repositoryId, at),
    sql("INSERT INTO repository_numbers (repository_id, number, kind, node_id) VALUES (?, 1, 'issue', 'I_1')", repositoryId),
    sql(
      "INSERT INTO issues (node_id, repository_id, number, is_pull, title, body, author_kind, author_id, state, created_at, updated_at) VALUES ('I_1', ?, 1, 0, 'Broken', 'It breaks', 'user', ?, 'open', ?, ?)",
      repositoryId,
      alice,
      at,
      at,
    ),
  ])
  const issue = (await db.all<{ id: number }>(sql('SELECT id FROM issues WHERE repository_id = ?', repositoryId)))[0]!.id
  const label = (await db.all<{ id: number }>(sql('SELECT id FROM labels WHERE repository_id = ?', repositoryId)))[0]!.id
  await db.batch([
    sql("INSERT INTO issue_comments (node_id, issue_id, author_kind, author_id, body, created_at, updated_at) VALUES ('IC_1', ?, 'user', ?, 'Confirmed', ?, ?)", issue, bob, at, at),
    sql('INSERT INTO issue_labels (issue_id, label_id, created_at) VALUES (?, ?, ?)', issue, label, at),
    sql('INSERT INTO issue_assignees (issue_id, user_id, created_at) VALUES (?, ?, ?)', issue, alice, at),
    sql('INSERT INTO issue_assignees (issue_id, user_id, created_at) VALUES (?, ?, ?)', issue, bob, at),
  ])
}

const rows = (db: Database, table: string) => db.all(sql(`SELECT * FROM ${table} ORDER BY 1`))

describe('repository data export', () => {
  it('round-trips issues, comments and labels into a fresh database', async () => {
    const source = await database()
    const alice = await source.store.createUser({ login: 'alice' })
    const bob = await source.store.createUser({ login: 'bob' })
    const repository = await source.store.createRepository({ ownerId: alice.id, name: 'site', visibility: 'private' })
    await seed(source.db, repository.id, alice.id, bob.id)

    const exported = await exportRepositoryData(source.db, { owner: 'alice', name: 'site' })
    expect(exported).not.toBeNull()
    const parsed = parseRepositoryExport(exported!.bytes)
    expect(parsed.repository).toEqual({ owner: 'alice', name: 'site', visibility: 'private' })
    expect(parsed.accounts.map((account) => account.login).sort()).toEqual(['alice', 'bob'])
    expect(Object.keys(parsed.tables).sort()).toEqual(['issue_assignees', 'issue_comments', 'issue_labels', 'issues', 'labels', 'repository_numbers'])

    const target = await database()
    await target.store.createUser({ id: alice.id, login: 'alice' })
    const restored = await target.store.createRepository({ ownerId: alice.id, name: 'site', visibility: 'private' })
    const result = await importRepositoryData(target.db, restored.id, parsed)
    expect(result).toEqual({ rows: 6, skipped: 1 })
    const issues = await rows(target.db, 'issues')
    expect(issues).toEqual((await rows(source.db, 'issues')).map((row) => ({ ...row, repository_id: restored.id })))
    expect(await rows(target.db, 'issue_comments')).toEqual(await rows(source.db, 'issue_comments'))
    expect((await rows(target.db, 'issue_assignees')).map((row) => row.user_id)).toEqual([alice.id])

    await expect(importRepositoryData(target.db, restored.id, parsed)).rejects.toBeInstanceOf(DataImportError)
  })

  it('returns null for an unknown repository', async () => {
    const { db } = await database()
    expect(await exportRepositoryData(db, { owner: 'nobody', name: 'none' })).toBeNull()
  })
})
