import { describe, expect, it } from 'vitest'
import { DEFAULT_JOB_CONCURRENCY, parseNodeConfig } from '../../src/config.ts'

describe('node configuration', () => {
  it('defaults to a local data directory with file storage and the Worker schedule', () => {
    const config = parseNodeConfig({})
    expect(config).toMatchObject({
      port: 8080,
      host: '0.0.0.0',
      trustProxy: false,
      databasePath: './data/git-forge.sqlite',
      storage: { kind: 'fs', dir: './data/objects' },
      jobConcurrency: DEFAULT_JOB_CONCURRENCY,
    })
    expect(config.schedule.source).toBe('17 3 * * *')
  })

  it('derives paths from DATA_DIR unless set explicitly', () => {
    expect(parseNodeConfig({ DATA_DIR: '/srv/forge/' })).toMatchObject({ databasePath: '/srv/forge/git-forge.sqlite', storage: { dir: '/srv/forge/objects' } })
    expect(parseNodeConfig({ DATA_DIR: '/srv/forge', DATABASE_PATH: '/var/db.sqlite', STORAGE_DIR: '/mnt/ssd' })).toMatchObject({
      databasePath: '/var/db.sqlite',
      storage: { kind: 'fs', dir: '/mnt/ssd' },
    })
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

  it('rejects invalid values instead of guessing', () => {
    expect(() => parseNodeConfig({ PORT: '70000' })).toThrow(/PORT/)
    expect(() => parseNodeConfig({ STORAGE: 'r2' })).toThrow(/STORAGE must be fs or s3/)
    expect(() => parseNodeConfig({ TRUST_PROXY: 'yes' })).toThrow(/TRUST_PROXY/)
    expect(() => parseNodeConfig({ SCHEDULE: 'daily' })).toThrow(/SCHEDULE/)
    expect(() => parseNodeConfig({ JOB_CONCURRENCY: '0' })).toThrow(/JOB_CONCURRENCY/)
  })
})
