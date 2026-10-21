import { fromUtf8, readAll, streamOf, utf8 } from './bytes.ts'
import type { PutBody, PutOptions, PutResult, Storage, StoredObject } from './storage.ts'

export type StateValue = { readonly etag: string; readonly text: string } | null

export type StateEntry = { readonly version: number; readonly hit: boolean; readonly value: StateValue }

export interface StateCache {
  get(keys: readonly string[]): Promise<ReadonlyMap<string, StateEntry>>
  fill(key: string, value: StateValue, version: number | null): Promise<void>
  begin(key: string, token: string): Promise<void>
  commit(key: string, token: string, value: StateValue): Promise<void>
  abort(key: string, token: string): Promise<void>
  lock?(key: string, token: string): Promise<StateEntry | undefined>
  release?(key: string, token: string, value: StateValue | undefined): Promise<void>
}

export const STATE_KEY = /^repos\/[^/]+\/[^/]+\/(refs\.json|git\/objects\/info\/(packs|alternates))$/

export const MAX_STATE_BYTES = 512 * 1024

const textOf = (bytes: Uint8Array): string | null => {
  if (bytes.length > MAX_STATE_BYTES) return null
  const text = fromUtf8(bytes)
  return utf8(text).length === bytes.length ? text : null
}

const cancel = async (body: PutBody): Promise<void> => {
  if (!(body instanceof Uint8Array)) await body.cancel().catch(() => undefined)
}

const lockedPut = async (storage: Storage, cache: Required<Pick<StateCache, 'lock' | 'release'>>, key: string, body: PutBody, size: number, options: PutOptions): Promise<PutResult> => {
  const token = crypto.randomUUID()
  const entry = await cache.lock(key, token).catch(async (error: unknown) => {
    await cancel(body)
    throw error
  })
  let value: StateValue | undefined
  try {
    const etag = entry?.hit ? (entry.value?.etag ?? null) : ((await storage.head(key))?.etag ?? null)
    if ((options.ifNoneMatch === '*' && etag !== null) || (options.ifMatch !== undefined && etag !== options.ifMatch)) {
      if (entry?.hit) value = entry.value
      await cancel(body)
      return { ok: false, reason: 'precondition-failed' }
    }
    const { ifMatch: _, ifNoneMatch: __, ...rest } = options
    const text = body instanceof Uint8Array ? textOf(body) : null
    const result = await storage.put(key, body, size, rest)
    if (result.ok && text !== null) value = { etag: result.info.etag, text }
    return result
  } finally {
    await cache.release(key, token, value).catch(() => {})
  }
}

export const stateCachedStorage = (storage: Storage, cache: StateCache): Storage => {
  let batch: { readonly keys: Set<string>; readonly result: Promise<ReadonlyMap<string, StateEntry>> } | null = null
  const lookup = (key: string): Promise<StateEntry | undefined> => {
    if (!batch) {
      const keys = new Set<string>()
      const result = new Promise<ReadonlyMap<string, StateEntry>>((resolve) =>
        queueMicrotask(() => {
          batch = null
          cache.get([...keys]).then(resolve, () => resolve(new Map()))
        }),
      )
      batch = { keys, result }
    }
    batch.keys.add(key)
    return batch.result.then((entries) => entries.get(key))
  }
  const cached: Storage = {
    get: async (key, range) => {
      if (range || !STATE_KEY.test(key)) return storage.get(key, range)
      const entry = await lookup(key)
      if (entry?.hit) {
        if (!entry.value) return null
        const bytes = utf8(entry.value.text)
        return { key, size: bytes.length, etag: entry.value.etag, body: streamOf(bytes) }
      }
      const object = await storage.get(key)
      if (!object) {
        await cache.fill(key, null, entry?.version ?? null).catch(() => {})
        return null
      }
      const bytes = await readAll(object.body)
      const text = textOf(bytes)
      if (text !== null) await cache.fill(key, { etag: object.etag, text }, entry?.version ?? null).catch(() => {})
      return { ...object, body: streamOf(bytes) } satisfies StoredObject
    },
    head: (key) => storage.head(key),
    put: async (key, body, size, options) => {
      if (!STATE_KEY.test(key)) return storage.put(key, body, size, options)
      if (cache.lock && cache.release && (options?.ifMatch !== undefined || options?.ifNoneMatch !== undefined)) return lockedPut(storage, { lock: cache.lock, release: cache.release }, key, body, size, options)
      const token = crypto.randomUUID()
      await cache.begin(key, token)
      const text = body instanceof Uint8Array && (options?.ifMatch !== undefined || options?.ifNoneMatch !== undefined) ? textOf(body) : null
      try {
        const result = await storage.put(key, body, size, options)
        await (result.ok && text !== null ? cache.commit(key, token, { etag: result.info.etag, text }) : cache.abort(key, token)).catch(() => {})
        return result
      } catch (error) {
        await cache.abort(key, token).catch(() => {})
        throw error
      }
    },
    list: (prefix) => storage.list(prefix),
  }
  if (storage.putVerified) cached.putVerified = storage.putVerified.bind(storage)
  if (storage.presignGet) cached.presignGet = storage.presignGet.bind(storage)
  if (storage.presignPut) cached.presignPut = storage.presignPut.bind(storage)
  return cached
}
