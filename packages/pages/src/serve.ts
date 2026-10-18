import { checkRepositoryAccess, type Principal, type RepositoryDirectory, type RepositorySubject } from '@git-forge/accounts'
import { ByteLru, isValidName, lfsObjectKey, matchesNoneMatch, mediaPath, parseRange, rangeApplies, type RepositoryName, type Storage } from '@git-forge/core'
import { readManifest } from './deploy.ts'
import { type PagesHosts, matchPagesHost } from './hosts.ts'
import { type Manifest, type ManifestEntry, manifestKey, pagesContentType, resolvePagesPath } from './manifest.ts'
import type { PagesStore } from './store.ts'

export type ServeOptions = {
  readonly storage: Storage
  readonly store: PagesStore
  readonly directory: RepositoryDirectory
  readonly hosts: PagesHosts | null
  readonly forgeUrl: string | null
  readonly authenticateToken: (request: Request) => Promise<Principal | null>
  readonly maxAgeSeconds: number
}

export const CALLBACK_PATH = '/__pages/callback'

export const AUTHORIZE_PATH = '/_pages/authorize'

export const PAGES_SESSION_TTL_SECONDS = 12 * 60 * 60

const manifests = new ByteLru<string, Manifest>(32 * 1024 * 1024)

const text = (status: number, body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } })

export const pagesCookieName = (hosts: PagesHosts): string => (hosts.scheme === 'https' ? '__Host-forge_pages' : 'forge_pages')

const cookie = (request: Request, name: string): string | null => {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return value.join('=')
  }
  return null
}

const safePath = (value: string | null): string => (value && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : '/')

type Site = { readonly repository: RepositorySubject; readonly path: string }

const findSite = async (options: ServeOptions, repo: RepositoryName): Promise<RepositorySubject | null> => {
  if (!isValidName(repo.owner) || !isValidName(repo.name)) return null
  const repository = await options.directory.findRepository(repo.owner, repo.name)
  return repository && (await options.store.site(repository.id)) ? repository : null
}

const locate = async (options: ServeOptions, url: URL): Promise<Site | Response | null> => {
  const match = matchPagesHost(options.hosts, url.host)
  if (!match) return null
  if (match.kind === 'domain') {
    const repository = await findSite(options, match.repo)
    return repository ? { repository, path: url.pathname.slice(1) } : null
  }
  const [, first = '', ...rest] = url.pathname.split('/')
  let segment = ''
  try {
    segment = decodeURIComponent(first)
  } catch {}
  if (segment !== '') {
    const project = await findSite(options, { owner: match.owner, name: segment })
    if (project) {
      if (url.pathname === `/${first}`) return new Response(null, { status: 301, headers: { Location: `/${first}/${url.search}`, 'Cache-Control': `public, max-age=${options.maxAgeSeconds}` } })
      return { repository: project, path: rest.join('/') }
    }
  }
  const user = await findSite(options, { owner: match.owner, name: match.host.replace(/:\d+$/, '') })
  return user ? { repository: user, path: url.pathname.slice(1) } : null
}

const principalOf = async (options: ServeOptions, request: Request, host: string): Promise<Principal> => {
  if (options.hosts) {
    const token = cookie(request, pagesCookieName(options.hosts))
    if (token) {
      const user = await options.store.sessionUser(token, host)
      if (user) return { kind: 'user', id: user.id, login: user.login, limits: null, tokenId: null }
    }
  }
  if (request.headers.has('Authorization')) return (await options.authenticateToken(request)) ?? { kind: 'anonymous' }
  return { kind: 'anonymous' }
}

const loadManifest = async (storage: Storage, repo: RepositoryName, oid: string): Promise<Manifest | null> => {
  const key = manifestKey(repo, oid)
  const cached = manifests.get(key)
  if (cached) return cached
  const manifest = await readManifest(storage, repo, oid)
  if (manifest) manifests.set(key, manifest, Object.keys(manifest.files).length * 160 + 64)
  return manifest
}

type FileContext = {
  readonly request: Request
  readonly options: ServeOptions
  readonly repository: RepositorySubject
  readonly cacheControl: string
  readonly vary: Record<string, string>
}

