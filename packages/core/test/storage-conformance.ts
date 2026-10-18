import { describe, expect, it } from 'vitest'
import { concat, fromUtf8, readAll, utf8 } from '../src/bytes.ts'
import type { ObjectInfo, PutResult, Storage } from '../src/storage.ts'

export type StorageConformanceOptions = {
  readonly pagination?: boolean
  readonly paginationKeys?: number
  readonly concurrentWriters?: number
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

  describe(`Storage-Konformität: ${name}`, () => {
    it('liefert null für fehlende Schlüssel', { timeout }, async () => {
      const storage = await make()
      const prefix = base()
      expect(await storage.get(`${prefix}fehlt`)).toBeNull()
      expect(await storage.get(`${prefix}fehlt`, { offset: 0, length: 4 })).toBeNull()
      expect(await storage.head(`${prefix}fehlt`)).toBeNull()
      expect(await collect(storage.list(prefix))).toEqual([])
    })

    it('schreibt und liest Uint8Array', { timeout }, async () => {
      const storage = await make()
      const key = `${base()}datei.bin`
      const data = patterned(4096, 1)
      const info = expectOk(await storage.put(key, data, data.length))
      expect(info.key).toBe(key)
      expect(info.size).toBe(data.length)
      expect(info.etag).not.toBe('')
      const object = await storage.get(key)
      expect(object).not.toBeNull()
      if (!object) return
      expect(object.key).toBe(key)
      expect(object.size).toBe(data.length)
      expect(object.etag).toBe(info.etag)
      expect(await readAll(object.body)).toEqual(data)
      expect(await storage.head(key)).toEqual({ key, size: data.length, etag: info.etag })
    })

    it('schreibt und liest einen ReadableStream in mehreren Teilen', { timeout }, async () => {
      const storage = await make()
      const key = `${base()}strom.bin`
      const parts = [patterned(70_000, 2), patterned(1, 3), patterned(130_001, 4)]
      const data = concat(parts)
      const info = expectOk(await storage.put(key, chunkedStream(parts), data.length))
      expect(info.size).toBe(data.length)
      expect(await bodyOf(storage, key)).toEqual(data)
    })

    it('speichert leere Objekte', { timeout }, async () => {
      const storage = await make()
      const key = `${base()}leer`
      const info = expectOk(await storage.put(key, new Uint8Array(0), 0))
      expect(info.size).toBe(0)
      expect(await bodyOf(storage, key)).toEqual(new Uint8Array(0))
      expect((await storage.head(key))?.size).toBe(0)
    })

    it('lehnt falsche Größenangaben ab und speichert nichts', { timeout }, async () => {
      const storage = await make()
      const prefix = base()
      const data = patterned(1000, 5)
      await expect(storage.put(`${prefix}zu-gross`, data, data.length + 1)).rejects.toThrow()
      await expect(storage.put(`${prefix}zu-klein`, data, data.length - 1)).rejects.toThrow()
      await expect(storage.put(`${prefix}strom-kurz`, chunkedStream([data]), data.length + 10)).rejects.toThrow()
      await expect(storage.put(`${prefix}strom-lang`, chunkedStream([data, data]), data.length)).rejects.toThrow()
      expect(await storage.head(`${prefix}zu-gross`)).toBeNull()
      expect(await storage.head(`${prefix}zu-klein`)).toBeNull()
      expect(await storage.head(`${prefix}strom-kurz`)).toBeNull()
      expect(await storage.head(`${prefix}strom-lang`)).toBeNull()

      const key = `${prefix}bestehend`
      const original = utf8('original')
      const info = expectOk(await storage.put(key, original, original.length))
      await expect(storage.put(key, chunkedStream([data]), data.length + 1)).rejects.toThrow()
      expect(await bodyOf(storage, key)).toEqual(original)
      expect((await storage.head(key))?.etag).toBe(info.etag)
    })

    it('liest Bereiche mit Offset und Länge, auch über das Ende hinaus', { timeout }, async () => {
      const storage = await make()
      const key = `${base()}bereich.bin`
      const data = patterned(10_000, 6)
      const info = expectOk(await storage.put(key, data, data.length))

      const middle = await storage.get(key, { offset: 1234, length: 567 })
      expect(middle?.size).toBe(data.length)
      expect(middle?.etag).toBe(info.etag)
      expect(middle && (await readAll(middle.body))).toEqual(data.slice(1234, 1234 + 567))

      const start = await storage.get(key, { offset: 0, length: 1 })
      expect(start && (await readAll(start.body))).toEqual(data.slice(0, 1))

      const last = await storage.get(key, { offset: data.length - 1, length: 1 })
      expect(last && (await readAll(last.body))).toEqual(data.slice(-1))

      const tail = await storage.get(key, { offset: data.length - 10, length: 1000 })
      expect(tail?.size).toBe(data.length)
      expect(tail && (await readAll(tail.body))).toEqual(data.slice(-10))
    })

    it('listet nach Präfix sortiert, mit verschachtelten Schlüsseln', { timeout }, async () => {
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
      for (const info of all) {
        const expected = infos.get(info.key.slice(prefix.length))
        expect(info).toEqual(expected)
      }

      const partial = await collect(storage.list(`${prefix}p/c`))
      expect(partial.map((info) => info.key)).toEqual(['p/c-z', 'p/c/d', 'p/c/e/f'].map((key) => `${prefix}${key}`))

      const everything = await collect(storage.list(prefix))
      expect(everything.map((info) => info.key)).toEqual([...keys].sort().map((key) => `${prefix}${key}`))

      expect(await collect(storage.list(`${prefix}nichts/`))).toEqual([])
    })

    it.skipIf(!options.pagination)('listet mehr Schlüssel als eine Seite fasst', { timeout: Math.max(timeout, 300_000) }, async () => {
      const storage = await make()
      const prefix = base()
      const total = options.paginationKeys ?? 1005
      const keys = Array.from({ length: total }, (_, i) => `${prefix}k${i.toString().padStart(5, '0')}`)
      for (let i = 0; i < keys.length; i += 50) {
        await Promise.all(keys.slice(i, i + 50).map((key) => storage.put(key, utf8(key), utf8(key).length)))
      }
      const listed = await collect(storage.list(prefix))
      expect(listed.map((info) => info.key)).toEqual(keys)
    })

    it('ändert das ETag beim Überschreiben', { timeout }, async () => {
      const storage = await make()
      const key = `${base()}etag`
      const first = expectOk(await storage.put(key, utf8('eins'), 4))
      const second = expectOk(await storage.put(key, utf8('zwei!'), 5))
      expect(second.etag).not.toBe(first.etag)
      expect(await storage.head(key)).toEqual({ key, size: 5, etag: second.etag })
      expect(fromUtf8((await bodyOf(storage, key)) ?? new Uint8Array(0))).toBe('zwei!')
    })

    it('legt mit ifNoneMatch "*" nur neu an', { timeout }, async () => {
      const storage = await make()
      const key = `${base()}einmalig`
      const created = expectOk(await storage.put(key, utf8('erst'), 4, { ifNoneMatch: '*' }))
      expect(await storage.put(key, utf8('danach'), 6, { ifNoneMatch: '*' })).toEqual({ ok: false, reason: 'precondition-failed' })
      expect(fromUtf8((await bodyOf(storage, key)) ?? new Uint8Array(0))).toBe('erst')
      expect((await storage.head(key))?.etag).toBe(created.etag)
    })

    it('schreibt mit ifMatch nur bei passendem ETag (compare-and-swap)', { timeout }, async () => {
      const storage = await make()
      const prefix = base()
      const key = `${prefix}cas`
      const first = expectOk(await storage.put(key, utf8('v1'), 2))
      const second = expectOk(await storage.put(key, utf8('v2-neu'), 6, { ifMatch: first.etag }))
      expect(second.etag).not.toBe(first.etag)
      expect(await storage.put(key, utf8('v3'), 2, { ifMatch: first.etag })).toEqual({ ok: false, reason: 'precondition-failed' })
      expect(fromUtf8((await bodyOf(storage, key)) ?? new Uint8Array(0))).toBe('v2-neu')
      expect(await storage.put(`${prefix}fehlt`, utf8('x'), 1, { ifMatch: first.etag })).toEqual({
        ok: false,
        reason: 'precondition-failed',
      })
      expect(await storage.head(`${prefix}fehlt`)).toBeNull()
    })

    it(`lässt von ${writers} gleichzeitigen CAS-Schreibern genau einen gewinnen`, { timeout }, async () => {
      const storage = await make()
      const key = `${base()}wettlauf`
      const start = expectOk(await storage.put(key, utf8('start'), 5))
      const bodies = Array.from({ length: writers }, (_, i) => utf8(`schreiber-${i}-${'x'.repeat(i * 100)}`))
      const results = await Promise.all(bodies.map((body) => storage.put(key, body, body.length, { ifMatch: start.etag })))
      const winners = results.flatMap((result, i) => (result.ok ? [i] : []))
      expect(winners).toHaveLength(1)
      for (const result of results) if (!result.ok) expect(result.reason).toBe('precondition-failed')
      const winner = winners[0] as number
      expect(await bodyOf(storage, key)).toEqual(bodies[winner])
    })

    it(`lässt von ${writers} gleichzeitigen Erzeugern genau einen gewinnen`, { timeout }, async () => {
      const storage = await make()
      const key = `${base()}erzeugen`
      const bodies = Array.from({ length: writers }, (_, i) => utf8(`erzeuger-${i}`))
      const results = await Promise.all(bodies.map((body) => storage.put(key, body, body.length, { ifNoneMatch: '*' })))
      const winners = results.flatMap((result, i) => (result.ok ? [i] : []))
      expect(winners).toHaveLength(1)
      expect(await bodyOf(storage, key)).toEqual(bodies[winners[0] as number])
    })
  })
}
