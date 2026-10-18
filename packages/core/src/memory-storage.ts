import { readAll, streamOf, toHex } from './bytes.ts'
import { sha1 } from './hash.ts'
import type { ByteRange, ObjectInfo, PutBody, PutOptions, PutResult, Storage, StoredObject } from './storage.ts'

type Entry = { readonly data: Uint8Array; readonly etag: string }

export class MemoryStorage implements Storage {
  readonly #entries = new Map<string, Entry>()

  async get(key: string, range?: ByteRange): Promise<StoredObject | null> {
    const entry = this.#entries.get(key)
    if (!entry) return null
    const data = range ? entry.data.subarray(range.offset, range.offset + range.length) : entry.data
    return { key, size: entry.data.length, etag: entry.etag, body: streamOf(data.slice()) }
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const entry = this.#entries.get(key)
    return entry ? { key, size: entry.data.length, etag: entry.etag } : null
  }

  async put(key: string, body: PutBody, size: number, options: PutOptions = {}): Promise<PutResult> {
    const data = body instanceof Uint8Array ? body.slice() : await readAll(body)
    if (data.length !== size) throw new Error(`size mismatch for ${key}: expected ${size}, got ${data.length}`)
    const current = this.#entries.get(key)
    if (options.ifNoneMatch === '*' && current) return { ok: false, reason: 'precondition-failed' }
    if (options.ifMatch !== undefined && current?.etag !== options.ifMatch) return { ok: false, reason: 'precondition-failed' }
    const etag = toHex(sha1(data))
    this.#entries.set(key, { data, etag })
    return { ok: true, info: { key, size: data.length, etag } }
  }

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    const keys = [...this.#entries.keys()].filter((key) => key.startsWith(prefix)).sort()
    for (const key of keys) {
      const entry = this.#entries.get(key)
      if (entry) yield { key, size: entry.data.length, etag: entry.etag }
    }
  }
}
