import { describe, expect, it } from 'vitest'
import { readAll, utf8 } from '../src/bytes.ts'
import { MemoryStorage } from '../src/memory-storage.ts'
import { type CachedObject, cachedStorage } from '../src/object-cache.ts'
import { ObjectDatabase } from '../src/repository.ts'
import type { Storage } from '../src/storage.ts'
import { commitAll, initRepo, writeFile } from './git-helpers.ts'
import { loadRepository } from './repo-helpers.ts'

const counting = (inner: Storage) => {
  const calls: string[] = []
  const storage: Storage = {
    get: (key, range) => (calls.push(`get ${key}${range ? `@${range.offset}` : ''}`), inner.get(key, range)),
    head: (key) => (calls.push(`head ${key}`), inner.head(key)),
    put: (key, body, size, options) => inner.put(key, body, size, options),
    list: (prefix) => inner.list(prefix),
  }
  return { storage, calls }
}

const memoryCache = () => {
  const entries = new Map<string, CachedObject>()
  return { entries, get: async (key: string) => entries.get(key) ?? null, put: async (key: string, object: CachedObject) => void entries.set(key, object) }
}

const PACK = `repos/a/b/git/objects/pack/pack-${'1'.repeat(40)}.pack`

describe('cachedStorage', () => {
  it('serves pack ranges, indexes and heads from the cache and passes everything else through', async () => {
    const memory = new MemoryStorage()
    await memory.put(PACK, utf8('PACKdata'), 8)
    await memory.put(PACK.replace('.pack', '.idx'), utf8('index'), 5)
    await memory.put('repos/a/b/refs.json', utf8('{}'), 2)
    const { storage, calls } = counting(memory)
    const cached = cachedStorage(storage, memoryCache())
    for (let i = 0; i < 2; i++) {
      expect(new TextDecoder().decode(await readAll((await cached.get(PACK, { offset: 4, length: 4 }))!.body))).toBe('data')
      expect(new TextDecoder().decode(await readAll((await cached.get(PACK.replace('.pack', '.idx')))!.body))).toBe('index')
      expect((await cached.head(PACK))?.size).toBe(8)
      await cached.get('repos/a/b/refs.json')
      await cached.get(PACK)
    }
    expect(calls).toEqual([`get ${PACK}@4`, `get ${PACK.replace('.pack', '.idx')}`, `head ${PACK}`, 'get repos/a/b/refs.json', `get ${PACK}`, 'get repos/a/b/refs.json', `get ${PACK}`])
  })

  it('falls back to the storage when the cache fails', async () => {
    const memory = new MemoryStorage()
    await memory.put(PACK, utf8('PACK'), 4)
    const cached = cachedStorage(memory, { get: async () => Promise.reject(new Error('down')), put: async () => Promise.reject(new Error('down')) })
    expect((await cached.head(PACK))?.size).toBe(4)
  })
})

describe('ObjectDatabase caches', () => {
  it('reads pack indexes and blocks once across instances and concurrent reads', async () => {
    const dir = initRepo()
    writeFile(dir, 'a.txt', `${'x'.repeat(100)}\n`)
    const head = commitAll(dir, 'shared cache')
    const { storage: memory, repo } = await loadRepository(dir, { owner: 'cache', name: `r${Date.now()}` })
    const { storage, calls } = counting(memory)
    await Promise.all([new ObjectDatabase(storage, repo).read(head), new ObjectDatabase(storage, repo).read(head)])
    calls.length = 0
    const odb = new ObjectDatabase(storage, repo)
    await Promise.all([odb.read(head), odb.read(head), odb.packs()])
    expect(calls.filter((call) => call.includes('/objects/pack/'))).toEqual([])
    expect(calls.filter((call) => call.endsWith('objects/info/packs'))).toHaveLength(1)
  })

  it('hands out copies, so a caller that detaches its bytes leaves the cache intact', async () => {
    const dir = initRepo()
    writeFile(dir, 'b.txt', 'detached\n')
    const head = commitAll(dir, 'detach')
    const { storage, repo } = await loadRepository(dir, { owner: 'cache', name: `d${Date.now()}` })
    const first = (await new ObjectDatabase(storage, repo).read(head))!
    const raw = await new ObjectDatabase(storage, repo).readRaw((await new ObjectDatabase(storage, repo).locate(head))!.pack, 0)
    structuredClone(first.data.buffer, { transfer: [first.data.buffer as ArrayBuffer] })
    structuredClone(raw.buffer, { transfer: [raw.buffer as ArrayBuffer] })
    expect(new TextDecoder().decode((await new ObjectDatabase(storage, repo).read(head))!.data)).toMatch(/^tree /)
  })
})
