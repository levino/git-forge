import { type Database, type Row, type SqlValue, sql } from '@git-forge/accounts'
import { fromUtf8, utf8 } from '@git-forge/core'
import type { RepositoryData } from './backup.ts'

export const DATA_FORMAT = 'git-forge-repository-data-v1'

type TableSpec = {
  readonly table: string
  readonly where: string
  readonly order: string
}

const BY_REPOSITORY = 'repository_id = ?'
const BY_RULE = 'rule_id IN (SELECT id FROM branch_protection_rules WHERE repository_id = ?)'
const BY_ISSUE = 'issue_id IN (SELECT id FROM issues WHERE repository_id = ?)'

export const DATA_TABLES: readonly TableSpec[] = [
  { table: 'collaboration_settings', where: BY_REPOSITORY, order: 'repository_id' },
  { table: 'repository_numbers', where: BY_REPOSITORY, order: 'number' },
  { table: 'milestones', where: BY_REPOSITORY, order: 'id' },
  { table: 'labels', where: BY_REPOSITORY, order: 'id' },
  { table: 'issues', where: BY_REPOSITORY, order: 'id' },
  { table: 'pull_requests', where: BY_REPOSITORY, order: 'issue_id' },
  { table: 'issue_comments', where: BY_ISSUE, order: 'id' },
  { table: 'issue_labels', where: BY_ISSUE, order: 'issue_id, label_id' },
  { table: 'issue_assignees', where: BY_ISSUE, order: 'issue_id, user_id' },
  { table: 'issue_events', where: BY_ISSUE, order: 'id' },
  { table: 'review_requests', where: BY_ISSUE, order: 'issue_id, user_id' },
  { table: 'pull_request_reviews', where: BY_ISSUE, order: 'id' },
  { table: 'review_comments', where: BY_ISSUE, order: 'id' },
  { table: 'commit_statuses', where: BY_REPOSITORY, order: 'id' },
  { table: 'check_runs', where: BY_REPOSITORY, order: 'id' },
  { table: 'discussion_categories', where: BY_REPOSITORY, order: 'id' },
  { table: 'discussions', where: BY_REPOSITORY, order: 'id' },
  { table: 'discussion_comments', where: 'discussion_id IN (SELECT id FROM discussions WHERE repository_id = ?)', order: 'id' },
  { table: 'releases', where: BY_REPOSITORY, order: 'id' },
  { table: 'release_assets', where: 'release_id IN (SELECT id FROM releases WHERE repository_id = ?)', order: 'id' },
  { table: 'branch_protection_rules', where: BY_REPOSITORY, order: 'id' },
  { table: 'branch_protection_push_allowances', where: BY_RULE, order: 'rule_id, kind, subject' },
  { table: 'branch_protection_status_checks', where: BY_RULE, order: 'rule_id, context' },
]

const USER_COLUMNS: Readonly<Record<string, string>> = {
  issue_assignees: 'user_id',
  review_requests: 'user_id',
}

export type RepositoryExport = {
  readonly format: typeof DATA_FORMAT
  readonly repository: { readonly owner: string; readonly name: string; readonly visibility: string | null }
  readonly accounts: readonly Row[]
  readonly tables: Readonly<Record<string, readonly Row[]>>
}

export class DataImportError extends Error {}

const jsonValue = (value: SqlValue): unknown => {
  if (value instanceof Uint8Array) throw new DataImportError('binary columns are not exported')
  if (typeof value === 'bigint') return Number(value)
  return value
}

const tableNames = async (db: Database): Promise<Set<string>> =>
  new Set((await db.all<{ name: string }>(sql("SELECT name FROM sqlite_master WHERE type = 'table'"))).map((row) => row.name))

export const exportRepositoryData = async (db: Database, repository: { readonly owner: string; readonly name: string }): Promise<RepositoryData | null> => {
  const subject = (
    await db.all<{ id: string; visibility: string }>(
      sql('SELECT r.id, r.visibility FROM repositories r JOIN accounts a ON a.id = r.owner_id WHERE a.login = ? AND r.name = ?', repository.owner, repository.name),
    )
  )[0]
  if (!subject) return null
  const present = await tableNames(db)
  const tables: Record<string, Row[]> = {}
  const users = new Set<string>()
  for (const spec of DATA_TABLES) {
    if (!present.has(spec.table)) continue
    const rows = await db.all(sql(`SELECT * FROM ${spec.table} WHERE ${spec.where} ORDER BY ${spec.order}`, subject.id))
    if (rows.length === 0) continue
    tables[spec.table] = rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, jsonValue(value)])) as Row)
    for (const row of rows) for (const [key, value] of Object.entries(row)) if (typeof value === 'string' && /(^|_)(author|user|creator|actor|closed_by|merged_by|dismissed_by|last_pusher|answer_chosen_by|uploader)_id$|^user_id$/.test(key)) users.add(value)
  }
  const accounts =
    users.size === 0
      ? []
      : await db.all(sql(`SELECT id, login, kind, display_name FROM accounts WHERE id IN (${[...users].map(() => '?').join(', ')}) ORDER BY id`, ...users))
  const exported: RepositoryExport = {
    format: DATA_FORMAT,
    repository: { owner: repository.owner, name: repository.name, visibility: subject.visibility },
    accounts,
    tables,
  }
  return { format: DATA_FORMAT, bytes: utf8(JSON.stringify(exported)) }
}

export const parseRepositoryExport = (bytes: Uint8Array): RepositoryExport => {
  const value = JSON.parse(fromUtf8(bytes)) as RepositoryExport
  if (value.format !== DATA_FORMAT) throw new DataImportError(`unknown data export format ${String(value.format)}`)
  return value
}

export type ImportResult = {
  readonly rows: number
  readonly skipped: number
}

export const importRepositoryData = async (db: Database, repositoryId: string, exported: RepositoryExport): Promise<ImportResult> => {
  const present = await tableNames(db)
  const known = new Set((await db.all<{ id: string }>(sql('SELECT id FROM accounts'))).map((row) => row.id))
  const statements = []
  let skipped = 0
  for (const spec of DATA_TABLES) {
    const rows = exported.tables[spec.table]
    if (!rows || rows.length === 0) continue
    if (!present.has(spec.table)) throw new DataImportError(`table ${spec.table} does not exist; migrate the database first`)
    if (spec.where === BY_REPOSITORY) {
      const existing = await db.all(sql(`SELECT 1 FROM ${spec.table} WHERE repository_id = ? LIMIT 1`, repositoryId))
      if (existing.length > 0) throw new DataImportError(`${spec.table} already holds rows of this repository`)
    }
    for (const row of rows) {
      const userColumn = USER_COLUMNS[spec.table]
      if (userColumn && !known.has(row[userColumn] as string)) {
        skipped++
        continue
      }
      const record = 'repository_id' in row ? { ...row, repository_id: repositoryId } : row
      const columns = Object.keys(record)
      statements.push(sql(`INSERT INTO ${spec.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, ...columns.map((column) => record[column] as SqlValue)))
    }
  }
  try {
    await db.batch(statements)
  } catch (error) {
    throw new DataImportError(`the import failed and was rolled back (ids already taken? restore into a fresh database): ${(error as Error).message}`)
  }
  return { rows: statements.length, skipped }
}
