import { type Database, sql, type Statement } from './database.ts'
import { sha256Hex } from './encoding.ts'

export type Migration = {
  readonly name: string
  readonly sql: string
}

export const STATEMENT_BREAKPOINT = '--> statement-breakpoint'

export const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+$/

export class MigrationError extends Error {}

export const splitStatements = (text: string): string[] =>
  text
    .split(STATEMENT_BREAKPOINT)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

type AppliedRow = { name: string; sha256: string }

export const MIGRATIONS_TABLE = /^[a-z_][a-z0-9_]*$/

export const applyMigrations = async (
  db: Database,
  migrations: readonly Migration[],
  now: number = Date.now(),
  table = 'schema_migrations',
): Promise<string[]> => {
  if (!MIGRATIONS_TABLE.test(table)) throw new MigrationError(`invalid migrations table ${table}`)
  for (const [index, migration] of migrations.entries()) {
    if (!MIGRATION_NAME.test(migration.name)) throw new MigrationError(`invalid migration name ${migration.name}`)
    if (index > 0 && migrations[index - 1]!.name >= migration.name) throw new MigrationError(`migrations out of order at ${migration.name}`)
  }
  await db.run(sql(`CREATE TABLE IF NOT EXISTS ${table} (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL)`))
  const applied = await db.all<AppliedRow>(sql(`SELECT name, sha256 FROM ${table} ORDER BY name`))
  const known = new Map(await Promise.all(migrations.map(async (migration) => [migration.name, await sha256Hex(migration.sql)] as const)))
  for (const row of applied) {
    const hash = known.get(row.name)
    if (hash === undefined) throw new MigrationError(`database has unknown migration ${row.name}`)
    if (hash !== row.sha256) throw new MigrationError(`applied migration ${row.name} was modified`)
  }
  const done = new Set(applied.map((row) => row.name))
  const newlyApplied: string[] = []
  for (const migration of migrations) {
    if (done.has(migration.name)) continue
    const statements: Statement[] = splitStatements(migration.sql).map((text) => sql(text))
    statements.push(sql(`INSERT INTO ${table} (name, sha256, applied_at) VALUES (?, ?, ?)`, migration.name, known.get(migration.name)!, now))
    await db.batch(statements)
    newlyApplied.push(migration.name)
  }
  return newlyApplied
}
