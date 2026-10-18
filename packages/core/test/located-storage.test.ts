import { describe, expect, it } from 'vitest'
import { LOCATION_CACHE_MS, locatedStorage, MemoryStorage, RepositoryGoneError, type RepositoryLocation, utf8 } from '../src/index.ts'

const put = (storage: MemoryStorage, key: string) => storage.put(key, utf8(key), key.length)

describe('locatedStorage', () => {
  const setup = () => {
    const raw = new MemoryStorage()
    const table = new Map<string, RepositoryLocation>([
      ['a/new', { path: 'a/old', live: true }],
      ['a/moved', { path: 'a/old', live: false }],
      ['a/gone', { path: null, live: false }],
    ])
    let lookups = 0
    let clock = 0
    const storage = locatedStorage(
      raw,
      async (owner, name) => {
        lookups++
        return table.get(`${owner}/${name}`.toLowerCase()) ?? null
      },
      () => clock,
    )
    return { raw, table, storage, lookups: () => lookups, tick: (ms: number) => (clock += ms) }
  }

  it('maps repository keys to the stored prefix and lists them under the requested one', async () => {
    const { raw, storage } = setup()
    await put(raw, 'repos/a/old/refs.json')
    await put(raw, 'repos/a/old/lfs/objects/aa/bb/x')
    expect(await (await storage.get('repos/A/New/refs.json'))?.size).toBe('repos/a/old/refs.json'.length)
    expect(await storage.head('repos/a/moved/refs.json')).not.toBeNull()
    await storage.put('tmp/repos/a/new/1/0', utf8('x'), 1)
    expect(await raw.head('tmp/repos/a/old/1/0')).not.toBeNull()
    const listed: string[] = []
    for await (const info of storage.list('repos/a/new/lfs/')) listed.push(info.key)
    expect(listed).toEqual(['repos/a/new/lfs/objects/aa/bb/x'])
    await put(raw, 'repos/b/plain/refs.json')
    expect(await storage.head('repos/b/plain/refs.json')).not.toBeNull()
    expect(await storage.head('other/key')).toBeNull()
  })

  it('hides deleted repositories and refuses writes to them', async () => {
    const { raw, storage } = setup()
    await put(raw, 'repos/a/gone/refs.json')
    expect(await storage.get('repos/a/gone/refs.json')).toBeNull()
    await expect(storage.put('repos/a/gone/refs.json', utf8('x'), 1)).rejects.toBeInstanceOf(RepositoryGoneError)
    const listed: string[] = []
    for await (const info of storage.list('repos/a/gone/')) listed.push(info.key)
    expect(listed).toEqual([])
  })

  it('caches live names only, for a bounded time', async () => {
    const { storage, lookups, tick } = setup()
    await storage.head('repos/a/new/x')
    await storage.head('repos/a/new/y')
    expect(lookups()).toBe(1)
    await storage.head('repos/a/moved/x')
    await storage.head('repos/a/moved/y')
    expect(lookups()).toBe(3)
    tick(LOCATION_CACHE_MS + 1)
    await storage.head('repos/a/new/z')
    expect(lookups()).toBe(4)
  })
})
