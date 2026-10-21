import { AsyncLocalStorage } from 'node:async_hooks'
import { type Database, requestScope, reused, type ScopeState, sql } from '@git-forge/accounts'
import { describe, expect, it } from 'vitest'
import { openSqliteDatabase } from '../src/index.ts'

const setup = () => {
  const { db } = openSqliteDatabase()
  const calls: string[] = []
  const counted: Database = {
    all: (statement) => (calls.push('all'), db.all(statement)),
    run: (statement) => (calls.push('run'), db.run(statement)),
    batch: (statements) => (calls.push('batch'), db.batch(statements)),
    read: (statements) => (calls.push(`read ${statements.length}`), db.read(statements)),
  }
  const scope = requestScope(new AsyncLocalStorage<ScopeState>())
  return { db, calls, scope, scoped: scope.database(counted) }
}

describe('requestScope', () => {
  it('sends concurrent reads as one batch and answers reused reads until a write to their table', async () => {
    const { db, calls, scope, scoped } = setup()
    await db.run(sql('CREATE TABLE a (x INTEGER)'))
    await db.run(sql('CREATE TABLE b (y INTEGER)'))
    await db.run(sql('INSERT INTO a VALUES (1)'))
    const result = await scope.run(async () => {
      const [first, second] = await Promise.all([scoped.all(reused(sql('SELECT x FROM a'))), scoped.all(sql('SELECT 2 AS z'))])
      const again = await scoped.all(reused(sql('SELECT x FROM a')))
      await scoped.run(sql('INSERT INTO b VALUES (1)'))
      const kept = await scoped.all(reused(sql('SELECT x FROM a')))
      await scoped.run(sql('INSERT INTO a VALUES (2)'))
      const fresh = await scoped.all(reused(sql('SELECT x FROM a')))
      return { first, second, again, kept, fresh }
    })
    expect(result).toEqual({ first: [{ x: 1 }], second: [{ z: 2 }], again: [{ x: 1 }], kept: [{ x: 1 }], fresh: [{ x: 1 }, { x: 2 }] })
    expect(calls).toEqual(['read 2', 'run', 'run', 'read 1'])
  })

  it('passes reads through outside a scope', async () => {
    const { calls, scoped } = setup()
    expect(await scoped.all(reused(sql('SELECT 1 AS one')))).toEqual([{ one: 1 }])
    expect(calls).toEqual(['all'])
  })
})
