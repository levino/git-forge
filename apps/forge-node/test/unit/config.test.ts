import { describe, expect, it } from 'vitest'
import { DEFAULT_JOB_CONCURRENCY, parseNodeConfig } from '../../src/config.ts'

describe('node configuration', () => {
  it('defaults to a local data directory with file storage and the Worker schedule', () => {
    const config = parseNodeConfig({})
    expect(config).toMatchObject({
      port: 8080,
      host: '0.0.0.0',
      trustProxy: false,
      database: { kind: 'sqlite', path: './data/git-forge.sqlite' },
      conditionalWrites: 'storage',
      storage: { kind: 'fs', dir: './data/objects' },
      jobConcurrency: DEFAULT_JOB_CONCURRENCY,
    })
    expect(config.schedule.source).toBe('17 3 * * *')
  })

  it('derives paths from DATA_DIR unless set explicitly', () => {
    expect(parseNodeConfig({ DATA_DIR: '/srv/forge/' })).toMatchObject({ database: { path: '/srv/forge/git-forge.sqlite' }, storage: { dir: '/srv/forge/objects' } })
    expect(parseNodeConfig({ DATA_DIR: '/srv/forge', DATABASE_PATH: '/var/db.sqlite', STORAGE_DIR: '/mnt/ssd' })).toMatchObject({
      database: { kind: 'sqlite', path: '/var/db.sqlite' },
      storage: { kind: 'fs', dir: '/mnt/ssd' },
    })
  })

  it('selects libSQL and database-backed conditional writes', () => {
    expect(parseNodeConfig({ DATABASE: 'libsql', LIBSQL_URL: 'libsql://forge.example', LIBSQL_AUTH_TOKEN: 'token', CONDITIONAL_WRITES: 'database' })).toMatchObject({
      database: { kind: 'libsql', url: 'libsql://forge.example', authToken: 'token' },
      conditionalWrites: 'database',
    })
    expect(parseNodeConfig({ DATABASE: 'libsql', LIBSQL_URL: 'https://db.example' }).database).toEqual({ kind: 'libsql', url: 'https://db.example' })
    expect(() => parseNodeConfig({ DATABASE: 'libsql' })).toThrow('LIBSQL_URL is required with DATABASE=libsql')
    expect(() => parseNodeConfig({ DATABASE: 'libsql', LIBSQL_URL: 'forge.db' })).toThrow('LIBSQL_URL must be')
    expect(() => parseNodeConfig({ DATABASE: 'postgres' })).toThrow('DATABASE must be sqlite or libsql')
    expect(() => parseNodeConfig({ CONDITIONAL_WRITES: 'none' })).toThrow('CONDITIONAL_WRITES must be storage or database')
  })

  it('configures S3 storage from S3_* variables', () => {
    const vars = {
      STORAGE: 's3',
      S3_ENDPOINT: 'https://fsn1.your-objectstorage.com',
      S3_REGION: 'fsn1',
      S3_BUCKET: 'backup',
      S3_ACCESS_KEY_ID: 'id',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_PREFIX: 'forge/',
    }
    expect(parseNodeConfig(vars).storage).toEqual({
      kind: 's3',
      config: { endpoint: 'https://fsn1.your-objectstorage.com', region: 'fsn1', bucket: 'backup', accessKeyId: 'id', secretAccessKey: 'secret', forcePathStyle: false, prefix: 'forge/' },
    })
    expect(() => parseNodeConfig({ ...vars, S3_BUCKET: '' })).toThrow('S3_BUCKET is required with STORAGE=s3')
    expect(() => parseNodeConfig({ ...vars, S3_ENDPOINT: 'nope' })).toThrow('S3_ENDPOINT must be a URL')
  })

  it('configures email delivery over SMTP', () => {
    const base = { EMAIL_PROVIDER: 'smtp', EMAIL_FROM: 'Forge <forge@example.org>', SMTP_HOST: 'smtp.example.org' }
    expect(parseNodeConfig(base).email).toEqual({ provider: 'smtp', from: 'Forge <forge@example.org>', host: 'smtp.example.org', security: 'starttls' })
    expect(parseNodeConfig({ ...base, SMTP_SECURITY: 'tls', SMTP_PORT: '2465', SMTP_USERNAME: 'forge', SMTP_PASSWORD: ' pw ', SMTP_HELO: 'pi.example.org' }).email).toEqual({
      provider: 'smtp',
      from: 'Forge <forge@example.org>',
      host: 'smtp.example.org',
      security: 'tls',
      port: 2465,
      username: 'forge',
      password: ' pw ',
      helo: 'pi.example.org',
    })
    expect(parseNodeConfig({ EMAIL_PROVIDER: 'console', EMAIL_FROM: 'forge@example.org' }).email).toEqual({ provider: 'console', from: 'forge@example.org' })
    expect(parseNodeConfig({}).email).toBeUndefined()
    expect(() => parseNodeConfig({ ...base, SMTP_HOST: '' })).toThrow('SMTP_HOST is required with EMAIL_PROVIDER=smtp')
    expect(() => parseNodeConfig({ ...base, EMAIL_FROM: '' })).toThrow(/EMAIL_FROM is required/)
    expect(() => parseNodeConfig({ ...base, SMTP_SECURITY: 'ssl' })).toThrow(/SMTP_SECURITY must be/)
    expect(() => parseNodeConfig({ ...base, SMTP_PORT: '0' })).toThrow(/SMTP_PORT/)
    expect(() => parseNodeConfig({ ...base, SMTP_USERNAME: 'forge' })).toThrow(/go together/)
    expect(() => parseNodeConfig({ ...base, SMTP_SECURITY: 'none', SMTP_USERNAME: 'forge', SMTP_PASSWORD: 'pw' })).toThrow(/needs SMTP_SECURITY/)
    expect(() => parseNodeConfig({ EMAIL_PROVIDER: 'sendmail', EMAIL_FROM: 'forge@example.org' })).toThrow('EMAIL_PROVIDER must be none, console, ses or smtp')
  })

  it('rejects invalid values instead of guessing', () => {
    expect(() => parseNodeConfig({ PORT: '70000' })).toThrow(/PORT/)
    expect(() => parseNodeConfig({ STORAGE: 'r2' })).toThrow(/STORAGE must be fs or s3/)
    expect(() => parseNodeConfig({ TRUST_PROXY: 'yes' })).toThrow(/TRUST_PROXY/)
    expect(() => parseNodeConfig({ SCHEDULE: 'daily' })).toThrow(/SCHEDULE/)
    expect(() => parseNodeConfig({ JOB_CONCURRENCY: '0' })).toThrow(/JOB_CONCURRENCY/)
  })
})
