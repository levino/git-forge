import { readAll, streamOf, utf8 } from '@git-forge/core'
import { describeStorageConformance } from '@git-forge/core/test/storage-conformance.ts'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FS_STORAGE_RESERVED, FsStorage } from '../src/fs-storage.ts'

const root = mkdtempSync(join(tmpdir(), 'git-forge-fs-storage-'))
const fresh = (): string => mkdtempSync(join(root, 'case-'))
const lockPath = (dir: string, key: string): string => join(dir, FS_STORAGE_RESERVED, 'locks', createHash('sha256').update(key).digest('hex'))

afterAll(() => rm(root, { recursive: true, force: true }))

describeStorageConformance('FsStorage', () => new FsStorage(root), { paginationKeys: 1005 })

describe('FsStorage specifics', () => {
  it('stores each key as a plain file under the root', async () => {
    const dir = fresh()
    const storage = new FsStorage(dir)
    await storage.put('repo/git/HEAD', utf8('ref: refs/heads/main\n'), 21)
    expect(await readFile(join(dir, 'repo', 'git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n')
  })

  it('reads files that were written by other tools', async () => {
    const dir = fresh()
    await mkdir(join(dir, 'a'), { recursive: true })
    await writeFile(join(dir, 'a', 'b'), 'outside')
    const storage = new FsStorage(dir)
    const object = await storage.get('a/b')
    expect(object && new TextDecoder().decode(await readAll(object.body))).toBe('outside')
  })

  it('hides its working directory from listings and rejects keys inside it', async () => {
    const dir = fresh()
    const storage = new FsStorage(dir)
    await storage.put('x', utf8('1'), 1, { ifNoneMatch: '*' })
    const keys = []
    for await (const info of storage.list('')) keys.push(info.key)
    expect(keys).toEqual(['x'])
    await expect(storage.put(`${FS_STORAGE_RESERVED}/tmp/y`, utf8('1'), 1)).rejects.toThrow(/invalid storage key/)
  })

  it('rejects keys that would escape the root', async () => {
    const storage = new FsStorage(fresh())
    for (const key of ['', '/abs', 'a//b', 'a/../b', '..', './a', 'a/', 'a\\b']) {
      await expect(storage.put(key, utf8('1'), 1)).rejects.toThrow(/invalid storage key/)
      await expect(storage.head(key)).rejects.toThrow(/invalid storage key/)
    }
  })

  it('leaves no temporary files behind after failed puts', async () => {
    const dir = fresh()
    const storage = new FsStorage(dir)
    await expect(storage.put('short', streamOf(utf8('abc')), 10)).rejects.toThrow()
    await storage.put('once', utf8('1'), 1, { ifNoneMatch: '*' })
    expect(await storage.put('once', utf8('2'), 1, { ifNoneMatch: '*' })).toEqual({ ok: false, reason: 'precondition-failed' })
    expect(await readdir(join(dir, FS_STORAGE_RESERVED, 'tmp'))).toEqual([])
  })

  it('serializes compare-and-swap across separate instances on the same root', async () => {
    const dir = fresh()
    const first = await new FsStorage(dir).put('ref', utf8('base'), 4)
    if (!first.ok) throw new Error('put failed')
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) => new FsStorage(dir).put('ref', utf8(`writer-${i}`), `writer-${i}`.length, { ifMatch: first.info.etag })),
    )
    expect(results.filter((result) => result.ok)).toHaveLength(1)
  })

  it('breaks a stale lock left behind by a crashed writer', async () => {
    const dir = fresh()
    const storage = new FsStorage(dir, { staleLockMs: 1000, lockTimeoutMs: 5000 })
    await storage.put('ref', utf8('v1'), 2)
    const lock = lockPath(dir, 'ref')
    await writeFile(lock, '')
    const past = new Date(Date.now() - 60_000)
    await utimes(lock, past, past)
    expect((await storage.put('ref', utf8('v2'), 2)).ok).toBe(true)
  })

  it('times out while another writer holds the lock', async () => {
    const dir = fresh()
    const storage = new FsStorage(dir, { lockTimeoutMs: 100 })
    await storage.put('ref', utf8('v1'), 2)
    await writeFile(lockPath(dir, 'ref'), '')
    await expect(storage.put('ref', utf8('v2'), 2)).rejects.toThrow(/timed out/)
    expect(await readdir(join(dir, FS_STORAGE_RESERVED, 'tmp'))).toEqual([])
  })
})
