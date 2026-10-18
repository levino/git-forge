import { describe, expect, it } from 'vitest'
import { concat, fromUtf8, readAll, utf8 } from '../src/bytes.ts'
import { sha1, sha256Hex } from '../src/hash.ts'
import type { ObjectInfo, PutResult, Storage } from '../src/storage.ts'

export type StorageConformanceOptions = {
  readonly paginationKeys?: number
  readonly concurrentWriters?: number
  readonly largeObjectBytes?: number
  readonly timeout?: number
}

const chunkedStream = (parts: readonly Uint8Array[]): ReadableStream<Uint8Array> => {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts[index++]
      if (part) controller.enqueue(part)
      else controller.close()
    },
  })
}

const sliced = (data: Uint8Array, chunk: number): readonly Uint8Array[] =>
  Array.from({ length: Math.ceil(data.length / chunk) }, (_, i) => data.slice(i * chunk, (i + 1) * chunk))

const patterned = (length: number, seed: number): Uint8Array => {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed * 7) & 0xff
  return out
}

const collect = async (iterable: AsyncIterable<ObjectInfo>): Promise<ObjectInfo[]> => {
  const out: ObjectInfo[] = []
  for await (const info of iterable) out.push(info)
  return out
}

const expectOk = (result: PutResult): ObjectInfo => {
  if (!result.ok) throw new Error(`put failed: ${result.reason}`)
  return result.info
}

const bodyOf = async (storage: Storage, key: string): Promise<Uint8Array | null> => {
  const object = await storage.get(key)
  return object ? readAll(object.body) : null
}

const textOf = async (storage: Storage, key: string): Promise<string | null> => {
  const body = await bodyOf(storage, key)
  return body ? fromUtf8(body) : null
}

const preconditionFailed = { ok: false, reason: 'precondition-failed' }

