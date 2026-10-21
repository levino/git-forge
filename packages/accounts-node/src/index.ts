import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { BatchResult, Database, Row, Statement } from '@git-forge/accounts'

const bind = (statement: Statement): SQLInputValue[] => statement.params as SQLInputValue[]

export const nodeSqliteDatabase = (db: DatabaseSync): Database => {
  const all = (statement: Statement) => db.prepare(statement.sql).all(...bind(statement)) as Row[]
  const count = (query: string) => Number((db.prepare(query).get() as { n: number }).n)
  const step = (statement: Statement): BatchResult => {
    const before = count('SELECT total_changes() AS n')
    const rows = all(statement)
    return { changes: count('SELECT total_changes() AS n') === before ? 0 : count('SELECT changes() AS n'), rows }
  }
  return {
    all: async <T extends Row>(statement: Statement) => all(statement) as T[],
    run: async (statement) => ({ changes: Number(db.prepare(statement.sql).run(...bind(statement)).changes) }),
    batch: async (statements) => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const results = statements.map(step)
        db.exec('COMMIT')
        return results
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    read: async (statements) => statements.map(all),
  }
}

export const openSqliteDatabase = (path = ':memory:'): { readonly db: Database; readonly handle: DatabaseSync } => {
  const handle = new DatabaseSync(path)
  handle.exec('PRAGMA foreign_keys = ON')
  if (path !== ':memory:') handle.exec('PRAGMA journal_mode = WAL')
  handle.exec('PRAGMA busy_timeout = 5000')
  return { db: nodeSqliteDatabase(handle), handle }
}
