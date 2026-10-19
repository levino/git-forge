import { readAll, streamOf } from './bytes.ts'
import type { ObjectInfo, Storage } from './storage.ts'

export type CachedObject = ObjectInfo & { readonly bytes: Uint8Array }

export interface ObjectCache {
  get(key: string): Promise<CachedObject | null>
  put(key: string, object: CachedObject): Promise<void>
}

const IMMUTABLE = /\/git\/objects\/pack\/pack-[0-9a-f]{40}\.(pack|idx)$/

const MAX_RANGE_BYTES = 1024 * 1024

const MAX_INDEX_BYTES = 16 * 1024 * 1024

export const cachedStorage = (storage: Storage, cache: ObjectCache): Storage => {
  const lookup = (key: string) => cache.get(key).catch(() => null)
  const remember = (key: string, object: CachedObject) => void cache.put(key, object).catch(() => {})
  const cached: Storage = {
    get: async (key, range) => {
      if (!IMMUTABLE.test(key) || (range ? range.length > MAX_RANGE_BYTES : !key.endsWith('.idx'))) return storage.get(key, range)
      const id = range ? `${key}@${range.offset}+${range.length}` : key
      const expected = (size: number) => (range ? Math.max(0, Math.min(range.length, size - range.offset)) : size)
      const hit = await lookup(id)
      if (hit && hit.bytes.length === expected(hit.size)) return { key, size: hit.size, etag: hit.etag, body: streamOf(hit.bytes) }
      const object = await storage.get(key, range)
      if (!object || (!range && object.size > MAX_INDEX_BYTES)) return object
      const bytes = await readAll(object.body)
      if (bytes.length === expected(object.size)) remember(id, { key, size: object.size, etag: object.etag, bytes: bytes.slice() })
      return { key, size: object.size, etag: object.etag, body: streamOf(bytes) }
    },
    head: async (key) => {
      if (!IMMUTABLE.test(key)) return storage.head(key)
      const hit = await lookup(`${key}@head`)
      if (hit) return { key, size: hit.size, etag: hit.etag }
      const info = await storage.head(key)
      if (info) remember(`${key}@head`, { ...info, bytes: new Uint8Array(0) })
      return info
    },
    put: (key, body, size, options) => storage.put(key, body, size, options),
    list: (prefix) => storage.list(prefix),
  }
  if (storage.putVerified) cached.putVerified = storage.putVerified.bind(storage)
  if (storage.presignGet) cached.presignGet = storage.presignGet.bind(storage)
  if (storage.presignPut) cached.presignPut = storage.presignPut.bind(storage)
  return cached
}