const serveEntry = async (context: FileContext, path: string, entry: ManifestEntry, status: 200 | 404): Promise<Response> => {
  const { request, options, repository } = context
  const repo = { owner: repository.owner, name: repository.name }
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (entry.lfs && repository.visibility === 'public' && options.forgeUrl && status === 200) {
    return new Response(null, { status: 302, headers: { Location: `${options.forgeUrl}${mediaPath(repo, entry.oid, name)}`, 'Cache-Control': context.cacheControl, ...context.vary } })
  }
  const key = lfsObjectKey(repo, entry.oid)
  const info = await options.storage.head(key)
  if (!info || info.size !== entry.size) return text(404, entry.lfs ? `LFS object ${entry.oid} is not present\n` : 'file is missing\n')
  const headers: Record<string, string> = {
    'Content-Type': pagesContentType(path),
    'Cache-Control': context.cacheControl,
    ETag: `"${entry.oid}"`,
    'X-Content-Type-Options': 'nosniff',
    ...context.vary,
  }
  if (status === 200) headers['Accept-Ranges'] = 'bytes'
  if (status === 200 && matchesNoneMatch(request.headers.get('If-None-Match'), entry.oid)) return new Response(null, { status: 304, headers })
  const range = status === 200 && rangeApplies(request.headers.get('If-Range'), entry.oid) ? parseRange(request.headers.get('Range'), entry.size) : ({ kind: 'full' } as const)
  if (range.kind === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${entry.size}` } })
  const partial = range.kind === 'partial' ? range.range : undefined
  const body = request.method === 'HEAD' ? null : ((await options.storage.get(key, partial))?.body ?? null)
  if (request.method !== 'HEAD' && !body) return text(404, 'file is missing\n')
  return new Response(body as ReadableStream<Uint8Array<ArrayBuffer>> | null, {
    status: partial ? 206 : status,
    headers: {
      ...headers,
      'Content-Length': String(partial ? partial.length : entry.size),
      ...(partial ? { 'Content-Range': `bytes ${partial.offset}-${partial.offset + partial.length - 1}/${entry.size}` } : {}),
    },
  })
}

const callback = async (options: ServeOptions, url: URL): Promise<Response> => {
  const hosts = options.hosts!
  const code = url.searchParams.get('code')
  const userId = code ? await options.store.consumeGrant(code, url.host.toLowerCase()) : null
  if (!userId) return text(400, 'sign-in link expired; reload the page to try again\n')
  const token = await options.store.createSession(userId, url.host.toLowerCase())
  const secure = hosts.scheme === 'https' ? '; Secure' : ''
  return new Response(null, {
    status: 302,
    headers: {
      Location: safePath(url.searchParams.get('path')),
      'Set-Cookie': `${pagesCookieName(hosts)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${PAGES_SESSION_TTL_SECONDS}${secure}`,
      'Cache-Control': 'no-store',
    },
  })
}

export const isPagesRequest = (hosts: PagesHosts | null, request: Request): boolean => matchPagesHost(hosts, new URL(request.url).host) !== null

export const handlePagesRequest = async (request: Request, options: ServeOptions): Promise<Response | null> => {
  const url = new URL(request.url)
  if (!matchPagesHost(options.hosts, url.host)) return null
  if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'method not allowed\n', { Allow: 'GET, HEAD' })
  if (url.pathname === CALLBACK_PATH) return callback(options, url)
  const site = await locate(options, url)
  if (!site) return text(404, 'site not found\n')
  if (site instanceof Response) return site
  const { repository } = site
  const host = url.host.toLowerCase()
  const principal = await principalOf(options, request, host)
  const access = await checkRepositoryAccess(options.directory, principal, { owner: repository.owner, name: repository.name }, 'read')
  if (access.decision !== 'allow') {
    if (principal.kind === 'anonymous' && options.forgeUrl) {
      return new Response(null, {
        status: 302,
        headers: { Location: `${options.forgeUrl}${AUTHORIZE_PATH}?redirect=${encodeURIComponent(url.toString())}`, 'Cache-Control': 'no-store' },
      })
    }
    return text(404, 'site not found\n')
  }
  const active = await options.store.activeDeployment(repository.id)
  const manifest = active?.manifest ? await loadManifest(options.storage, { owner: repository.owner, name: repository.name }, active.manifest) : null
  if (!manifest) return text(404, 'site has not been deployed yet\n')
  const isPublic = repository.visibility === 'public' && principal.kind === 'anonymous'
  const context: FileContext = {
    request,
    options,
    repository,
    cacheControl: isPublic ? `public, max-age=${options.maxAgeSeconds}` : 'private, no-cache',
    vary: isPublic ? {} : { Vary: 'Cookie, Authorization' },
  }
  const resolution = resolvePagesPath(manifest, site.path)
  if (resolution.kind === 'redirect') {
    return new Response(null, { status: 301, headers: { Location: `${resolution.location}${url.search}`, 'Cache-Control': context.cacheControl, ...context.vary } })
  }
  if (resolution.kind === 'file') return serveEntry(context, resolution.path, resolution.entry, 200)
  if (resolution.page) return serveEntry(context, resolution.page.path, resolution.page.entry, 404)
  return text(404, 'not found\n', { 'Cache-Control': context.cacheControl, ...context.vary })
}
