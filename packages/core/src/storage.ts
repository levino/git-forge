export type ObjectInfo = {
  readonly key: string
  readonly size: number
  readonly etag: string
}

export type StoredObject = ObjectInfo & {
  readonly body: ReadableStream<Uint8Array>
}

export type ByteRange = {
  readonly offset: number
  readonly length: number
}

export type PutOptions = {
  readonly ifMatch?: string
  readonly ifNoneMatch?: '*'
  readonly contentType?: string
}

export type PutBody = Uint8Array | ReadableStream<Uint8Array>

export type PutResult = { readonly ok: true; readonly info: ObjectInfo } | { readonly ok: false; readonly reason: 'precondition-failed' }

export type PresignedPut = {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly expiresAt: Date
}

export interface Storage {
  get(key: string, range?: ByteRange): Promise<StoredObject | null>
  head(key: string): Promise<ObjectInfo | null>
  put(key: string, body: PutBody, size: number, options?: PutOptions): Promise<PutResult>
  list(prefix: string): AsyncIterable<ObjectInfo>
  presignGet?(key: string, expiresInSeconds: number): Promise<string>
  presignPut?(key: string, size: number, sha256Hex: string, expiresInSeconds: number): Promise<PresignedPut>
}

export type Presigner = Required<Pick<Storage, 'presignGet' | 'presignPut'>>

export const withPresigner = (storage: Storage, presigner: Presigner): Storage => ({
  get: (key, range) => storage.get(key, range),
  head: (key) => storage.head(key),
  put: (key, body, size, options) => storage.put(key, body, size, options),
  list: (prefix) => storage.list(prefix),
  presignGet: (key, expiresInSeconds) => presigner.presignGet(key, expiresInSeconds),
  presignPut: (key, size, sha256Hex, expiresInSeconds) => presigner.presignPut(key, size, sha256Hex, expiresInSeconds),
})

export type RepositoryLocation = { readonly path: string | null; readonly live: boolean }

export type LocateRepository = (owner: string, name: string) => Promise<RepositoryLocation | null>

export class RepositoryGoneError extends Error {}

export const LOCATION_CACHE_MS = 30_000

const REPOSITORY_KEY = /^((?:tmp\/)?repos\/)([^/]+)\/([^/]+)\//

type Mapped = { readonly key: string; readonly logical: string; readonly physical: string } | null

export const locatedStorage = (storage: Storage, locate: LocateRepository, now: () => number = Date.now): Storage => {
  const cache = new Map<string, { readonly path: string; readonly until: number }>()
  const pathOf = async (owner: string, name: string): Promise<string | null | undefined> => {
    const id = `${owner}/${name}`.toLowerCase()
    const cached = cache.get(id)
    if (cached && cached.until > now()) return cached.path
    const location = await locate(owner, name)
    if (location?.live && location.path !== null) {
      if (cache.size > 10_000) cache.clear()
      cache.set(id, { path: location.path, until: now() + LOCATION_CACHE_MS })
    }
    return location === null ? undefined : location.path
  }
  const map = async (key: string): Promise<Mapped> => {
    const match = REPOSITORY_KEY.exec(key)
    if (!match) return { key, logical: '', physical: '' }
    const path = await pathOf(match[2]!, match[3]!)
    if (path === null) return null
    const physical = path === undefined ? match[0] : `${match[1]}${path}/`
    return { key: physical + key.slice(match[0].length), logical: match[0], physical }
  }
  const writable = async (key: string): Promise<string> => {
    const mapped = await map(key)
    if (!mapped) throw new RepositoryGoneError(`${key} belongs to a deleted repository`)
    return mapped.key
  }
  const located: Storage = {
    get: async (key, range) => {
      const mapped = await map(key)
      return mapped ? storage.get(mapped.key, range) : null
    },
    head: async (key) => {
      const mapped = await map(key)
      return mapped ? storage.head(mapped.key) : null
    },
    put: async (key, body, size, options) => storage.put(await writable(key), body, size, options),
    list: async function* (prefix) {
      const mapped = await map(prefix)
      if (!mapped) return
      for await (const info of storage.list(mapped.key)) {
        yield info.key.startsWith(mapped.physical) ? { ...info, key: mapped.logical + info.key.slice(mapped.physical.length) } : info
      }
    },
  }
  if (storage.presignGet) located.presignGet = async (key, seconds) => storage.presignGet!(await writable(key), seconds)
  if (storage.presignPut) located.presignPut = async (key, size, sha256, seconds) => storage.presignPut!(await writable(key), size, sha256, seconds)
  return located
}
