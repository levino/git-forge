import { handleWellKnownRequest, normalizeIssuer } from '@git-forge/accounts'
import {
  type Authorize,
  configureMirror,
  createRepository,
  deepCheckMirror,
  listMirrors,
  MirrorExistsError,
  readMirrorConfig,
  readMirrorStatus,
  type RepositoryName,
  handleContentRequest,
  handleGitRequest,
  isValidName,
  RepositoryExistsError,
  type Storage,
} from '@git-forge/core'
import {
  configureMirrorFederation,
  handleFederationRequest,
  type MirrorFederation,
  notifyAfterPush,
  runMirrorSync,
} from './mirror-federation.ts'

export type ForgeConfig = {
  readonly storage: Storage
  readonly adminToken: string | undefined
  readonly readToken?: string | undefined
  readonly publicRead: boolean
  readonly maxPushBytes: number
  readonly federation?: MirrorFederation
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

const digest = async (value: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))

export const tokenMatches = async (presented: string, expected: string | undefined): Promise<boolean> => {
  if (!expected) return false
  const [a, b] = await Promise.all([digest(presented), digest(expected)])
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!
  return difference === 0
}

export const presentedToken = (request: Request): string | null => {
  const header = request.headers.get('Authorization') ?? ''
  const [scheme, value] = header.split(' ', 2) as [string, string | undefined]
  if (!value) return null
  if (scheme.toLowerCase() === 'bearer') return value
  if (scheme.toLowerCase() !== 'basic') return null
  try {
    const decoded = atob(value)
    const colon = decoded.indexOf(':')
    return colon === -1 ? null : decoded.slice(colon + 1)
  } catch {
    return null
  }
}

const unauthorized = () =>
  new Response('authentication required\n', {
    status: 401,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'WWW-Authenticate': 'Basic realm="git-forge", charset="UTF-8"' },
  })

const isAdmin = async (request: Request, config: ForgeConfig): Promise<boolean> => {
  const token = presentedToken(request)
  return token !== null && (await tokenMatches(token, config.adminToken))
}

const isReader = async (request: Request, config: ForgeConfig): Promise<boolean> => {
  const token = presentedToken(request)
  return token !== null && (await tokenMatches(token, config.readToken))
}

const authorizer =
  (config: ForgeConfig): Authorize =>
  async (request, _repo, access) => {
    if (access === 'read' && (config.publicRead || (await isReader(request, config)))) return null
    return (await isAdmin(request, config)) ? null : unauthorized()
  }

type CreateRepositoryBody = { owner?: unknown; name?: unknown; defaultBranch?: unknown }

const createRepositoryRoute = async (request: Request, config: ForgeConfig): Promise<Response> => {
  if (!config.adminToken) return json(503, { error: 'ADMIN_TOKEN is not configured' })
  if (!(await isAdmin(request, config))) return json(401, { error: 'invalid admin token' }, { 'WWW-Authenticate': 'Bearer' })
  let body: CreateRepositoryBody
  try {
    body = (await request.json()) as CreateRepositoryBody
  } catch {
    return json(400, { error: 'expected a JSON body' })
  }
  const { owner, name } = body
  const defaultBranch = body.defaultBranch ?? 'main'
  if (typeof owner !== 'string' || typeof name !== 'string' || !isValidName(owner) || !isValidName(name)) {
    return json(400, { error: 'owner and name must match [A-Za-z0-9][A-Za-z0-9._-]* and must not end in .git' })
  }
  if (typeof defaultBranch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(defaultBranch) || defaultBranch.includes('..')) {
    return json(400, { error: 'invalid defaultBranch' })
  }
  try {
    await createRepository(config.storage, { owner, name }, defaultBranch)
  } catch (error) {
    if (error instanceof RepositoryExistsError) return json(409, { error: `${owner}/${name} already exists` })
    throw error
  }
  const cloneUrl = new URL(`/${owner}/${name}.git`, request.url).toString()
  return json(201, { owner, name, defaultBranch, cloneUrl })
}

type JsonBody = Record<string, unknown>

const readJson = async (request: Request): Promise<JsonBody | null> => {
  try {
    const value: unknown = await request.json()
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonBody) : null
  } catch {
    return null
  }
}

const optional = (body: JsonBody, key: string): string | undefined => (typeof body[key] === 'string' ? (body[key] as string) : undefined)

