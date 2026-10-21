import { applyMigrations, createStateCache, lockedStorage, MIGRATIONS, sql, StorageLockTimeoutError } from '@git-forge/accounts'
import { fromUtf8, MemoryStorage, readAll, stateCachedStorage, type Storage, utf8 } from '@git-forge/core'
import { describeStorageConformance } from '@git-forge/core/test/storage-conformance.ts'
import { makeS3TestStorage, s3TestConfig } from '@git-forge/s3/test/env.ts'
import { describe, expect, it } from 'vitest'
import { testDatabase } from './database.ts'

const ignoringConditions = (storage: Storage): Storage => ({
  get: (key, range) => storage.get(key, range),
  head: async (key) => {
    await new Promise((resolve) => setTimeout(resolve, 1))
    return storage.head(key)
  },
  put: async (key, body, size, options) => {
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 3))
    return storage.put(key, body, size, options?.contentType ? { contentType: options.contentType } : {})
  },
  list: (prefix) => storage.list(prefix),
})

const migrated = async () => {
  const db = await testDatabase()
  await applyMigrations(db, MIGRATIONS)
  return db
}

describeStorageConformance('lockedStorage over a storage that ignores conditions', async () => lockedStorage(ignoringConditions(new MemoryStorage()), await migrated()))

if (s3TestConfig) describeStorageConformance(`lockedStorage over S3Storage (${s3TestConfig.endpoint})`, async () => lockedStorage(makeS3TestStorage({ listPageSize: 7 }), await migrated()))

describe('lockedStorage', () => {
  it('is needed: the storage alone lets every concurrent writer win', async () => {
    const storage = ignoringConditions(new MemoryStorage())
    const results = await Promise.all([1, 2, 3].map((i) => storage.put('k', utf8(`v${i}`), 2, { ifNoneMatch: '*' })))
    expect(results.filter((result) => result.ok)).toHaveLength(3)
  })

  it('takes over an expired lock and times out on a held one', async () => {
    const db = await migrated()
    const clock = { now: 1_000_000 }
    await db.run(sql("INSERT INTO storage_locks (key, holder, expires_at) VALUES ('refs.json', 'crashed', ?)", clock.now + 1000))
    const storage = lockedStorage(new MemoryStorage(), db, { leaseMs: 1000, waitMs: 0, now: () => clock.now })
    await expect(storage.put('refs.json', utf8('{}'), 2, { ifNoneMatch: '*' })).rejects.toThrow(StorageLockTimeoutError)
    clock.now += 1000
    expect((await storage.put('refs.json', utf8('{}'), 2, { ifNoneMatch: '*' })).ok).toBe(true)
    expect(await db.all(sql('SELECT key FROM storage_locks'))).toEqual([])
  })

  it('takes the lease for state keys in the state cache and checks the cached etag', async () => {
    const db = await migrated()
    const statements: string[] = []
    const counted = { ...db, batch: (batch: Parameters<typeof db.batch>[0]) => (statements.push('batch'), db.batch(batch)), run: (statement: Parameters<typeof db.run>[0]) => (statements.push('run'), db.run(statement)) }
    const storage = stateCachedStorage(lockedStorage(ignoringConditions(new MemoryStorage()), db), createStateCache(counted, { locks: {} }))
    const key = 'repos/a/b/refs.json'
    expect((await storage.put(key, utf8('v0'), 2, { ifNoneMatch: '*' })).ok).toBe(true)
    const first = await storage.get(key)
    statements.length = 0
    const results = await Promise.all([1, 2, 3].map((i) => storage.put(key, utf8(`v${i}`), 2, { ifMatch: first!.etag })))
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    const winner = results.findIndex((result) => result.ok) + 1
    expect(fromUtf8(await readAll((await storage.get(key))!.body))).toBe(`v${winner}`)
    expect((await storage.put(key, utf8('v9'), 2, { ifNoneMatch: '*' })).ok).toBe(false)
    const current = await storage.get(key)
    statements.length = 0
    expect((await storage.put(key, utf8('v8'), 2, { ifMatch: current!.etag })).ok).toBe(true)
    expect(statements).toEqual(['batch', 'batch'])
    expect(await db.all(sql('SELECT key FROM storage_locks'))).toEqual([])
  })
})
