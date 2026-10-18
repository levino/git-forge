import {
  type Authorize,
  createRepository,
  handleContentRequest,
  handleGitRequest,
  isValidName,
  RepositoryExistsError,
  type Storage,
} from '@git-forge/core'

export type ForgeConfig = {
  readonly storage: Storage
  readonly adminToken: string | undefined
  readonly readToken?: string | undefined
  readonly publicRead: boolean
  readonly maxPushBytes: number
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

export const handleRequest = async (request: Request, config: ForgeConfig): Promise<Response> => {
  const url = new URL(request.url)
  if (url.pathname === '/api/admin/repos') {
    if (request.method !== 'POST') return json(405, { error: 'method not allowed' }, { Allow: 'POST' })
    return createRepositoryRoute(request, config)
  }
  if (url.pathname === '/' || url.pathname === '/api/health') return json(200, { ok: true, service: 'git-forge' })
  const authorize = authorizer(config)
  const content = await handleContentRequest(request, { storage: config.storage, authorize })
  if (content) return content
  const git = await handleGitRequest(request, { storage: config.storage, authorize, maxRequestBytes: config.maxPushBytes })
  return git ?? json(404, { error: 'not found' })
}
