import { toHex, utf8 } from '@git-forge/accounts'
import { apiUrl, htmlUrl, userObject } from './events.ts'
import type { HookRow, RepositoryRow } from './store.ts'

export const WEBHOOK_USER_AGENT = 'GitHub-Hookshot/git-forge'

export const WEBHOOK_TIMEOUT_MS = 10_000

export const WEBHOOK_MAX_ATTEMPTS = 5

export const WEBHOOK_RESPONSE_LIMIT = 64 * 1024

export const webhookRetryDelaySeconds = (attempt: number): number => Math.min(3600, 30 * 4 ** Math.max(0, attempt - 1))

const hmac = async (algorithm: 'SHA-1' | 'SHA-256', secret: string, body: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: algorithm }, false, ['sign'])
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(body))))
}

export const signatureHeaders = async (secret: string | null, body: string): Promise<Record<string, string>> =>
  secret
    ? { 'X-Hub-Signature': `sha1=${await hmac('SHA-1', secret, body)}`, 'X-Hub-Signature-256': `sha256=${await hmac('SHA-256', secret, body)}` }
    : {}

export const verifySignature = async (secret: string, body: string, header: string | null): Promise<boolean> => {
  if (!header?.startsWith('sha256=')) return false
  const expected = `sha256=${await hmac('SHA-256', secret, body)}`
  if (expected.length !== header.length) return false
  let difference = 0
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ header.charCodeAt(i)
  return difference === 0
}

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./]

const isPrivateHost = (hostname: string): boolean => {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return PRIVATE_V4.some((pattern) => pattern.test(host)) || host === '255.255.255.255'
  if (host.includes(':')) return host === '::' || host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:')
  return false
}

export const validateWebhookUrl = (value: string, options: { readonly allowInsecure: boolean }): string | null => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'url must be an absolute URL'
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'url must use http or https'
  if (url.username || url.password) return 'url must not contain credentials'
  if (url.hash) return 'url must not contain a fragment'
  if (options.allowInsecure) return null
  if (url.protocol !== 'https:') return 'url must use https'
  if (isPrivateHost(url.hostname)) return 'url must not point to a private or local address'
  return null
}

export const repositoryObject = (baseUrl: string, repository: RepositoryRow, defaultBranch: string | null) => {
  const path = `${repository.owner_login}/${repository.name}`
  return {
    id: repository.id,
    node_id: repository.id,
    name: repository.name,
    full_name: path,
    private: repository.visibility === 'private',
    visibility: repository.visibility,
    owner: { ...userObject(baseUrl, repository.owner_login, repository.owner_id), type: repository.owner_kind === 'organization' ? 'Organization' : 'User' },
    html_url: htmlUrl(baseUrl, `/${path}`),
    url: apiUrl(baseUrl, `/repos/${path}`),
    clone_url: htmlUrl(baseUrl, `/${path}.git`),
    git_url: htmlUrl(baseUrl, `/${path}.git`),
    hooks_url: apiUrl(baseUrl, `/repos/${path}/hooks`),
    releases_url: apiUrl(baseUrl, `/repos/${path}/releases{/id}`),
    default_branch: defaultBranch,
    master_branch: defaultBranch,
    created_at: new Date(repository.created_at).toISOString(),
  }
}

export const organizationObject = (baseUrl: string, repository: RepositoryRow) =>
  repository.owner_kind === 'organization'
    ? {
        login: repository.owner_login,
        id: repository.owner_id,
        url: apiUrl(baseUrl, `/orgs/${repository.owner_login}`),
        hooks_url: apiUrl(baseUrl, `/orgs/${repository.owner_login}/hooks`),
      }
    : null

export const hookEvents = (hook: HookRow): string[] => JSON.parse(hook.events) as string[]

