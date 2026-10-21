import type { CachedObject, ObjectCache } from '@git-forge/core'

export type CacheApiOptions = {
  readonly cache?: Cache | Promise<Cache>
  readonly origin?: string
}

export const cacheApi = (options: CacheApiOptions, fallbackOrigin: string) => {
  const opened = Promise.resolve(options.cache ?? (caches as unknown as { readonly default: Cache }).default)
  const origin = (options.origin ?? fallbackOrigin).replace(/\/+$/, '')
  return { cache: () => opened, url: (key: string) => `${origin}/${encodeURIComponent(key)}` }
}

export const cacheApiObjectCache = (options: CacheApiOptions = {}): ObjectCache => {
  const { cache, url } = cacheApi(options, 'https://object-cache.git-forge.internal')
  return {
    get: async (key): Promise<CachedObject | null> => {
      const response = await (await cache()).match(url(key))
      if (!response) return null
      return { key, size: Number(response.headers.get('X-Size')), etag: response.headers.get('X-Etag') ?? '', bytes: new Uint8Array(await response.arrayBuffer()) }
    },
    put: async (key, object) =>
      (await cache()).put(url(key), new Response(object.bytes as Uint8Array<ArrayBuffer>, { headers: { 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Size': String(object.size), 'X-Etag': object.etag } })),
  }
}
