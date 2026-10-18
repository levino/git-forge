import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIGRATIONS } from '@git-forge/accounts'
import { describeStorageConformance } from '@git-forge/core/test/storage-conformance.ts'
import { FsStorage } from '@git-forge/node'
import { S3Storage } from '@git-forge/s3'
import { afterAll, describe, expect, it } from 'vitest'
import { main } from '../../src/cli.ts'
import { createInstance, migrate, openStorage, PendingMigrationsError } from '../../src/instance.ts'

const root = mkdtempSync(join(tmpdir(), 'git-forge-node-'))
const fresh = () => mkdtempSync(join(root, 'case-'))

afterAll(() => rm(root, { recursive: true, force: true }))

describeStorageConformance('FsStorage from STORAGE=fs', () => openStorage({ kind: 'fs', dir: fresh() }), { paginationKeys: 1005 })

describe('node instance', () => {
  it('refuses to serve before the migrate command ran and applies migrations only there', async () => {
    const DATA_DIR = fresh()
    await expect(createInstance({ DATA_DIR })).rejects.toThrow(PendingMigrationsError)
    expect(await migrate({ DATA_DIR })).toEqual(MIGRATIONS.map((migration) => migration.name))
    expect(await migrate({ DATA_DIR })).toEqual([])
    const instance = await createInstance({ DATA_DIR, BOOTSTRAP_TOKEN: 'secret' }, { log: () => undefined })
    try {
      expect(instance.storage).toBeInstanceOf(FsStorage)
      const response = await instance.forge.fetch(
        new Request('http://forge.test/api/bootstrap', { method: 'POST', headers: { Authorization: 'Bearer secret' }, body: JSON.stringify({ login: 'pi' }) }),
      )
      expect(response.status).toBe(201)
      const { token } = (await response.json()) as { token: string }
      const created = await instance.forge.fetch(
        new Request('http://forge.test/api/repos', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ owner: 'pi', name: 'backup' }) }),
      )
      expect(created.status).toBe(201)
      expect(await instance.storage.head('repos/pi/backup/git/HEAD')).not.toBeNull()
    } finally {
      await instance.close()
    }
  })

  it('opens S3 storage from the configuration', async () => {
    const storage = await openStorage({ kind: 's3', config: { endpoint: 'https://s3.example', region: 'eu', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' } })
    expect(storage).toBeInstanceOf(S3Storage)
  })

  it('exits with a message on configuration errors and pending migrations', async () => {
    const DATA_DIR = fresh()
    const stderr: string[] = []
    const write = process.stderr.write
    process.stderr.write = ((chunk: string) => (stderr.push(chunk), true)) as typeof process.stderr.write
    try {
      expect(await main(['serve'], { DATA_DIR })).toBe(2)
      expect(await main(['migrate'], { DATA_DIR, STORAGE: 'nope' })).toBe(2)
      expect(await main(['migrate'], { DATA_DIR }, () => undefined)).toBe(0)
      expect(await main(['bogus'], { DATA_DIR })).toBe(1)
    } finally {
      process.stderr.write = write
    }
    expect(stderr[0]).toMatch(/pending migrations .*run the migrate command first/)
    expect(stderr[1]).toMatch(/STORAGE must be fs or s3/)
    expect(stderr[2]).toMatch(/unknown command bogus/)
  })
})
