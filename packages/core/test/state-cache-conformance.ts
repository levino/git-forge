import { describe, expect, it } from 'vitest'
import { fromUtf8, readAll, utf8 } from '../src/bytes.ts'
import { MemoryStorage } from '../src/memory-storage.ts'
import { createRepository, readRefs, writeRefs } from '../src/repository.ts'
import { type StateCache, type StateValue, stateCachedStorage } from '../src/state-cache.ts'
import type { Storage } from '../src/storage.ts'

export const memoryStateCache = (now: () => number = Date.now): StateCache => {
  const rows = new Map<string, { version: number; token: string | null; pendingAt: number; cached: boolean; value: StateValue }>()
  const set = (key: string, version: number, cached: boolean, value: StateValue, token: string | null = null, pendingAt = 0) =>
    void rows.set(key, { version, token, pendingAt, cached, value })
  return {
    get: async (keys) => new Map(keys.flatMap((key) => (rows.has(key) ? [[key, { version: rows.get(key)!.version, hit: rows.get(key)!.token === null && rows.get(key)!.cached, value: rows.get(key)!.value }] as const] : []))),
    fill: async (key, value, version) => {
      const row = rows.get(key)
      if (version === null ? !row : row?.version === version && (row.token === null || row.pendingAt < now() - 60_000)) set(key, (version ?? 0) + 1, true, value)
    },
    begin: async (key, token) => set(key, (rows.get(key)?.version ?? 0) + 1, false, null, token, now()),
    commit: async (key, token, value) => {
      const row = rows.get(key)
      if (row?.token === token) set(key, row.version + 1, true, value)
      else if (row && row.token === null) set(key, row.version + 1, false, null)
    },
    abort: async (key, token) => {
      const row = rows.get(key)
      if (row?.token === token) set(key, row.version + 1, false, null)
    },
  }
}

const counting = (inner: Storage) => {
  const gets: string[] = []
  const storage: Storage = {
    get: (key, range) => (gets.push(key), inner.get(key, range)),
    head: (key) => inner.head(key),
    put: (key, body, size, options) => inner.put(key, body, size, options),
    list: (prefix) => inner.list(prefix),
  }
  return { storage, gets }
}

const REFS = 'repos/a/b/refs.json'
const ALTERNATES = 'repos/a/b/git/objects/info/alternates'

const text = async (storage: Storage, key: string) => {
  const object = await storage.get(key)
  return object ? { etag: object.etag, text: fromUtf8(await readAll(object.body)) } : null
}

