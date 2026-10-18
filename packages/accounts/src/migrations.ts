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

const checkOrder = (migrations: readonly Migration[]): void => {
  for (const [index, migration] of migrations.entries()) {
    if (!MIGRATION_NAME.test(migration.name)) throw new MigrationError(`invalid migration name ${migration.name}`)
    if (index > 0 && migrations[index - 1]!.name >= migration.name) throw new MigrationError(`migrations out of order at ${migration.name}`)
  }
}

const hashes = async (migrations: readonly Migration[]): Promise<Map<string, string>> =>
  new Map(await Promise.all(migrations.map(async (migration) => [migration.name, await sha256Hex(migration.sql)] as const)))

const checkApplied = (applied: readonly AppliedRow[], known: ReadonlyMap<string, string>): void => {
  for (const row of applied) {
    const hash = known.get(row.name)
    if (hash === undefined) throw new MigrationError(`database has unknown migration ${row.name}`)
    if (hash !== row.sha256) throw new MigrationError(`applied migration ${row.name} was modified`)
  }
}

export const pendingMigrations = async (db: Database, migrations: readonly Migration[]): Promise<string[]> => {
  checkOrder(migrations)
  const table = await db.all<{ name: string }>(sql("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"))
  const applied = table.length > 0 ? await db.all<AppliedRow>(sql('SELECT name, sha256 FROM schema_migrations ORDER BY name')) : []
  checkApplied(applied, await hashes(migrations))
  const done = new Set(applied.map((row) => row.name))
  return migrations.filter((migration) => !done.has(migration.name)).map((migration) => migration.name)
}

export const applyMigrations = async (db: Database, migrations: readonly Migration[], now: number = Date.now()): Promise<string[]> => {
  checkOrder(migrations)
  await db.run(sql('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL)'))
  const applied = await db.all<AppliedRow>(sql('SELECT name, sha256 FROM schema_migrations ORDER BY name'))
  const known = await hashes(migrations)
  checkApplied(applied, known)
  const done = new Set(applied.map((row) => row.name))
  const newlyApplied: string[] = []
  for (const migration of migrations) {
    if (done.has(migration.name)) continue
    const statements: Statement[] = splitStatements(migration.sql).map((text) => sql(text))
    statements.push(sql('INSERT INTO schema_migrations (name, sha256, applied_at) VALUES (?, ?, ?)', migration.name, known.get(migration.name)!, now))
    await db.batch(statements)
    newlyApplied.push(migration.name)
  }
  return newlyApplied
}

export const adoptWranglerMigrations = async (db: Database, migrations: readonly Migration[], now: number = Date.now()): Promise<string[]> => {
  const table = await db.all<{ name: string }>(sql("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'"))
  if (table.length === 0) return []
  const rows = await db.all<{ name: string }>(sql('SELECT name FROM d1_migrations'))
  const known = await hashes(migrations)
  const names = rows.map((row) => row.name.replace(/\.sql$/, '')).filter((name) => known.has(name))
  if (names.length === 0) return []
  await db.run(sql('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL)'))
  await db.batch(names.map((name) => sql('INSERT INTO schema_migrations (name, sha256, applied_at) VALUES (?, ?, ?) ON CONFLICT (name) DO NOTHING', name, known.get(name)!, now)))
  return names
}

export const migrateOnStart = async (db: Database, migrations: readonly Migration[]): Promise<string[]> => {
  await adoptWranglerMigrations(db, migrations)
  try {
    return await applyMigrations(db, migrations)
  } catch (error) {
    if ((await pendingMigrations(db, migrations)).length === 0) return []
    throw error
  }
}
