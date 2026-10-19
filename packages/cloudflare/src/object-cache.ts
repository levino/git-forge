import type { CachedObject, ObjectCache } from '@git-forge/core'

export const cacheApiObjectCache = (cache: Cache = (caches as unknown as { readonly default: Cache }).default): ObjectCache => {
  const url = (key: string) => `https://object-cache.git-forge.internal/${encodeURIComponent(key)}`
  return {
    get: async (key): Promise<CachedObject | null> => {
      const response = await cache.match(url(key))
      if (!response) return null
      return { key, size: Number(response.headers.get('X-Size')), etag: response.headers.get('X-Etag') ?? '', bytes: new Uint8Array(await response.arrayBuffer()) }
    },
    put: (key, object) =>
      cache.put(url(key), new Response(object.bytes, { headers: { 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Size': String(object.size), 'X-Etag': object.etag } })),
  }
}