export const stateCacheConformance = (name: string, create: (now: () => number) => StateCache | Promise<StateCache>) => {
  describe(`state cache: ${name}`, () => {
    it('fills only unchanged rows and lets a pending write block readers until it commits', async () => {
      let clock = 1_000_000
      const cache = await create(() => clock)
      await cache.fill('k', { etag: 'e1', text: 'one' }, null)
      expect((await cache.get(['k'])).get('k')).toMatchObject({ hit: true, value: { etag: 'e1', text: 'one' } })
      const seen = (await cache.get(['k'])).get('k')!.version
      await cache.begin('k', 't1')
      expect((await cache.get(['k'])).get('k')).toMatchObject({ hit: false })
      await cache.fill('k', { etag: 'e1', text: 'one' }, seen)
      const pending = (await cache.get(['k'])).get('k')!
      expect(pending.hit).toBe(false)
      await cache.fill('k', { etag: 'e1', text: 'one' }, pending.version)
      expect((await cache.get(['k'])).get('k')!.hit).toBe(false)
      await cache.commit('k', 't1', { etag: 'e2', text: 'two' })
      expect((await cache.get(['k'])).get('k')).toMatchObject({ hit: true, value: { etag: 'e2', text: 'two' } })
      await cache.fill('k', { etag: 'e1', text: 'one' }, pending.version)
      expect((await cache.get(['k'])).get('k')!.value).toEqual({ etag: 'e2', text: 'two' })
      await cache.begin('k', 't2')
      clock += 61_000
      const expired = (await cache.get(['k'])).get('k')!
      await cache.fill('k', null, expired.version)
      expect((await cache.get(['k'])).get('k')).toMatchObject({ hit: true, value: null })
      expect((await cache.get(['missing'])).has('missing')).toBe(false)
    })

    it('keeps the newest writer, invalidates on a late commit and clears on abort', async () => {
      const cache = await create(() => 0)
      await cache.begin('k', 't1')
      await cache.begin('k', 't2')
      await cache.commit('k', 't1', { etag: 'e1', text: 'one' })
      expect((await cache.get(['k'])).get('k')!.hit).toBe(false)
      await cache.commit('k', 't2', { etag: 'e2', text: 'two' })
      expect((await cache.get(['k'])).get('k')).toMatchObject({ hit: true, value: { etag: 'e2' } })
      await cache.commit('k', 't1', { etag: 'e1', text: 'one' })
      expect((await cache.get(['k'])).get('k')!.hit).toBe(false)
      await cache.begin('k', 't3')
      await cache.abort('k', 't3')
      expect((await cache.get(['k'])).get('k')!.hit).toBe(false)
      const keys = Array.from({ length: 120 }, (_, i) => `many/${i}`)
      for (const key of keys) await cache.fill(key, null, null)
      expect((await cache.get(keys)).size).toBe(120)
    })

    it('serves refs and absent files from the cache and stays equal to the bucket across writes', async () => {
      const memory = new MemoryStorage()
      const { storage: inner, gets } = counting(memory)
      const storage = stateCachedStorage(inner, await create(Date.now))
      await createRepository(storage, { owner: 'a', name: 'b' })
      expect(await text(storage, ALTERNATES)).toBeNull()
      expect(await text(storage, ALTERNATES)).toBeNull()
      const first = await readRefs(storage, { owner: 'a', name: 'b' })
      gets.length = 0
      expect(await readRefs(storage, { owner: 'a', name: 'b' })).toEqual(first)
      expect(await text(storage, ALTERNATES)).toBeNull()
      expect(gets).toEqual([])
      expect(await writeRefs(storage, { owner: 'a', name: 'b' }, { ...first!.state, refs: { 'refs/heads/main': '1'.repeat(40) } }, first!.etag)).toBe(true)
      expect(await writeRefs(storage, { owner: 'a', name: 'b' }, first!.state, first!.etag)).toBe(false)
      expect(await text(storage, REFS)).toEqual(await text(memory, REFS))
      expect(gets).toEqual([REFS])
      await storage.put(ALTERNATES, utf8('x\n'), 2)
      expect(await text(storage, ALTERNATES)).toEqual(await text(memory, ALTERNATES))
      await memory.put('repos/a/b/other', utf8('o'), 1)
      expect(await text(storage, 'repos/a/b/other')).toMatchObject({ text: 'o' })
    })

    it('converges under concurrent compare-and-swap writers', async () => {
      const memory = new MemoryStorage()
      const storage = stateCachedStorage(memory, await create(Date.now))
      const repo = { owner: 'a', name: 'b' }
      await createRepository(storage, repo)
      const writer = async (n: number) => {
        for (let round = 0; round < 5; round++) {
          for (;;) {
            const current = (await readRefs(storage, repo))!
            const refs = { ...current.state.refs, [`refs/heads/w${n}`]: String(round).repeat(40) }
            if (await writeRefs(storage, repo, { ...current.state, refs }, current.etag)) break
          }
        }
      }
      await Promise.all(Array.from({ length: 6 }, (_, n) => writer(n)))
      const cached = await readRefs(storage, repo)
      expect(cached).toEqual(await readRefs(memory, repo))
      expect(Object.keys(cached!.state.refs)).toHaveLength(6)
    })
  })
}
