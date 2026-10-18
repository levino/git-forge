import {
  type AccountsStore,
  AccountsError,
  authenticateRequest,
  checkRepositoryAccess,
  createAccountsStore,
  createGitAccess,
  createInstanceVerifier,
  createJwksCache,
  type Database,
  type Decision,
  handleBranchProtectionRequest,
  handleWellKnownRequest,
  isRole,
  isTokenScope,
  type JwksSource,
  normalizeIssuer,
  type Principal,
  type RepositorySubject,
  type UserPrincipal,
} from '@git-forge/accounts'
import {
  configureMirror,
  createRepository,
  deepCheckMirror,
  detachMirror,
  type FetchFunction,
  handleContentRequest,
  handleGitRequest,
  type JobQueue,
  type ImportScheduler,
  ImportRunningError,
  isValidImportUrl,
  isValidName,
  listMirrors,
  MirrorExistsError,
  MirrorNotFoundError,
  readAll,
  readMirrorConfig,
  readImportState,
  readMirrorStatus,
  RepositoryExistsError,
  type RepositoryName,
  SizeLimitError,
  startImport,
  type Storage,
} from '@git-forge/core'
import type { ForgeSettings } from './config.ts'
import {
  enqueueDueMirrors,
  enqueueMirrorSetup,
  type ForgeJob,
  handleFederationRequest,
  type MirrorFederation,
  notifyAfterPush,
  runJob,
  syncAndNotify,
} from './mirror-federation.ts'
import { MirrorAuthError, type MirrorContext, runMirrorSync, type ScheduledMirrorRun, syncDueMirrors } from './mirrors.ts'

export type ForgeOptions = ForgeSettings & {
  readonly storage: Storage
  readonly db: Database
  readonly fetch?: FetchFunction
  readonly now?: () => Date
  readonly jobs?: JobQueue<ForgeJob>
  readonly scheduleImport?: ImportScheduler
}

export type Forge = {
  readonly fetch: (request: Request) => Promise<Response>
  readonly scheduled: (at?: Date) => Promise<ScheduledMirrorRun[]>
  readonly runJob: (job: ForgeJob) => Promise<void>
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message)
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } })

const digest = async (value: string): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))

export const secretMatches = async (presented: string, expected: string | undefined): Promise<boolean> => {
  if (!expected) return false
  const [a, b] = await Promise.all([digest(presented), digest(expected)])
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!
  return difference === 0
}

const bearer = (request: Request): string | null => {
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(request.headers.get('Authorization') ?? '')
  return match ? match[1]! : null
}

type Body = Record<string, unknown>

const readBody = async (request: Request): Promise<Body> => {
  if (!request.body) return {}
  let bytes: Uint8Array
  try {
    bytes = await readAll(request.body, 64 * 1024)
  } catch (error) {
    if (error instanceof SizeLimitError) throw new HttpError(413, 'request body too large')
    throw error
  }
  if (bytes.length === 0) return {}
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Body
  } catch {}
  throw new HttpError(400, 'expected a JSON object')
}

const optionalString = (body: Body, key: string): string | undefined => {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new HttpError(400, `${key} must be a string`)
  return value
}

const requiredString = (body: Body, key: string): string => {
  const value = optionalString(body, key)
  if (value === undefined || value === '') throw new HttpError(400, `${key} is required`)
  return value
}

const DECISION_STATUS: Record<Exclude<Decision, 'allow'>, [number, string]> = {
  unauthenticated: [401, 'authentication required'],
  forbidden: [403, 'permission denied'],
  'not-found': [404, 'repository not found'],
}

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/

export const basicAuthorization = (username: string, password: string): string => {
  const bytes = new TextEncoder().encode(`${username}:${password}`)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `Basic ${btoa(binary)}`
}

type Route = { readonly pattern: RegExp; readonly method: string; readonly handler: (request: Request, params: string[]) => Promise<Response> }

