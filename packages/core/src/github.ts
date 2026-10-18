import { fromHex, utf8 } from './bytes.ts'
import type { FetchFunction } from './remote.ts'

export const GITHUB_API = 'https://api.github.com'

export const GITHUB_SIGNATURE_HEADER = 'X-Hub-Signature-256'

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

const hmacKey = (secret: string, usage: 'sign' | 'verify') =>
  crypto.subtle.importKey('raw', utf8(secret) as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-256' }, false, [usage])

export const githubSignature = async (secret: string, body: Uint8Array): Promise<string> => {
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), body as Uint8Array<ArrayBuffer>))
  return `sha256=${[...mac].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export const verifyGitHubSignature = async (secret: string, body: Uint8Array, header: string | null): Promise<boolean> => {
  const hex = /^sha256=([0-9a-f]{64})$/i.exec(header?.trim() ?? '')?.[1]
  if (!secret || !hex) return false
  return crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), fromHex(hex.toLowerCase()) as Uint8Array<ArrayBuffer>, body as Uint8Array<ArrayBuffer>)
}

export const githubRepositoryOf = (url: string): string | null => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.hostname.toLowerCase() !== 'github.com') return null
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(parsed.pathname)
  return match ? `${match[1]}/${match[2]}` : null
}

export type GitHubClient = {
  readonly token?: string
  readonly fetch?: FetchFunction
  readonly api?: string
}

const request = async <T>(client: GitHubClient, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ value: T; next: string | null }> => {
  const url = /^https?:/.test(path) ? path : `${client.api ?? GITHUB_API}${path}`
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'git-forge' }
  if (client.token) headers.Authorization = `Bearer ${client.token}`
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await (client.fetch ?? fetch)(
    new Request(url, { method: init.method ?? 'GET', headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }),
  )
  const text = await response.text()
  if (!response.ok) {
    let message = text.slice(0, 200)
    try {
      message = String((JSON.parse(text) as { message?: unknown }).message ?? message)
    } catch {}
    throw new GitHubApiError(`GitHub ${init.method ?? 'GET'} ${new URL(url).pathname} failed with HTTP ${response.status}: ${message}`, response.status)
  }
  const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('Link') ?? '')?.[1] ?? null
  return { value: (text ? JSON.parse(text) : null) as T, next }
}

export type GitHubRepository = {
  readonly name: string
  readonly fullName: string
  readonly cloneUrl: string
  readonly private: boolean
  readonly fork: boolean
  readonly archived: boolean
  readonly defaultBranch: string
}

export type GitHubListOptions = GitHubClient & {
  readonly account: string
  readonly forks?: boolean
  readonly archived?: boolean
  readonly maxPages?: number
}

type RepositoryJson = { name: string; full_name: string; clone_url: string; private: boolean; fork: boolean; archived: boolean; default_branch: string; owner: { login: string } }

const listPath = async (options: GitHubListOptions): Promise<string> => {
  const account = encodeURIComponent(options.account)
  if (options.token) {
    const { value: user } = await request<{ login: string }>(options, '/user')
    if (user.login.toLowerCase() === options.account.toLowerCase()) return '/user/repos?affiliation=owner&per_page=100'
  }
  const { value: owner } = await request<{ type: string }>(options, `/users/${account}`)
  return owner.type === 'Organization' ? `/orgs/${account}/repos?type=all&per_page=100` : `/users/${account}/repos?type=owner&per_page=100`
}

export const listGitHubRepositories = async (options: GitHubListOptions): Promise<GitHubRepository[]> => {
  const repositories: GitHubRepository[] = []
  let next: string | null = await listPath(options)
  for (let page = 0; next && page < (options.maxPages ?? 100); page++) {
    const result: { value: RepositoryJson[]; next: string | null } = await request<RepositoryJson[]>(options, next)
    for (const repo of result.value) {
      if (repo.owner.login.toLowerCase() !== options.account.toLowerCase()) continue
      if ((repo.fork && !options.forks) || (repo.archived && options.archived === false)) continue
      repositories.push({
        name: repo.name,
        fullName: repo.full_name,
        cloneUrl: repo.clone_url,
        private: repo.private,
        fork: repo.fork,
        archived: repo.archived,
        defaultBranch: repo.default_branch,
      })
    }
    next = result.next
  }
  return repositories
}

export type GitHubHook = { readonly id: number; readonly created: boolean }

type HookJson = { id: number; config: { url?: string } }

export const registerGitHubWebhook = async (client: GitHubClient & { readonly repository: string; readonly url: string; readonly secret: string }): Promise<GitHubHook> => {
  const base = `/repos/${client.repository.split('/').map(encodeURIComponent).join('/')}/hooks`
  const config = { url: client.url, content_type: 'json', secret: client.secret, insecure_ssl: '0' }
  let next: string | null = `${base}?per_page=100`
  while (next) {
    const page: { value: HookJson[]; next: string | null } = await request<HookJson[]>(client, next)
    const existing = page.value.find((hook) => hook.config.url === client.url)
    if (existing) {
      await request(client, `${base}/${existing.id}`, { method: 'PATCH', body: { active: true, events: ['push'], config } })
      return { id: existing.id, created: false }
    }
    next = page.next
  }
  const { value } = await request<HookJson>(client, base, { method: 'POST', body: { name: 'web', active: true, events: ['push'], config } })
  return { id: value.id, created: true }
}
