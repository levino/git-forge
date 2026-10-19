import type { Database } from '@git-forge/accounts'
import { sqldDatabase } from '@git-forge/libsql/test/sqld.ts'
import { openSqliteDatabase } from '../src/index.ts'

export const testDatabase = async (): Promise<Database> => (process.env.ACCOUNTS_TEST_DATABASE === 'libsql' ? sqldDatabase() : openSqliteDatabase().db)