export const describeStorageConformance = (
  name: string,
  make: () => Promise<Storage> | Storage,
  options: StorageConformanceOptions = {},
): void => {
  const timeout = options.timeout ?? 30_000
  const writers = options.concurrentWriters ?? 8
  const run = `conformance-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  let counter = 0
  const base = (): string => `${run}/${counter++}/`

  describe(`storage conformance: ${name}`, () => {
    it('returns null for missing keys', { timeout }, async () => {
      const storage = await make()
      const prefix = base()
      expect(await storage.get(`${prefix}missing`)).toBeNull()
      expect(await storage.get(`${prefix}missing`, { offset: 0, length: 4 })).toBeNull()
      expect(await storage.head(`${prefix}missing`)).toBeNull()
      expect(await collect(storage.list(prefix))).toEqual([])
    })

    it('writes and reads a Uint8Array', { timeout }, async () => {
      const storage = await make()
      const key = `${base()}file.bin`
      const data = patterned(4096, 1)
      const info = expectOk(await storage.put(key, data, data.length, { contentType: 'application/octet-stream' }))
      expect(info.key).toBe(key)
      expect(info.size).toBe(data.length)
      expect(info.etag).not.toBe('')
      expect(info.etag).not.toMatch(/^(W\/)?"/)
      const object = await storage.get(key)
      expect(object).not.toBeNull()
      if (!object) return
      expect(object.key).toBe(key)
      expect(object.size).toBe(data.length)
      expect(object.etag).toBe(info.etag)
      expect(await readAll(object.body)).toEqual(data)
      expect(await storage.head(key)).toEqual({ key, size: data.length, etag: info.etag })
    })

    it('writes and reads a ReadableStream delivered in several chunks', { timeout }, async () => {
      const storage = await make()
      const key = `${base()}stream.bin`
      const parts = [patterned(70_000, 2), patterned(1, 3), new Uint8Array(0), patterned(130_001, 4)]
      const data = concat(parts)
      const info = expectOk(await storage.put(key, chunkedStream(parts), data.length))
      expect(info.size).toBe(data.length)
      expect(await bodyOf(storage, key)).toEqual(data)
    })

    it('streams a multi-MiB body of known length', { timeout }, async () => {
      const storage = await make()
      const key = `${base()}large.bin`
      const data = patterned(options.largeObjectBytes ?? 3 * 1024 * 1024 + 17, 9)
      expectOk(await storage.put(key, chunkedStream(sliced(data, 64 * 1024)), data.length))
      const object = await storage.get(key)
      expect(object?.size).toBe(data.length)
      const read = object ? await readAll(object.body) : new Uint8Array(0)
      expect(read.length).toBe(data.length)
      expect(sha256Hex(read)).toBe(sha256Hex(data))
    })

    it('stores empty objects', { timeout }, async () => {
      const storage = await make()
      const key = `${base()}empty`
      const info = expectOk(await storage.put(key, new Uint8Array(0), 0))
      expect(info.size).toBe(0)
      expect(await bodyOf(storage, key)).toEqual(new Uint8Array(0))
      expect((await storage.head(key))?.size).toBe(0)
    })

    it('rejects a wrong declared size and stores nothing', { timeout }, async () => {
      const storage = await make()
      const prefix = base()
      const data = patterned(1000, 5)
      await expect(storage.put(`${prefix}too-large`, data, data.length + 1)).rejects.toThrow()
      await expect(storage.put(`${prefix}too-small`, data, data.length - 1)).rejects.toThrow()
      await expect(storage.put(`${prefix}stream-short`, chunkedStream([data]), data.length + 10)).rejects.toThrow()
      await expect(storage.put(`${prefix}stream-long`, chunkedStream([data, data]), data.length)).rejects.toThrow()
      expect(await storage.head(`${prefix}too-large`)).toBeNull()
      expect(await storage.head(`${prefix}too-small`)).toBeNull()
      expect(await storage.head(`${prefix}stream-short`)).toBeNull()
      expect(await storage.head(`${prefix}stream-long`)).toBeNull()

      const key = `${prefix}existing`
      const original = utf8('original')
      const info = expectOk(await storage.put(key, original, original.length))
      await expect(storage.put(key, chunkedStream([data]), data.length + 1)).rejects.toThrow()
      expect(await bodyOf(storage, key)).toEqual(original)
      expect((await storage.head(key))?.etag).toBe(info.etag)
    })

    it('stores nothing when the body stream errors', { timeout }, async () => {
      const storage = await make()
      const key = `${base()}broken`
      let sent = false
      const failing = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) controller.error(new Error('client went away'))
          else controller.enqueue(patterned(1000, 8))
          sent = true
        },
      })
      await expect(storage.put(key, failing, 2000)).rejects.toThrow()
      expect(await storage.head(key)).toBeNull()
    })

    it('reads ranges by offset and length, also past the end', { timeout }, async () => {
      const storage = await make()
      const key = `${base()}range.bin`
      const data = patterned(10_000, 6)
      const info = expectOk(await storage.put(key, data, data.length))

      const middle = await storage.get(key, { offset: 1234, length: 567 })
      expect(middle?.size).toBe(data.length)
      expect(middle?.etag).toBe(info.etag)
      expect(middle && (await readAll(middle.body))).toEqual(data.slice(1234, 1234 + 567))

      const start = await storage.get(key, { offset: 0, length: 1 })
      expect(start && (await readAll(start.body))).toEqual(data.slice(0, 1))

      const whole = await storage.get(key, { offset: 0, length: data.length })
      expect(whole && (await readAll(whole.body))).toEqual(data)

      const last = await storage.get(key, { offset: data.length - 1, length: 1 })
      expect(last && (await readAll(last.body))).toEqual(data.slice(-1))

      const tail = await storage.get(key, { offset: data.length - 10, length: 1000 })
      expect(tail?.size).toBe(data.length)
      expect(tail && (await readAll(tail.body))).toEqual(data.slice(-10))

      const beyond = await storage.get(key, { offset: data.length, length: 5 })
      expect(beyond?.size).toBe(data.length)
      expect(beyond && (await readAll(beyond.body))).toEqual(new Uint8Array(0))
    })

    it('lists by prefix in lexicographic order, with nested keys', { timeout }, async () => {
      const storage = await make()
      const prefix = base()
      const keys = ['p/b', 'p/a', 'p/c/d', 'p/c/e/f', 'p-x', 'q/x', 'p/c-z']
      const infos = new Map<string, ObjectInfo>()
      for (const [i, key] of keys.entries()) {
        const data = patterned(10 + i, i)
        infos.set(key, expectOk(await storage.put(`${prefix}${key}`, data, data.length)))
      }

      const all = await collect(storage.list(`${prefix}p/`))
      expect(all.map((info) => info.key)).toEqual(['p/a', 'p/b', 'p/c-z', 'p/c/d', 'p/c/e/f'].map((key) => `${prefix}${key}`))
      for (const info of all) expect(info).toEqual(infos.get(info.key.slice(prefix.length)))

      const partial = await collect(storage.list(`${prefix}p/c`))
      expect(partial.map((info) => info.key)).toEqual(['p/c-z', 'p/c/d', 'p/c/e/f'].map((key) => `${prefix}${key}`))

      const everything = await collect(storage.list(prefix))
      expect(everything.map((info) => info.key)).toEqual([...keys].sort().map((key) => `${prefix}${key}`))

      expect(await collect(storage.list(`${prefix}nothing/`))).toEqual([])
    })

    it('lists more keys than fit on one page', { timeout: Math.max(timeout, 120_000) }, async () => {
      const storage = await make()
      const prefix = base()
      const total = options.paginationKeys ?? 25
      const keys = Array.from({ length: total }, (_, i) => `${prefix}k${i.toString().padStart(5, '0')}`)
      for (let i = 0; i < keys.length; i += 50) {
        await Promise.all(keys.slice(i, i + 50).map((key) => storage.put(key, utf8(key), utf8(key).length)))
      }
      const listed = await collect(storage.list(prefix))
      expect(listed.map((info) => info.key)).toEqual(keys)
    })

    it('changes the etag on overwrite', { timeout }, async () => {
      const storage = await make()
      const key = `${base()}etag`
      const first = expectOk(await storage.put(key, utf8('one'), 3))
      const second = expectOk(await storage.put(key, utf8('two!!'), 5))
      expect(second.etag).not.toBe(first.etag)
      expect(await storage.head(key)).toEqual({ key, size: 5, etag: second.etag })
      expect(await textOf(storage, key)).toBe('two!!')
    })

    it('creates only when absent with ifNoneMatch "*"', { timeout }, async () => {
      const storage = await make()
      const key = `${base()}once`
      const created = expectOk(await storage.put(key, utf8('first'), 5, { ifNoneMatch: '*' }))
      expect(await storage.put(key, utf8('second'), 6, { ifNoneMatch: '*' })).toEqual(preconditionFailed)
      expect(await textOf(storage, key)).toBe('first')
      expect((await storage.head(key))?.etag).toBe(created.etag)
    })

    it('replaces only on a matching etag with ifMatch (compare-and-swap)', { timeout }, async () => {
      const storage = await make()
      const prefix = base()
      const key = `${prefix}cas`
      const first = expectOk(await storage.put(key, utf8('v1'), 2))
      const second = expectOk(await storage.put(key, utf8('v2-new'), 6, { ifMatch: first.etag }))
      expect(second.etag).not.toBe(first.etag)
      expect(await storage.put(key, utf8('v3'), 2, { ifMatch: first.etag })).toEqual(preconditionFailed)
      expect(await textOf(storage, key)).toBe('v2-new')
      const third = expectOk(await storage.put(key, utf8('v3'), 2, { ifMatch: second.etag }))
      expect((await storage.head(key))?.etag).toBe(third.etag)
    })

    it('fails ifMatch on a missing key', { timeout }, async () => {
      const storage = await make()
      const key = `${base()}missing`
      expect(await storage.put(key, utf8('x'), 1, { ifMatch: 'abc' })).toEqual(preconditionFailed)
      expect(await storage.head(key)).toBeNull()
    })

    it(`lets exactly one of ${writers} concurrent compare-and-swap writers win`, { timeout }, async () => {
      const storage = await make()
      const key = `${base()}race`
      const start = expectOk(await storage.put(key, utf8('start'), 5))
      const bodies = Array.from({ length: writers }, (_, i) => utf8(`writer-${i}-${'x'.repeat(i * 100)}`))
      const results = await Promise.all(bodies.map((body) => storage.put(key, body, body.length, { ifMatch: start.etag })))
      const winners = results.flatMap((result, i) => (result.ok ? [i] : []))
      expect(winners).toHaveLength(1)
      for (const result of results) if (!result.ok) expect(result.reason).toBe('precondition-failed')
      expect(await bodyOf(storage, key)).toEqual(bodies[winners[0] as number])
    })

    it(`lets exactly one of ${writers} concurrent creators win`, { timeout }, async () => {
      const storage = await make()
      const key = `${base()}create`
      const bodies = Array.from({ length: writers }, (_, i) => utf8(`creator-${i}`))
      const results = await Promise.all(bodies.map((body) => storage.put(key, body, body.length, { ifNoneMatch: '*' })))
      const winners = results.flatMap((result, i) => (result.ok ? [i] : []))
      expect(winners).toHaveLength(1)
      expect(await bodyOf(storage, key)).toEqual(bodies[winners[0] as number])
    })

    it('keeps etags stable across reads and distinct per content', { timeout }, async () => {
      const storage = await make()
      const prefix = base()
      const a = expectOk(await storage.put(`${prefix}a`, utf8('same'), 4))
      const b = expectOk(await storage.put(`${prefix}b`, sha1(utf8('other')), 20))
      expect((await storage.head(`${prefix}a`))?.etag).toBe(a.etag)
      expect((await storage.head(`${prefix}a`))?.etag).toBe(a.etag)
      expect(a.etag).not.toBe(b.etag)
    })
  })
}
