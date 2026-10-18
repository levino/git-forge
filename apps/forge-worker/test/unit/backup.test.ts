import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyMigrations, MIGRATIONS } from '@git-forge/accounts'
import { openSqliteDatabase } from '@git-forge/accounts-node'
import { createMemoryJobQueue, javascriptDigests, MemoryStorage, readAll, sha256Hex, type Storage } from '@git-forge/core'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppJob } from '../../src/app.ts'
import { type BackupStatus, backupStep, restoreBackup, restoreSql, startBackup } from '../../src/backup.ts'
import { git, tempDir } from '../e2e/history.ts'
import { bootstrap, call, type NodeForge, nodeForge } from '../support/node-forge.ts'

const lfsGit = (cwd: string, args: readonly string[]) =>
  git(cwd, [
    ...[
      ['filter.lfs.process', 'git-lfs filter-process'],
      ['filter.lfs.smudge', 'git-lfs smudge -- %f'],
      ['filter.lfs.clean', 'git-lfs clean -- %f'],
      ['filter.lfs.required', 'true'],
      ['lfs.locksverify', 'false'],
    ].flatMap(([key, value]) => ['-c', `${key}=${value}`]),
    ...args,
  ])

const objects = async (storage: Storage, skip: RegExp) => {
  const found: string[] = []
  for await (const info of storage.list('')) if (!skip.test(info.key)) found.push(`${info.key} ${info.etag}`)
  return found
}

const text = async (storage: Storage, key: string) => new TextDecoder().decode(await readAll((await storage.get(key))!.body))

let server: RunningServer
let forge: NodeForge
let token: string
let source: string
let handler: (request: Request) => Promise<Response> = async () => new Response('starting', { status: 503 })
class LockedStorage extends MemoryStorage {
  override async put(...args: Parameters<MemoryStorage['put']>) {
    if (await this.head(args[0])) throw new Error(`${args[0]} is locked`)
    return super.put(...args)
  }
}

const target = new LockedStorage()
const jobs = createMemoryJobQueue<AppJob>((job) => forge.runJob(job), { delayMs: () => 0, maxAttempts: 2 })
const blob = Uint8Array.from({ length: 200_000 }, (_, i) => (i * 7919) % 251)
const remote = () => `${server.url.replace('http://', `http://git:${token}@`)}/ada/photos.git`

const status = async (): Promise<BackupStatus> => (await call(forge, server.url, 'GET', '/api/admin/backup', token)).json() as Promise<BackupStatus>

beforeAll(async () => {
  server = await startServer((request) => handler(request))
  forge = await nodeForge({ backup: target, jobs, backupBudget: { maxBytes: 64 * 1024, maxKeys: 8 } })
  handler = forge.fetch
  token = await bootstrap(forge, server.url, 'ada')
  expect((await call(forge, server.url, 'POST', '/api/repos', token, { owner: 'ada', name: 'photos' })).status).toBe(201)
  source = tempDir()
  await git(source, ['init', '-q', '-b', 'main'])
  await lfsGit(source, ['lfs', 'track', '*.bin'])
  writeFileSync(join(source, 'photo.bin'), blob)
  writeFileSync(join(source, 'README.md'), '# Photos\n')
  await lfsGit(source, ['add', '-A'])
  await lfsGit(source, ['commit', '-q', '-m', 'first'])
  await lfsGit(source, ['push', '-q', remote(), 'main'])
  expect((await call(forge, server.url, 'POST', '/api/v3/repos/ada/photos/issues', token, { title: 'Shutter jams', body: 'In the cold.' })).status).toBe(201)
})

afterAll(() => server.close())

