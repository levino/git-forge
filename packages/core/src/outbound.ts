import { type FetchFunction, RemoteError } from './remote.ts'

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./]

export const isPrivateHost = (hostname: string): boolean => {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return PRIVATE_V4.some((pattern) => pattern.test(host)) || host === '255.255.255.255'
  if (host.includes(':')) return host === '::' || host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:')
  return false
}

export type OutboundOptions = {
  readonly allowPrivateHosts?: boolean
  readonly fetch?: FetchFunction
  readonly maxRedirects?: number
}

export const outboundUrlError = (value: string, options: OutboundOptions = {}): string | null => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return `invalid URL ${value}`
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return `${url.origin} must use http or https`
  if (!options.allowPrivateHosts && isPrivateHost(url.hostname)) return `${url.host} is a private or local address`
  return null
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])

export const outboundFetch = (options: OutboundOptions = {}): FetchFunction => {
  const send = options.fetch ?? ((request: Request) => fetch(request))
  const maxRedirects = options.maxRedirects ?? 5
  return async (request) => {
    const manual = request.redirect === 'manual'
    const body = request.body ? await request.arrayBuffer() : null
    let url = request.url
    let method = request.method
    const headers = new Headers(request.headers)
    for (let hop = 0; ; hop++) {
      const invalid = outboundUrlError(url, options)
      if (invalid) throw new RemoteError(`refusing to fetch: ${invalid}`)
      const response = await send(new Request(url, { method, headers, redirect: 'manual', signal: request.signal, ...(body && method !== 'GET' && method !== 'HEAD' ? { body } : {}) }))
      const location = response.headers.get('Location')
      if (manual || !REDIRECTS.has(response.status) || !location) return response
      if (hop >= maxRedirects) throw new RemoteError(`too many redirects from ${request.url}`)
      await response.body?.cancel()
      const next = new URL(location, url)
      if (next.origin !== new URL(url).origin) headers.delete('Authorization')
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) method = method === 'HEAD' ? 'HEAD' : 'GET'
      url = next.href
    }
  }
}
