import { defineConfig } from 'vitest/config'

export default defineConfig({ test: process.env.ACCOUNTS_TEST_DATABASE === 'libsql' ? { globalSetup: ['../libsql/test/global-setup.ts'], testTimeout: 30_000 } : {} })