describe('backup job', () => {
  it('copies the database and every object in bounded steps on the scheduled run', async () => {
    expect((await status()).enabled).toBe(true)
    await forge.scheduled()
    await jobs.idle()
    expect(jobs.failed).toEqual([])
    expect(jobs.completed.length).toBeGreaterThan(3)
    const done = await status()
    expect(done).toMatchObject({ run: null, error: null })
    expect(done.last?.objects).toBeGreaterThan(5)
    expect(done.stored.bytes).toBeGreaterThan(blob.length)
    expect(await objects(target, /^backups\//)).toEqual(await objects(forge.storage, /^tmp\//))
    const manifest = JSON.parse(await text(target, `backups/db/${done.last!.id}/manifest.json`)) as { format: number }
    expect(manifest.format).toBe(1)
    const verify = await call(forge, server.url, 'POST', '/api/admin/backup/verify', token, { sample: 1000 })
    expect(verify.status).toBe(200)
    expect(await verify.json()).toMatchObject({ failures: [] })
  })

  it('runs again on request and copies only what changed', async () => {
    writeFileSync(join(source, 'README.md'), '# Photos\n\nSecond.\n')
    await lfsGit(source, ['commit', '-q', '-am', 'second'])
    await lfsGit(source, ['push', '-q', remote(), 'main'])
    const before = (await status()).last!
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect((await call(forge, server.url, 'POST', '/api/admin/backup', token)).status).toBe(202)
    await jobs.idle()
    const after = (await status()).last!
    expect(after.id).not.toBe(before.id)
    expect(after.objects).toBeLessThan(before.objects)
    const changed = await objects(target, /^(?!backups\/changed\/)/)
    expect(changed.length).toBeGreaterThan(0)
    expect(changed.every((entry) => entry.startsWith(`backups/changed/${after.id}/`))).toBe(true)
  })

  it('is for instance admins only and records failures', async () => {
    expect((await call(forge, server.url, 'GET', '/api/admin/backup')).status).toBe(401)
    const { db } = openSqliteDatabase()
    await applyMigrations(db, MIGRATIONS)
    const broken = Object.assign(new MemoryStorage(), { put: async () => Promise.reject(new Error('bucket unavailable')) })
    await startBackup(db, new Date())
    await expect(backupStep({ db, source: forge.storage, target: broken, digests: javascriptDigests, now: () => new Date() })).rejects.toThrow('bucket unavailable')
    const row = await db.all<{ state: string }>({ sql: 'SELECT state FROM backup_state', params: [] })
    expect(JSON.parse(row[0]!.state)).toMatchObject({ run: { phase: 'dump' }, error: { message: 'bucket unavailable' } })
  })
})

describe('restore', () => {
  it('builds a fresh instance from the backup target that clones with LFS like the original', async () => {
    const storage = new MemoryStorage()
    const { db } = openSqliteDatabase()
    const restored = await restoreBackup(target, storage, db, javascriptDigests)
    expect(restored.statements).toBeGreaterThan(20)
    expect(await applyMigrations(db, MIGRATIONS)).toEqual([])
    expect(await objects(storage, /^$/)).toEqual(await objects(forge.storage, /^tmp\//))
    const copy = await nodeForge({ storage, db })
    const copyServer = await startServer((request) => copy.fetch(request))
    try {
      const out = tempDir()
      await lfsGit(out, ['clone', '-q', `${copyServer.url.replace('http://', `http://git:${token}@`)}/ada/photos.git`, 'photos'])
      expect((await git(join(out, 'photos'), ['rev-parse', 'HEAD'])).trim()).toBe((await git(source, ['rev-parse', 'HEAD'])).trim())
      expect(await sha256Hex(readFileSync(join(out, 'photos', 'photo.bin')))).toBe(await sha256Hex(blob))
      expect(readFileSync(join(out, 'photos', 'README.md'), 'utf8')).toContain('Second.')
      const search = async (path: string) => ((await call(copy, copyServer.url, 'GET', path, token)).json() as Promise<{ total_count: number }>)
      expect(await search('/api/v3/search/issues?q=shutter')).toMatchObject({ total_count: 1 })
      expect(await search('/api/v3/search/repositories?q=photos')).toMatchObject({ total_count: 1 })
      expect(await search('/api/v3/search/users?q=ada')).toMatchObject({ total_count: 1 })
    } finally {
      await copyServer.close()
    }
    let sqlText = ''
    for await (const chunk of restoreSql(target)) sqlText += new TextDecoder().decode(chunk)
    const { handle } = openSqliteDatabase()
    handle.exec(sqlText)
    expect(handle.prepare('SELECT login FROM accounts').all()).toEqual(expect.arrayContaining([expect.objectContaining({ login: 'ada' })]))
    expect(handle.prepare("SELECT rowid FROM search_issues WHERE search_issues MATCH 'shutter'").all()).toHaveLength(1)
    await expect(restoreBackup(target, new MemoryStorage(), db, javascriptDigests)).rejects.toThrow('empty database')
  })
})