export const createForge = (options: ForgeOptions): Forge => {
  const { storage, db } = options
  const store: AccountsStore = createAccountsStore(db)
  const now = options.now ?? (() => new Date())
  const jwks: JwksSource = createJwksCache({
    allowInsecureHttp: options.allowInsecureFederation,
    ...(options.fetch ? { fetch: (input, init) => options.fetch!(new Request(input, init)) } : {}),
  })
  const issuerFor = (request: Request): string => options.publicUrl ?? normalizeIssuer(new URL(request.url).origin)

  const authenticateOptions = (request: Request) => ({
    directory: store,
    verifyInstance: createInstanceVerifier({ audience: issuerFor(request), trust: store.lookupTrustedIssuer, jwks }),
  })

  const principalOf = async (request: Request): Promise<Principal> => {
    const principal = await authenticateRequest(request, authenticateOptions(request))
    if (!principal) throw new HttpError(401, 'invalid credentials', { 'WWW-Authenticate': 'Bearer' })
    return principal
  }

  const canManage = (principal: Principal): principal is UserPrincipal =>
    principal.kind === 'user' && (principal.limits === null || principal.limits.ceiling === 'admin')

  const requireManager = async (request: Request): Promise<UserPrincipal> => {
    const principal = await principalOf(request)
    if (principal.kind === 'anonymous') throw new HttpError(401, 'authentication required', { 'WWW-Authenticate': 'Bearer' })
    if (!canManage(principal)) throw new HttpError(403, 'this needs a personal access token with the repo:admin scope')
    return principal
  }

  const requireInstanceAdmin = async (request: Request): Promise<UserPrincipal> => {
    const principal = await requireManager(request)
    if (!(await store.isInstanceAdmin(principal.id))) throw new HttpError(403, 'instance admin required')
    return principal
  }

  const requireRepositoryAdmin = async (request: Request, repo: RepositoryName): Promise<{ principal: UserPrincipal; repository: RepositorySubject }> => {
    const principal = await requireManager(request)
    const check = await checkRepositoryAccess(store, principal, repo, 'admin')
    if (check.repository && (check.decision === 'allow' || (await store.isInstanceAdmin(principal.id)))) {
      return { principal, repository: check.repository }
    }
    const [status, message] = DECISION_STATUS[check.decision === 'allow' ? 'not-found' : check.decision]
    throw new HttpError(status, message)
  }

  const mirrorContext = (issuer: string | undefined): MirrorContext => ({
    storage,
    store,
    issuer,
    instanceKey: options.instanceKey,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  const federation: MirrorFederation | null =
    options.publicUrl && options.instanceKey && options.jobs
      ? {
          ...mirrorContext(options.publicUrl),
          issuer: options.publicUrl,
          instanceKey: options.instanceKey,
          jwks,
          jobs: options.jobs,
          canRead: async (principal, repo) => (await checkRepositoryAccess(store, principal, repo, 'read')).decision === 'allow',
          deepCheckDays: options.deepCheckDays,
          now,
        }
      : null

  const repoName = (params: string[]): RepositoryName => {
    const [owner, name] = params as [string, string]
    if (!isValidName(owner) || !isValidName(name)) throw new HttpError(404, 'repository not found')
    return { owner, name }
  }

  const bootstrap = async (request: Request): Promise<Response> => {
    if (!options.bootstrapToken) throw new HttpError(503, 'BOOTSTRAP_TOKEN is not configured')
    const presented = bearer(request)
    if (presented === null || !(await secretMatches(presented, options.bootstrapToken))) {
      throw new HttpError(401, 'invalid bootstrap token', { 'WWW-Authenticate': 'Bearer' })
    }
    const body = await readBody(request)
    const login = requiredString(body, 'login')
    const email = optionalString(body, 'email')
    const admin = await store.bootstrapInstanceAdmin({ login, ...(email ? { email } : {}) })
    if (!admin) throw new HttpError(409, 'this instance already has an admin')
    const token = await store.createPersonalAccessToken(admin.id, { name: 'bootstrap', scopes: ['repo:admin'], expiresAt: null }, { kind: 'system' })
    return json(201, { login, token: token.token })
  }

  const createUser = async (request: Request): Promise<Response> => {
    const actor = await requireInstanceAdmin(request)
    const body = await readBody(request)
    const login = requiredString(body, 'login')
    const email = optionalString(body, 'email')
    if (await store.findAccount(login)) throw new HttpError(409, `${login} already exists`)
    const user = await store.createUser({ login, ...(email ? { email } : {}) }, { kind: 'user', id: actor.id })
    if (body.admin === true) await store.setInstanceAdmin(user.id, true, { kind: 'user', id: actor.id })
    return json(201, { id: user.id, login, admin: body.admin === true })
  }

  const createToken = async (request: Request, params: string[]): Promise<Response> => {
    const actor = await requireInstanceAdmin(request)
    const account = await store.findAccount(params[0]!)
    if (!account || account.kind !== 'user') throw new HttpError(404, 'user not found')
    const body = await readBody(request)
    const scopes = body.scopes ?? ['repo:write']
    if (!Array.isArray(scopes) || !scopes.every(isTokenScope)) throw new HttpError(400, 'scopes must be a list of repo:read, repo:write, repo:admin')
    const expiresAt = body.expiresAt ?? null
    if (expiresAt !== null && (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt))) throw new HttpError(400, 'expiresAt must be Unix milliseconds')
    const created = await store.createPersonalAccessToken(account.id, { name: optionalString(body, 'name') ?? 'api', scopes, expiresAt }, { kind: 'user', id: actor.id })
    return json(201, created)
  }

  const trustInstance = async (request: Request): Promise<Response> => {
    const actor = await requireInstanceAdmin(request)
    const body = await readBody(request)
    const issuer = normalizeIssuer(requiredString(body, 'issuer'))
    const pinnedThumbprint = optionalString(body, 'pinnedThumbprint') ?? null
    await store.trustInstance({ issuer, pinnedThumbprint }, { kind: 'user', id: actor.id })
    return json(200, { issuer, pinnedThumbprint })
  }

  const createRepositoryRoute = async (request: Request): Promise<Response> => {
    const actor = await requireManager(request)
    const body = await readBody(request)
    const created = await createRepositoryFor(actor, requiredString(body, 'owner'), requiredString(body, 'name'), body)
    const cloneUrl = new URL(`/${created.owner}/${created.name}.git`, request.url).toString()
    return json(201, { ...created, cloneUrl })
  }

  const createRepositoryFor = async (actor: UserPrincipal, owner: string, name: string, body: Body) => {
    const visibility = optionalString(body, 'visibility') ?? 'private'
    const defaultBranch = optionalString(body, 'defaultBranch') ?? 'main'
    if (!isValidName(owner) || !isValidName(name)) throw new HttpError(400, 'owner and name must match [A-Za-z0-9][A-Za-z0-9._-]* and must not end in .git')
    if (visibility !== 'private' && visibility !== 'public') throw new HttpError(400, 'visibility must be private or public')
    if (!BRANCH.test(defaultBranch) || defaultBranch.includes('..')) throw new HttpError(400, 'invalid defaultBranch')
    const account = await store.findAccount(owner)
    if (!account) throw new HttpError(404, `no account ${owner}`)
    const own = account.kind === 'user' && account.id === actor.id
    if (!own && !(await store.isInstanceAdmin(actor.id))) throw new HttpError(403, `you cannot create repositories for ${owner}`)
    if (await store.findRepository(owner, name)) throw new HttpError(409, `${owner}/${name} already exists`)
    try {
      await createRepository(storage, { owner: account.login, name }, defaultBranch)
    } catch (error) {
      if (!(error instanceof RepositoryExistsError)) throw error
    }
    try {
      await store.createRepository({ ownerId: account.id, name, visibility }, { kind: 'user', id: actor.id })
    } catch (error) {
      if (await store.findRepository(owner, name)) throw new HttpError(409, `${owner}/${name} already exists`)
      throw error
    }
    return { owner: account.login, name, visibility, defaultBranch }
  }

  const optionalCount = (body: Body, key: string): number | undefined => {
    const value = body[key]
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new HttpError(400, `${key} must be a positive integer`)
    return value
  }

  const importRepository = async (request: Request, params: string[]): Promise<Response> => {
    const repo = repoName(params)
    if (!options.scheduleImport) throw new HttpError(503, 'imports need a queue (IMPORTS binding)')
    const body = await readBody(request)
    const url = requiredString(body, 'url')
    const token = optionalString(body, 'token')
    const username = optionalString(body, 'username') ?? 'git'
    const lfsUrl = optionalString(body, 'lfsUrl')
    const commitsPerStep = optionalCount(body, 'commitsPerStep')
    if (body.lfs !== undefined && typeof body.lfs !== 'boolean') throw new HttpError(400, 'lfs must be a boolean')
    if (!isValidImportUrl(url) || (lfsUrl !== undefined && !isValidImportUrl(lfsUrl))) throw new HttpError(400, 'url and lfsUrl must be http(s) URLs without credentials; pass a token instead')
    let target: RepositoryName
    if (await store.findRepository(repo.owner, repo.name)) {
      const { repository } = await requireRepositoryAdmin(request, repo)
      target = { owner: repository.owner, name: repository.name }
    } else {
      const created = await createRepositoryFor(await requireManager(request), repo.owner, repo.name, body)
      target = { owner: created.owner, name: created.name }
    }
    let state
    try {
      state = await startImport(storage, target, {
        url,
        ...(body.lfs !== undefined ? { lfs: body.lfs as boolean } : {}),
        ...(lfsUrl ? { lfsUrl } : {}),
        ...(commitsPerStep ? { commitsPerStep } : {}),
      })
    } catch (error) {
      if (error instanceof ImportRunningError) throw new HttpError(409, error.message)
      throw new HttpError(400, (error as Error).message)
    }
    await options.scheduleImport({ ...target, ...(token ? { authorization: basicAuthorization(username, token) } : {}) }, 0)
    const statusUrl = new URL(`/api/repos/${target.owner}/${target.name}/import`, request.url).toString()
    const cloneUrl = new URL(`/${target.owner}/${target.name}.git`, request.url).toString()
    return json(202, { ...state, statusUrl, cloneUrl }, { Location: statusUrl })
  }

  const importStatus = async (request: Request, params: string[]): Promise<Response> => {
    const { repository } = await requireRepositoryAdmin(request, repoName(params))
    const state = await readImportState(storage, { owner: repository.owner, name: repository.name })
    if (!state) throw new HttpError(404, 'no import for this repository')
    return json(200, state)
  }

  const updateRepository = async (request: Request, params: string[]): Promise<Response> => {
    const { principal, repository } = await requireRepositoryAdmin(request, repoName(params))
    const body = await readBody(request)
    const visibility = optionalString(body, 'visibility')
    if (visibility !== undefined) {
      if (visibility !== 'private' && visibility !== 'public') throw new HttpError(400, 'visibility must be private or public')
      await store.setRepositoryVisibility(repository.id, visibility, { kind: 'user', id: principal.id })
    }
    return json(200, { owner: repository.owner, name: repository.name, visibility: visibility ?? repository.visibility })
  }

  const setCollaborator = async (request: Request, params: string[]): Promise<Response> => {
    const { principal, repository } = await requireRepositoryAdmin(request, repoName(params))
    const account = await store.findAccount(params[2]!)
    if (!account || account.kind !== 'user') throw new HttpError(404, 'user not found')
    const role = (await readBody(request)).role
    if (!isRole(role)) throw new HttpError(400, 'role must be read, triage, write, maintain or admin')
    await store.setCollaborator(repository.id, account.id, role, { kind: 'user', id: principal.id })
    return json(200, { login: account.login, role })
  }

  const grantInstance = async (request: Request, params: string[]): Promise<Response> => {
    const { principal, repository } = await requireRepositoryAdmin(request, repoName(params))
    const issuer = normalizeIssuer(requiredString(await readBody(request), 'issuer'))
    if (!(await store.lookupTrustedIssuer(issuer))) throw new HttpError(422, `${issuer} is not a trusted instance; an instance admin must trust it first`)
    await store.grantInstanceRepository(issuer, repository.id, { kind: 'user', id: principal.id })
    return json(200, { issuer, role: 'read' })
  }

  const listMirrorsRoute = async (request: Request, params: string[]): Promise<Response> => {
    const repo = repoName(params)
    await requireRepositoryAdmin(request, repo)
    const mirrors = await listMirrors(storage, repo)
    return json(200, await Promise.all(mirrors.map(async (config) => ({ config, status: await readMirrorStatus(storage, repo, config.remote) }))))
  }

  const addMirror = async (request: Request, params: string[]): Promise<Response> => {
    const repo = repoName(params)
    const { repository } = await requireRepositoryAdmin(request, repo)
    const body = await readBody(request)
    const mode = optionalString(body, 'mode')
    const auth = optionalString(body, 'auth')
    if (mode !== undefined && mode !== 'auto' && mode !== 'manual') throw new HttpError(400, 'mode must be auto or manual')
    if (auth !== undefined && auth !== 'none' && auth !== 'instance') throw new HttpError(400, 'auth must be none or instance')
    if (body.lfs !== undefined && typeof body.lfs !== 'boolean') throw new HttpError(400, 'lfs must be a boolean')
    const remote = optionalString(body, 'remote')
    const namespace = optionalString(body, 'namespace')
    const lfsUrl = optionalString(body, 'lfsUrl')
    try {
      const config = await configureMirror(storage, { owner: repository.owner, name: repository.name }, {
        url: requiredString(body, 'url'),
        ...(remote !== undefined ? { remote } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(namespace !== undefined ? { namespace } : {}),
        ...(body.lfs !== undefined ? { lfs: body.lfs as boolean } : {}),
        ...(lfsUrl !== undefined ? { lfsUrl } : {}),
        ...(auth !== undefined ? { auth } : {}),
      })
      if (federation) await enqueueMirrorSetup(federation, { owner: repository.owner, name: repository.name }, config)
      return json(201, config)
    } catch (error) {
      if (error instanceof MirrorExistsError) throw new HttpError(409, error.message)
      if (error instanceof HttpError) throw error
      throw new HttpError(400, (error as Error).message)
    }
  }

  const syncMirrorRoute = async (request: Request, params: string[]): Promise<Response> => {
    const { repository } = await requireRepositoryAdmin(request, repoName(params))
    const repo = { owner: repository.owner, name: repository.name }
    const config = await readMirrorConfig(storage, repo, params[2]!)
    if (!config) throw new HttpError(404, 'mirror not configured')
    try {
      const result = federation ? await syncAndNotify(federation, repo, config) : await runMirrorSync(mirrorContext(issuerFor(request)), repo, config)
      return json(result.status === 'failed' ? 502 : 200, result)
    } catch (error) {
      if (error instanceof MirrorAuthError) throw new HttpError(409, error.message)
      throw error
    }
  }

  const verifyMirrorRoute = async (request: Request, params: string[]): Promise<Response> => {
    const { repository } = await requireRepositoryAdmin(request, repoName(params))
    const repo = { owner: repository.owner, name: repository.name }
    if (!(await readMirrorConfig(storage, repo, params[2]!))) throw new HttpError(404, 'mirror not configured')
    return json(200, await deepCheckMirror(storage, repo, params[2]!, now()))
  }

  const detachMirrorRoute = async (request: Request, params: string[]): Promise<Response> => {
    const { repository } = await requireRepositoryAdmin(request, repoName(params))
    try {
      return json(200, await detachMirror(storage, { owner: repository.owner, name: repository.name }, params[2]!, now()))
    } catch (error) {
      if (error instanceof MirrorNotFoundError) throw new HttpError(404, 'mirror not configured')
      throw error
    }
  }

  const health = async () => json(200, { ok: true, service: 'git-forge' })

  const SEGMENT = '([^/]+)'
  const REPO = `/api/repos/${SEGMENT}/${SEGMENT}`
  const routes: Route[] = [
    { method: 'GET', pattern: /^\/$/, handler: health },
    { method: 'GET', pattern: /^\/api\/health$/, handler: health },
    { method: 'POST', pattern: /^\/api\/bootstrap$/, handler: bootstrap },
    { method: 'POST', pattern: /^\/api\/admin\/users$/, handler: createUser },
    { method: 'POST', pattern: new RegExp(`^/api/admin/users/${SEGMENT}/tokens$`), handler: createToken },
    { method: 'POST', pattern: /^\/api\/admin\/instances$/, handler: trustInstance },
    { method: 'POST', pattern: /^\/api\/repos$/, handler: createRepositoryRoute },
    { method: 'PATCH', pattern: new RegExp(`^${REPO}$`), handler: updateRepository },
    { method: 'PUT', pattern: new RegExp(`^${REPO}/collaborators/${SEGMENT}$`), handler: setCollaborator },
    { method: 'POST', pattern: new RegExp(`^${REPO}/instances$`), handler: grantInstance },
    { method: 'POST', pattern: new RegExp(`^${REPO}/import$`), handler: importRepository },
    { method: 'GET', pattern: new RegExp(`^${REPO}/import$`), handler: importStatus },
    { method: 'GET', pattern: new RegExp(`^${REPO}/mirrors$`), handler: listMirrorsRoute },
    { method: 'POST', pattern: new RegExp(`^${REPO}/mirrors$`), handler: addMirror },
    { method: 'POST', pattern: new RegExp(`^${REPO}/mirrors/${SEGMENT}/sync$`), handler: syncMirrorRoute },
    { method: 'POST', pattern: new RegExp(`^${REPO}/mirrors/${SEGMENT}/detach$`), handler: detachMirrorRoute },
    { method: 'POST', pattern: new RegExp(`^${REPO}/mirrors/${SEGMENT}/verify$`), handler: verifyMirrorRoute },
  ]

  const route = async (request: Request): Promise<Response | null> => {
    const { pathname } = new URL(request.url)
    const matching = routes.filter((candidate) => candidate.pattern.test(pathname))
    if (matching.length === 0) return null
    const match = matching.find((candidate) => candidate.method === request.method)
    if (!match) return json(405, { error: 'method not allowed' }, { Allow: [...new Set(matching.map((candidate) => candidate.method))].join(', ') })
    const params = match.pattern.exec(pathname)!.slice(1).map(decodeURIComponent)
    return match.handler(request, params)
  }

  const handle = async (request: Request): Promise<Response> => {
    const wellKnown = options.instanceKey ? handleWellKnownRequest(request, { issuer: issuerFor(request), keys: [options.instanceKey.publicJwk] }) : null
    if (wellKnown) return wellKnown
    const federated = federation ? await handleFederationRequest(federation, request) : null
    if (federated) return federated
    const authentication = authenticateOptions(request)
    const protection = await handleBranchProtectionRequest(request, { store, verifyInstance: authentication.verifyInstance })
    if (protection) return protection
    try {
      const api = await route(request)
      if (api) return api
    } catch (error) {
      if (error instanceof HttpError) return json(error.status, { error: error.message }, error.headers)
      if (error instanceof AccountsError) return json(400, { error: error.message })
      throw error
    }
    const access = createGitAccess(authentication)
    const content = await handleContentRequest(request, { storage, authorize: access.authorize })
    if (content) return content
    const git = await handleGitRequest(request, {
      storage,
      authorize: access.authorize,
      pushPolicy: access.pushPolicy,
      maxRequestBytes: options.maxPushBytes,
      lfs: { maxObjectBytes: options.maxLfsObjectBytes },
      ...(federation ? { onPush: notifyAfterPush(federation) } : {}),
    })
    return git ?? json(404, { error: 'not found' })
  }

  return {
    fetch: handle,
    scheduled: (at = now()) =>
      federation ? enqueueDueMirrors(federation, at, options.mirrorIntervalMinutes) : syncDueMirrors(mirrorContext(options.publicUrl), at, options.mirrorIntervalMinutes),
    runJob: async (job) => {
      if (!federation) throw new Error('jobs need PUBLIC_URL, INSTANCE_KEY and a job queue')
      await runJob(federation, job)
    },
  }
}
