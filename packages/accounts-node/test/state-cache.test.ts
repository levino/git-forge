import { applyMigrations, createStateCache, MIGRATIONS } from '@git-forge/accounts'
import { stateCacheConformance } from '@git-forge/core/test/state-cache-conformance.ts'
import { openSqliteDatabase } from '../src/index.ts'

stateCacheConformance('sqlite', async (now) => {
  const { db } = openSqliteDatabase(':memory:')
  await applyMigrations(db, MIGRATIONS)
  return createStateCache(db, now)
})
