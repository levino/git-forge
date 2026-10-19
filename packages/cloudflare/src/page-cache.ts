export type ResponseCache = {
  readonly match: (key: string) => Promise<Response | null>
  readonly put: (key: string, response: Response) => Promise<void>
}

const ORIGINAL = 'X-Forge-Cache-Control'

export const cacheApiPageCache = (maxAgeSeconds: number, cache: Cache = (caches as unknown as { readonly default: Cache }).default): ResponseCache => {
  const url = (key: string) => `https://page-cache.git-forge.internal/${encodeURIComponent(key)}`
  return {
    match: async (key) => {
      const response = await cache.match(url(key))
      if (!response) return null
      const headers = new Headers(response.headers)
      const original = headers.get(ORIGINAL)
      headers.delete(ORIGINAL)
      headers.delete('Age')
      if (original) headers.set('Cache-Control', original)
      else headers.delete('Cache-Control')
      return new Response(response.body, { status: response.status, headers })
    },
    put: async (key, response) => {
      if (response.headers.has('Set-Cookie')) return
      const headers = new Headers(response.headers)
      const original = headers.get('Cache-Control')
      if (original) headers.set(ORIGINAL, original)
      headers.set('Cache-Control', `public, max-age=${maxAgeSeconds}`)
      headers.delete('Vary')
      await cache.put(url(key), new Response(response.body, { status: response.status, headers }))
    },
  }
}
