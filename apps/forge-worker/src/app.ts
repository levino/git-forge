import {
  type Authorize,
  createRepository,
  handleGitRequest,
  type ImportScheduler,
  ImportRunningError,
  isValidName,
  readImportState,
  RepositoryExistsError,
  startImport,
  type Storage,
} from '@git-forge/core'

export type ForgeConfig = {
  readonly storage: Storage
  readonly adminToken: string | undefined
  readonly publicRead: boolean
  readonly maxPushBytes: number
  readonly scheduleImport?: ImportScheduler
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

const authorizer =
  (config: ForgeConfig): Authorize =>
  async (request, _repo, access) =>
    (access === 'read' && config.publicRead) || (await isAdmin(request, config)) ? null : unauthorized()

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

export const basicAuthorization = (username: string, password: string): string => {
  const bytes = new TextEncoder().encode(`${username}:${password}`)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `Basic ${btoa(binary)}`
}

type ImportBody = {
  url?: unknown
  token?: unknown
  username?: unknown
  lfs?: unknown
  lfsUrl?: unknown
  commitsPerStep?: unknown
  defaultBranch?: unknown
}

const optional = <T>(value: unknown, check: (value: unknown) => value is T): T | undefined | null =>
  value === undefined ? undefined : check(value) ? value : null

const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const importRoute = async (request: Request, config: ForgeConfig, owner: string, name: string): Promise<Response> => {
  if (!config.adminToken) return json(503, { error: 'ADMIN_TOKEN is not configured' })
  if (!(await isAdmin(request, config))) return json(401, { error: 'invalid admin token' }, { 'WWW-Authenticate': 'Bearer' })
  const repo = { owner, name }
  if (request.method === 'GET') {
    const state = await readImportState(config.storage, repo)
    return state ? json(200, state) : json(404, { error: `no import for ${owner}/${name}` })
  }
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' }, { Allow: 'GET, POST' })
  if (!config.scheduleImport) return json(503, { error: 'imports need a queue (IMPORTS binding)' })
  let body: ImportBody
  try {
    body = (await request.json()) as ImportBody
  } catch {
    return json(400, { error: 'expected a JSON body' })
  }
  const token = optional(body.token, isString)
  const username = optional(body.username, isString)
  const lfs = optional(body.lfs, isBoolean)
  const lfsUrl = optional(body.lfsUrl, isString)
  const commitsPerStep = optional(body.commitsPerStep, isCount)
  const defaultBranch = optional(body.defaultBranch, isString)
  if (!isString(body.url) || [token, username, lfs, lfsUrl, commitsPerStep, defaultBranch].includes(null)) {
    return json(400, { error: 'expected {"url": string, "token"?: string, "username"?: string, "lfs"?: boolean, "lfsUrl"?: string, "commitsPerStep"?: number, "defaultBranch"?: string}' })
  }
  if (defaultBranch !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(defaultBranch as string) || (defaultBranch as string).includes('..'))) {
    return json(400, { error: 'invalid defaultBranch' })
  }
  let state
  try {
    state = await startImport(config.storage, repo, {
      url: body.url,
      ...(lfs !== undefined ? { lfs: lfs as boolean } : {}),
      ...(lfsUrl ? { lfsUrl } : {}),
      ...(commitsPerStep ? { commitsPerStep } : {}),
      ...(defaultBranch ? { defaultBranch } : {}),
    })
  } catch (error) {
    if (error instanceof ImportRunningError) return json(409, { error: error.message })
    return json(400, { error: error instanceof Error ? error.message : String(error) })
  }
  await config.scheduleImport({ owner, name, ...(token ? { authorization: basicAuthorization(username ?? 'git', token) } : {}) }, 0)
  const statusUrl = new URL(`/api/admin/repos/${owner}/${name}/import`, request.url).toString()
  return json(202, { ...state, statusUrl, cloneUrl: new URL(`/${owner}/${name}.git`, request.url).toString() }, { Location: statusUrl })
}

const IMPORT_ROUTE = /^\/api\/admin\/repos\/([^/]+)\/([^/]+)\/import$/

export const handleRequest = async (request: Request, config: ForgeConfig): Promise<Response> => {
  const url = new URL(request.url)
  if (url.pathname === '/api/admin/repos') {
    if (request.method !== 'POST') return json(405, { error: 'method not allowed' }, { Allow: 'POST' })
    return createRepositoryRoute(request, config)
  }
  const importMatch = IMPORT_ROUTE.exec(url.pathname)
  if (importMatch) {
    const [, owner, name] = importMatch as unknown as [string, string, string]
    if (!isValidName(owner) || !isValidName(name)) return json(400, { error: 'invalid repository name' })
    return importRoute(request, config, owner, name)
  }
  if (url.pathname === '/' || url.pathname === '/api/health') return json(200, { ok: true, service: 'git-forge' })
  const git = await handleGitRequest(request, {
    storage: config.storage,
    authorize: authorizer(config),
    maxRequestBytes: config.maxPushBytes,
  })
  return git ?? json(404, { error: 'not found' })
}
