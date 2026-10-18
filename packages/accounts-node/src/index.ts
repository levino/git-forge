import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { Database, Row, RunResult, Statement } from '@git-forge/accounts'

const bind = (statement: Statement): SQLInputValue[] => statement.params as SQLInputValue[]

export const nodeSqliteDatabase = (db: DatabaseSync): Database => {
  const runSync = (statement: Statement): RunResult => ({ changes: Number(db.prepare(statement.sql).run(...bind(statement)).changes) })
  return {
    all: async <T extends Row>(statement: Statement) => db.prepare(statement.sql).all(...bind(statement)) as T[],
    run: async (statement) => runSync(statement),
    batch: async (statements) => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const results = statements.map(runSync)
        db.exec('COMMIT')
        return results
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
}

export const openSqliteDatabase = (path = ':memory:'): { readonly db: Database; readonly handle: DatabaseSync } => {
  const handle = new DatabaseSync(path)
  handle.exec('PRAGMA foreign_keys = ON')
  if (path !== ':memory:') handle.exec('PRAGMA journal_mode = WAL')
  handle.exec('PRAGMA busy_timeout = 5000')
  return { db: nodeSqliteDatabase(handle), handle }
}
