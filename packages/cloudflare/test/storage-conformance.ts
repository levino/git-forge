import { readAll, sha1, type Storage, streamOf, toHex, utf8 } from '@git-forge/core'
import { describe, expect, it } from 'vitest'

const text = async (storage: Storage, key: string, range?: { offset: number; length: number }) => {
  const object = await storage.get(key, range)
  return object ? new TextDecoder().decode(await readAll(object.body)) : null
}

const chunked = (data: Uint8Array, chunk: number): ReadableStream<Uint8Array> => {
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= data.length) return controller.close()
      controller.enqueue(data.slice(offset, offset + chunk))
      offset += chunk
    },
  })
}

export const describeStorageConformance = (name: string, make: () => Storage | Promise<Storage>) => {
  describe(`${name} storage conformance`, () => {
    it('returns null for missing objects', async () => {
      const storage = await make()
      expect(await storage.get('missing')).toBeNull()
      expect(await storage.head('missing')).toBeNull()
      expect(await storage.get('missing', { offset: 0, length: 4 })).toBeNull()
    })

    it('stores bytes and reports size and etag consistently', async () => {
      const storage = await make()
      const bytes = utf8('hello world')
      const result = await storage.put('a/b.txt', bytes, bytes.length, { contentType: 'text/plain' })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.info).toMatchObject({ key: 'a/b.txt', size: 11 })
      expect(result.info.etag).not.toMatch(/^"/)
      expect(await storage.head('a/b.txt')).toEqual(result.info)
      const object = await storage.get('a/b.txt')
      expect(object).toMatchObject({ key: 'a/b.txt', size: 11, etag: result.info.etag })
      expect(await text(storage, 'a/b.txt')).toBe('hello world')
    })

    it('streams a multi-chunk body of known length', async () => {
      const storage = await make()
      const data = new Uint8Array(3 * 1024 * 1024 + 17)
      for (let i = 0; i < data.length; i++) data[i] = (i * 31) % 251
      const result = await storage.put('big.bin', chunked(data, 64 * 1024), data.length)
      expect(result.ok).toBe(true)
      const object = await storage.get('big.bin')
      expect(object?.size).toBe(data.length)
      const read = await readAll(object!.body)
      expect(read.length).toBe(data.length)
      expect(toHex(sha1(read))).toBe(toHex(sha1(data)))
    })

    it('rejects a stream whose length differs from the declared size', async () => {
      const storage = await make()
      await expect(storage.put('short.bin', streamOf(utf8('abc')), 10)).rejects.toThrow()
      await expect(storage.put('long.bin', utf8('abcdef'), 3)).rejects.toThrow()
      expect(await storage.head('short.bin')).toBeNull()
      expect(await storage.head('long.bin')).toBeNull()
    })

    it('serves byte ranges and reports the full object size', async () => {
      const storage = await make()
      const bytes = utf8('0123456789')
      await storage.put('range.txt', bytes, bytes.length)
      expect(await text(storage, 'range.txt', { offset: 2, length: 3 })).toBe('234')
      expect(await text(storage, 'range.txt', { offset: 0, length: 10 })).toBe('0123456789')
      expect(await text(storage, 'range.txt', { offset: 7, length: 100 })).toBe('789')
      expect(await text(storage, 'range.txt', { offset: 10, length: 5 })).toBe('')
      expect((await storage.get('range.txt', { offset: 2, length: 3 }))?.size).toBe(10)
    })

    it('creates only when absent with ifNoneMatch *', async () => {
      const storage = await make()
      const first = await storage.put('lock', utf8('one'), 3, { ifNoneMatch: '*' })
      expect(first.ok).toBe(true)
      const second = await storage.put('lock', utf8('two'), 3, { ifNoneMatch: '*' })
      expect(second).toEqual({ ok: false, reason: 'precondition-failed' })
      expect(await text(storage, 'lock')).toBe('one')
    })

    it('replaces only on a matching etag with ifMatch', async () => {
      const storage = await make()
      const first = await storage.put('refs', utf8('v1'), 2)
      if (!first.ok) throw new Error('put failed')
      const second = await storage.put('refs', utf8('v2'), 2, { ifMatch: first.info.etag })
      expect(second.ok).toBe(true)
      if (!second.ok) return
      expect(second.info.etag).not.toBe(first.info.etag)
      const stale = await storage.put('refs', utf8('v3'), 2, { ifMatch: first.info.etag })
      expect(stale).toEqual({ ok: false, reason: 'precondition-failed' })
      expect(await text(storage, 'refs')).toBe('v2')
    })

    it('fails ifMatch on a missing object', async () => {
      const storage = await make()
      const result = await storage.put('nothing', utf8('x'), 1, { ifMatch: 'abc' })
      expect(result).toEqual({ ok: false, reason: 'precondition-failed' })
      expect(await storage.head('nothing')).toBeNull()
    })

    it('lets exactly one of two racing conditional writers win', async () => {
      const storage = await make()
      const base = await storage.put('race', utf8('0'), 1)
      if (!base.ok) throw new Error('put failed')
      const results = await Promise.all(
        ['a', 'b', 'c', 'd'].map((value) => storage.put('race', utf8(value), 1, { ifMatch: base.info.etag })),
      )
      expect(results.filter((result) => result.ok)).toHaveLength(1)
    })

    it('lists by prefix in lexicographic order across pages', async () => {
      const storage = await make()
      const keys = Array.from({ length: 25 }, (_, i) => `list/${String(i).padStart(3, '0')}`)
      for (const key of [...keys].reverse()) await storage.put(key, utf8(key), key.length)
      await storage.put('listing', utf8('x'), 1)
      await storage.put('other/1', utf8('x'), 1)
      const listed = []
      for await (const entry of storage.list('list/')) listed.push(entry)
      expect(listed.map((entry) => entry.key)).toEqual(keys)
      expect(listed[0]).toMatchObject({ size: keys[0]!.length })
      expect(listed[0]?.etag).toBe((await storage.head(keys[0]!))?.etag)
      const none = []
      for await (const entry of storage.list('nope/')) none.push(entry)
      expect(none).toEqual([])
    })
  })
}