const MIRRORS_ROUTE = /^\/api\/repos\/([^/]+)\/([^/]+)\/mirrors(?:\/([^/]+)\/(sync|verify))?$/

const federationAdminRoute = async (request: Request, config: ForgeConfig, federation: MirrorFederation): Promise<Response | null> => {
  const url = new URL(request.url)
  const mirrors = MIRRORS_ROUTE.exec(url.pathname)
  if (url.pathname !== '/api/admin/instances' && !mirrors) return null
  if (!config.adminToken) return json(503, { error: 'ADMIN_TOKEN is not configured' })
  if (!(await isAdmin(request, config))) return json(401, { error: 'invalid admin token' }, { 'WWW-Authenticate': 'Bearer' })
  if (!mirrors) {
    if (request.method !== 'POST') return json(405, { error: 'method not allowed' }, { Allow: 'POST' })
    const body = await readJson(request)
    const issuer = body && optional(body, 'issuer')
    if (!issuer) return json(400, { error: 'issuer is required' })
    const pinnedThumbprint = optional(body, 'pinnedThumbprint') ?? null
    await federation.store.trustInstance({ issuer, pinnedThumbprint })
    return json(200, { issuer: normalizeIssuer(issuer), pinnedThumbprint })
  }
  const [, owner = '', name = '', remote, action] = mirrors
  if (!isValidName(owner) || !isValidName(name)) return json(404, { error: 'repository not found' })
  const repo: RepositoryName = { owner, name }
  if (remote && action) {
    if (request.method !== 'POST') return json(405, { error: 'method not allowed' }, { Allow: 'POST' })
    if (!(await readMirrorConfig(config.storage, repo, remote))) return json(404, { error: 'mirror not configured' })
    if (action === 'verify') return json(200, await deepCheckMirror(config.storage, repo, remote))
    const result = await runMirrorSync(federation, repo, remote)
    return json(result.status === 'failed' ? 502 : 200, result)
  }
  if (request.method === 'GET') {
    const configs = await listMirrors(config.storage, repo)
    return json(200, await Promise.all(configs.map(async (mirror) => ({ config: mirror, status: await readMirrorStatus(config.storage, repo, mirror.remote) }))))
  }
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' }, { Allow: 'GET, POST' })
  const body = await readJson(request)
  const upstream = body && optional(body, 'url')
  if (!body || !upstream) return json(400, { error: 'url is required' })
  const remoteName = optional(body, 'remote')
  const namespace = optional(body, 'namespace')
  const lfsUrl = optional(body, 'lfsUrl')
  try {
    const mirror = await configureMirror(config.storage, repo, {
      url: upstream,
      ...(remoteName ? { remote: remoteName } : {}),
      ...(namespace !== undefined ? { namespace } : {}),
      ...(typeof body.lfs === 'boolean' ? { lfs: body.lfs } : {}),
      ...(lfsUrl ? { lfsUrl } : {}),
    })
    await configureMirrorFederation(federation, repo, mirror)
    return json(201, mirror)
  } catch (error) {
    if (error instanceof MirrorExistsError) return json(409, { error: error.message })
    return json(400, { error: (error as Error).message })
  }
}

export const handleRequest = async (request: Request, config: ForgeConfig): Promise<Response> => {
  const url = new URL(request.url)
  if (url.pathname === '/api/admin/repos') {
    if (request.method !== 'POST') return json(405, { error: 'method not allowed' }, { Allow: 'POST' })
    return createRepositoryRoute(request, config)
  }
  if (url.pathname === '/' || url.pathname === '/api/health') return json(200, { ok: true, service: 'git-forge' })
  const { federation } = config
  if (federation) {
    const wellKnown = handleWellKnownRequest(request, { issuer: federation.issuer, keys: [federation.key.publicJwk] })
    if (wellKnown) return wellKnown
    const handled = (await handleFederationRequest(federation, request)) ?? (await federationAdminRoute(request, config, federation))
    if (handled) return handled
  }
  const authorize = authorizer(config)
  const content = await handleContentRequest(request, { storage: config.storage, authorize })
  if (content) return content
  const git = await handleGitRequest(request, {
    storage: config.storage,
    authorize,
    maxRequestBytes: config.maxPushBytes,
    ...(federation ? { onPush: notifyAfterPush(federation) } : {}),
  })
  return git ?? json(404, { error: 'not found' })
}