export const hookObject = (baseUrl: string, hook: HookRow, scopePath: string) => ({
  type: hook.repository_id ? 'Repository' : hook.app_id ? 'App' : 'Organization',
  id: hook.id,
  name: 'web',
  active: hook.active === 1,
  events: hookEvents(hook),
  config: hookConfig(hook),
  updated_at: new Date(hook.updated_at).toISOString(),
  created_at: new Date(hook.created_at).toISOString(),
  url: apiUrl(baseUrl, `${scopePath}/hooks/${hook.id}`),
  ping_url: apiUrl(baseUrl, `${scopePath}/hooks/${hook.id}/pings`),
  deliveries_url: apiUrl(baseUrl, `${scopePath}/hooks/${hook.id}/deliveries`),
  ...(hook.repository_id ? { test_url: apiUrl(baseUrl, `${scopePath}/hooks/${hook.id}/tests`) } : {}),
})

export const hookConfig = (hook: HookRow) => ({
  url: hook.url,
  content_type: hook.content_type,
  insecure_ssl: hook.insecure_ssl === 1 ? '1' : '0',
  ...(hook.secret ? { secret: '********' } : {}),
})

export type DeliveryRequest = {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string
}

export const buildDeliveryRequest = async (
  hook: HookRow,
  delivery: { readonly guid: string; readonly event: string; readonly payload: string },
  secret: string | null,
): Promise<DeliveryRequest> => {
  const body = hook.content_type === 'form' ? `payload=${encodeURIComponent(delivery.payload)}` : delivery.payload
  return {
    url: hook.url,
    body,
    headers: {
      Accept: '*/*',
      'Content-Type': hook.content_type === 'form' ? 'application/x-www-form-urlencoded' : 'application/json',
      'User-Agent': WEBHOOK_USER_AGENT,
      'X-GitHub-Event': delivery.event,
      'X-GitHub-Delivery': delivery.guid,
      'X-GitHub-Hook-ID': String(hook.id),
      'X-GitHub-Hook-Installation-Target-Type': hook.repository_id ? 'repository' : hook.app_id ? 'integration' : 'organization',
      'X-GitHub-Hook-Installation-Target-ID': hook.repository_id ?? hook.organization_id ?? hook.app_id ?? '',
      ...(await signatureHeaders(secret, body)),
    },
  }
}

export type DeliveryOutcome = {
  readonly ok: boolean
  readonly retryable: boolean
  readonly statusCode: number | null
  readonly durationMs: number
  readonly error: string | null
  readonly responseHeaders: Record<string, string> | null
  readonly responseBody: string | null
}

const readLimited = async (response: Response, limit: number): Promise<string> => {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const room = limit - size
    chunks.push(value.length > room ? value.subarray(0, room) : value)
    size += Math.min(value.length, room)
    if (size >= limit) {
      await reader.cancel()
      break
    }
  }
  const joined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(joined)
}

export const sendDelivery = async (request: DeliveryRequest, fetcher: (request: Request) => Promise<Response>, now: () => number = Date.now): Promise<DeliveryOutcome> => {
  const started = now()
  try {
    const response = await fetcher(
      new Request(request.url, { method: 'POST', headers: request.headers, body: request.body, redirect: 'manual', signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) }),
    )
    const responseBody = await readLimited(response, WEBHOOK_RESPONSE_LIMIT)
    const ok = response.status >= 200 && response.status < 300
    return {
      ok,
      retryable: !ok && (response.status >= 500 || response.status === 429 || response.status === 408),
      statusCode: response.status,
      durationMs: now() - started,
      error: ok ? null : `HTTP ${response.status}`,
      responseHeaders: Object.fromEntries(response.headers),
      responseBody,
    }
  } catch (error) {
    return { ok: false, retryable: true, statusCode: null, durationMs: now() - started, error: (error as Error).message || String(error), responseHeaders: null, responseBody: null }
  }
}

const ZEN = ['Keep it logically awesome.', 'Speak like a human.', 'Design for failure.', 'Anything added dilutes everything else.', 'Approachable is better than simple.']

export const pingZen = (id: number): string => ZEN[id % ZEN.length]!
