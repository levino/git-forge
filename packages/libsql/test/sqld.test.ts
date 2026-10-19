import { applyMigrations, createAccountsStore, MIGRATIONS, pendingMigrations, sql } from '@git-forge/accounts'
import { describe, expect, it } from 'vitest'
import { libsqlDatabase } from '../src/index.ts'
import { hostFetch, sqldAvailable, sqldDatabase } from './sqld.ts'

describe.skipIf(!sqldAvailable())('libSQL adapter against a local sqld', () => {
  it('applies every migration once and serves the accounts store', async () => {
    const db = await sqldDatabase()
    expect(await applyMigrations(db, MIGRATIONS)).toEqual(MIGRATIONS.map((migration) => migration.name))
    expect(await applyMigrations(db, MIGRATIONS)).toEqual([])
    expect(await pendingMigrations(db, MIGRATIONS)).toEqual([])
    const store = createAccountsStore(db)
    const user = await store.createUser({ login: 'Anna' })
    expect(await store.findAccount('anna')).toMatchObject({ id: user.id, login: 'Anna' })
  }, 60_000)

  it('round-trips values and rolls a failed batch back completely', async () => {
    const db = await sqldDatabase()
    await db.run(sql('CREATE TABLE t (a INTEGER PRIMARY KEY, b, c)'))
    await db.batch([sql('INSERT INTO t VALUES (?, ?, ?)', 1, 2.5, new Uint8Array([1, 2])), sql('INSERT INTO t VALUES (?, ?, ?)', 2, 2n ** 60n, null)])
    await expect(db.batch([sql('INSERT INTO t VALUES (3, 0, 0)'), sql('INSERT INTO t VALUES (1, 0, 0)')])).rejects.toThrow(/UNIQUE constraint failed/)
    expect(await db.all(sql('SELECT a, b, c FROM t ORDER BY a'))).toEqual([
      { a: 1, b: 2.5, c: new Uint8Array([1, 2]) },
      { a: 2, b: 2n ** 60n, c: null },
    ])
    expect(await db.run(sql('UPDATE t SET c = ? WHERE a > 0', 'x'))).toEqual({ changes: 2 })
    expect(await db.all(sql('UPDATE t SET b = b WHERE a = 2 RETURNING a'))).toEqual([{ a: 2 }])
    expect(await db.all(sql('PRAGMA foreign_keys'))).toEqual([{ foreign_keys: 1 }])
  })

  it('rejects requests without a valid token', async () => {
    await expect(libsqlDatabase({ url: process.env.SQLD_TEST_URL!, authToken: 'wrong', fetch: hostFetch('default.localhost') }).all(sql('SELECT 1'))).rejects.toThrow(/libSQL 401/)
  })
})
