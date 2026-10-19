import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIGRATIONS } from '@git-forge/accounts'
import { describeStorageConformance } from '@git-forge/core/test/storage-conformance.ts'
import { sqldAvailable } from '@git-forge/libsql/test/sqld.ts'
import { FsStorage, serve } from '@git-forge/node'
import { S3Storage } from '@git-forge/s3'
import { git, tempDir } from 'forge-worker/test/e2e/history.ts'
import { afterAll, describe, expect, it } from 'vitest'
import { main } from '../../src/cli.ts'
import { parseNodeConfig } from '../../src/config.ts'
import { createInstance, emailSender, migrate, openStorage, PendingMigrationsError } from '../../src/instance.ts'

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

  it('keeps queued jobs in the database across a restart', async () => {
    const DATA_DIR = fresh()
    await migrate({ DATA_DIR })
    const first = await createInstance({ DATA_DIR }, { log: () => undefined })
    await first.jobs.enqueue({ kind: 'mirror-sync', repository: 'pi/backup', remote: 'origin', reason: 'notification' }, { delaySeconds: 3600 })
    await first.imports.enqueue({ owner: 'pi', name: 'backup' }, { delaySeconds: 3600 })
    await first.close()
    const second = await createInstance({ DATA_DIR }, { log: () => undefined })
    try {
      expect(await second.jobs.pending()).toBe(1)
      expect(await second.imports.pending()).toBe(1)
    } finally {
      await second.close()
    }
  })

  it('backs up to BACKUP_STORAGE on the schedule and restores a fresh instance with the restore command', async () => {
    const backup = { BACKUP_STORAGE: 'fs', BACKUP_STORAGE_DIR: fresh() }
    const DATA_DIR = fresh()
    await migrate({ DATA_DIR })
    const instance = await createInstance({ DATA_DIR, BOOTSTRAP_TOKEN: 'secret', ...backup }, { log: () => undefined })
    let token = ''
    try {
      const response = await instance.forge.fetch(new Request('http://forge.test/api/bootstrap', { method: 'POST', headers: { Authorization: 'Bearer secret' }, body: JSON.stringify({ login: 'pi' }) }))
      token = ((await response.json()) as { token: string }).token
      await instance.forge.fetch(new Request('http://forge.test/api/repos', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ owner: 'pi', name: 'saved' }) }))
      await instance.forge.scheduled()
      await instance.jobs.idle()
      expect(await main(['backup-verify', '50'], { DATA_DIR, ...backup }, () => undefined)).toBe(0)
    } finally {
      await instance.close()
    }
    const RESTORED = fresh()
    const events: Record<string, unknown>[] = []
    expect(await main(['restore'], { DATA_DIR: RESTORED, ...backup }, (event) => void events.push(event))).toBe(0)
    expect(events[0]).toMatchObject({ event: 'restored', migrated: [] })
    const restored = await createInstance({ DATA_DIR: RESTORED }, { log: () => undefined })
    try {
      expect(await restored.storage.head('repos/pi/saved/git/HEAD')).not.toBeNull()
      const user = await restored.forge.fetch(new Request('http://forge.test/api/user', { headers: { Authorization: `Bearer ${token}` } }))
      expect(await user.json()).toMatchObject({ login: 'pi', admin: true })
    } finally {
      await restored.close()
    }
    await expect(main(['restore'], { DATA_DIR: RESTORED, ...backup }, () => undefined)).rejects.toThrow('empty database')
  })

  it.skipIf(!sqldAvailable())('runs on libSQL with conditional writes in the database and serves real git pushes', async () => {
    const env = {
      DATABASE: 'libsql',
      LIBSQL_URL: process.env.SQLD_TEST_DEFAULT_URL!,
      LIBSQL_AUTH_TOKEN: process.env.SQLD_TEST_TOKEN!,
      CONDITIONAL_WRITES: 'database',
      STORAGE_DIR: fresh(),
      BOOTSTRAP_TOKEN: 'secret',
    }
    expect(await main(['migrate'], env, () => undefined)).toBe(0)
    const instance = await createInstance(env, { log: () => undefined })
    const server = await serve(instance.forge.fetch)
    try {
      expect(instance.storage).not.toBeInstanceOf(FsStorage)
      const call = (path: string, token: string, body: unknown) => instance.forge.fetch(new Request(`${server.url}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }))
      const { token } = (await (await call('/api/bootstrap', 'secret', { login: 'bunny' })).json()) as { token: string }
      expect((await call('/api/repos', token, { owner: 'bunny', name: 'site' })).status).toBe(201)
      const source = tempDir()
      await git(source, ['init', '-q', '-b', 'main'])
      await git(source, ['-c', 'user.name=t', '-c', 'user.email=t@example.org', 'commit', '-q', '--allow-empty', '-m', 'first'])
      const remote = `${server.url.replace('http://', `http://git:${token}@`)}/bunny/site.git`
      await git(source, ['push', '-q', remote, 'main'])
      const clone = tempDir()
      await git(clone, ['clone', '-q', remote, 'out'])
      expect((await git(join(clone, 'out'), ['rev-parse', 'HEAD'])).trim()).toBe((await git(source, ['rev-parse', 'main'])).trim())
      expect(await instance.db.all({ sql: 'SELECT key FROM storage_locks', params: [] })).toEqual([])
    } finally {
      await server.close()
      await instance.close()
    }
  }, 60_000)

  it('sends email through SMTP when EMAIL_PROVIDER=smtp', () => {
    expect(emailSender(parseNodeConfig({ EMAIL_PROVIDER: 'smtp', EMAIL_FROM: 'forge@example.org', SMTP_HOST: 'mail.example.org' }).email)).toBeDefined()
    expect(emailSender(parseNodeConfig({ EMAIL_PROVIDER: 'console', EMAIL_FROM: 'forge@example.org' }).email)).toBeDefined()
    expect(emailSender(parseNodeConfig({}).email)).toBeUndefined()
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
