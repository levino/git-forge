import {
  type ActionsTick,
  actionsTick,
  advanceRun,
  type CheckRunReport,
  type CheckRunSink,
  queueRunsForPullRequest,
  type DispatchOptions,
  handleActionsService,
  type SecretsKey,
  handleGhesApi,
  queueRunsForPush,
  type RunnerLauncher,
  type SecretsProvider,
  GITHUB_TOKEN_PREFIX,
  getRun,
  type JobRow,
  listRunJobs,
  verifyToken,
  workflowJobPayload,
} from '@git-forge/actions'
import {
  type Access,
  type AccountsStore,
  atLeast,
  AccountsError,
  authenticateRequest,
  checkRepositoryAccess,
  checkSession,
  createAccountsStore,
  createLoginHandler,
  createLoginStore,
  createOidcProvider,
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
  type LoginContext,
  type LoginHttpOptions,
  type LoginPageRenderer,
  relyingParty,
  sessionUserPrincipal,
  normalizeIssuer,
  parseAuthorization,
  type Principal,
  type RepositorySubject,
  type Role,
  type UserPrincipal,
  readActiveSession,
  isUnsafeMethod,
  type CreatedToken,
  type CredentialSummary,
  type TokenScope,
} from '@git-forge/accounts'
import {
  type Authorize,
  compactRepository,
  configureMirror,
  createRepository,
  deepCheckMirror,
  detachMirror,
  type DigestFactory,
  type EmailSender,
  type FetchFunction,
  handleContentRequest,
  handleGitRequest,
  type JobQueue,
  type ImportScheduler,
  ImportRunningError,
  isValidImportUrl,
  isValidName,
  listMirrors,
  type MirrorConfig,
  MirrorExistsError,
  MirrorNotFoundError,
  ObjectDatabase,
  type PackfileUri,
  publicPackfileUris,
  type PushOutcome,
  readAll,
  readMirrorConfig,
  readImportState,
  readMirrorStatus,
  readRefs,
  RepositoryExistsError,
  type RepositoryName,
  SizeLimitError,
  startImport,
  type Storage,
  type SyncResult,
  ZERO_ID,
} from '@git-forge/core'
import {
  type BranchUpdate,
  type CheckRunInput,
  CollaborationError,
  type CollaborationOptions,
  type Scope as CollaborationScope,
  getPullSummary,
  openRepository as openCollaborationRepository,
  handleCollaborationApi,
  handlePushedRefs,
  loadUsers,
  recordCheckRun,
  SYSTEM_ACTOR as COLLABORATION_SYSTEM_ACTOR,
  systemScope,
  actorRefOf,
  updateCheckRunRecord,
} from '@git-forge/collaboration'
import {
  createNotifications,
  type EventActor,
  type ForgeEvent,
  handleNotificationsRequest,
  isNotificationJob,
  mirrorAlarmEvent,
  type NotificationJob,
  type Notifications,
  pushEvent,
  pushInfos,
  refEvent,
  SYSTEM_ACTOR,
  workflowJobEvent,
  workflowRunEvent,
  type ThreadRow,
} from '@git-forge/notifications'
import { type AssetRow, createReleaseStore, handleReleasesRequest, type ReleaseRow } from '@git-forge/releases'
import { activityEvent } from './collaboration-events.ts'
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

export type ActionsOptions = {
  readonly instanceId: string
  readonly launcher?: RunnerLauncher
  readonly secrets?: SecretsProvider
  readonly secretsKey?: SecretsKey
  readonly repositories?: Readonly<Record<string, string>>
  readonly githubFallback?: string | null
}

export type ForgeOptions = ForgeSettings & {
  readonly storage: Storage
  readonly db: Database
  readonly fetch?: FetchFunction
  readonly now?: () => Date
  readonly actions?: ActionsOptions
  readonly jobs?: JobQueue<AppJob>
  readonly digests?: DigestFactory
  readonly scheduleImport?: ImportScheduler
  readonly email?: EmailSender
  readonly renderLoginPage?: LoginPageRenderer
}

export type AppJob = ForgeJob | NotificationJob

export type WaitUntil = (promise: Promise<unknown>) => void

export const ACTIONS_SERVICE_PATH = '/_services/actions'

export type ForgeServices = {
  readonly storage: Storage
  readonly store: AccountsStore
  readonly authenticate: (request: Request) => Promise<Principal | null>
  readonly issuer: (request: Request) => string
  readonly repositoryAccess: (principal: Principal, repo: RepositoryName, required: Role) => Promise<RepositoryAccess>
  readonly isInstanceAdmin: (principal: Principal) => Promise<boolean>
  readonly session: (request: Request) => Promise<UiSession | null>
  readonly verifySessionWrite: (request: Request) => Promise<UiSession | null>
  readonly loginOptions: { readonly oidcName: string | null }
  readonly account: AccountOperations
  readonly inbox: InboxOperations
  readonly releases: ReleaseReads
  readonly collaboration: (request: Request, principal: Principal, owner: string, name: string) => Promise<CollaborationScope | null>
}

export type InboxOperations = {
  readonly threads: (user: UserPrincipal, filter: { readonly all: boolean; readonly limit: number; readonly offset: number }) => Promise<ThreadRow[]>
  readonly markRead: (user: UserPrincipal, id: number) => Promise<boolean>
  readonly markDone: (user: UserPrincipal, id: number) => Promise<boolean>
  readonly markAllRead: (user: UserPrincipal) => Promise<number>
}

export type ReleaseReads = {
  readonly list: (repository: RepositorySubject, includeDrafts: boolean, limit: number, offset: number) => Promise<ReleaseRow[]>
  readonly byTag: (repository: RepositorySubject, tag: string, includeDrafts: boolean) => Promise<ReleaseRow | null>
  readonly assets: (releaseIds: readonly number[]) => Promise<AssetRow[]>
}

export type UiSession = { readonly principal: UserPrincipal; readonly csrf: string }

export type AccountOperations = {
  readonly listTokens: (user: UserPrincipal) => ReturnType<AccountsStore['listTokens']>
  readonly createToken: (user: UserPrincipal, input: { readonly name: string; readonly scopes: readonly TokenScope[]; readonly expiresAt: number | null }) => Promise<CreatedToken>
  readonly revokeToken: (user: UserPrincipal, tokenId: string) => Promise<boolean>
  readonly listPasskeys: (user: UserPrincipal) => Promise<CredentialSummary[]>
  readonly revokePasskey: (user: UserPrincipal, id: string) => Promise<boolean>
}

export type RepositoryAccess = {
  readonly decision: Decision
  readonly access: Access
  readonly repository: RepositorySubject | null
}

export type Forge = {
  readonly fetch: (request: Request, waitUntil?: WaitUntil) => Promise<Response>
  readonly services: ForgeServices
  readonly scheduled: (at?: Date) => Promise<ScheduledMirrorRun[]>
  readonly actionsTick: () => Promise<ActionsTick | null>
  readonly runJob: (job: AppJob) => Promise<void>
  readonly notifications: Notifications
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
  const now = options.now ?? (() => new Date())
  const store: AccountsStore = createAccountsStore(db, { now: () => now().getTime() })
  const logins = createLoginStore(db, { now: () => now().getTime() })
  const outbound = (input: string, init?: RequestInit) => (options.fetch ? options.fetch(new Request(input, init)) : fetch(input, init))
  const oidc = options.login?.oidc ? createOidcProvider(options.login.oidc, outbound, () => now().getTime()) : null
  const jwks: JwksSource = createJwksCache({
    allowInsecureHttp: options.allowInsecureFederation,
    ...(options.fetch ? { fetch: (input, init) => options.fetch!(new Request(input, init)) } : {}),
  })
  const issuerFor = (request: Request): string => options.publicUrl ?? normalizeIssuer(new URL(request.url).origin)

  const authenticateOptions = (request: Request) => ({
    directory: store,
    verifyInstance: createInstanceVerifier({ audience: issuerFor(request), trust: store.lookupTrustedIssuer, jwks }),
  })

  const loginOptions = (request: Request): LoginHttpOptions => {
    const origin = new URL(issuerFor(request)).origin
    const context: LoginContext = {
      store,
      logins,
      origin,
      rp: relyingParty(origin),
      oidc,
      selfSignup: options.login?.selfSignup ?? false,
      breakGlassKey: options.login?.breakGlassKey ?? null,
      fetch: outbound,
      now: () => now().getTime(),
    }
    return { context, secureCookies: origin.startsWith('https:'), ...(options.renderLoginPage ? { renderPage: options.renderLoginPage } : {}) }
  }

  const principalOf = async (request: Request): Promise<Principal> => {
    if (!request.headers.has('Authorization')) {
      const check = await checkSession(request, loginOptions(request))
      if (check.kind === 'csrf-failed') throw new HttpError(403, 'missing or invalid CSRF token')
      if (check.kind === 'session') return sessionUserPrincipal(check.active.session)
    }
    const principal = await authenticateRequest(request, authenticateOptions(request))
    if (!principal) throw new HttpError(401, 'invalid credentials', { 'WWW-Authenticate': 'Bearer' })
    return principal
  }

  const apiPrincipal = async (request: Request): Promise<Principal | null> => {
    if (!request.headers.has('Authorization')) {
      const check = await checkSession(request, loginOptions(request))
      if (check.kind === 'csrf-failed') return null
      if (check.kind === 'session') return sessionUserPrincipal(check.active.session)
    }
    return authenticateRequest(request, authenticateOptions(request))
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

  const repositoryAccess = async (principal: Principal, repo: RepositoryName, required: Role): Promise<RepositoryAccess> => {
    const check = await checkRepositoryAccess(store, principal, repo, required)
    if (!check.repository) return { decision: check.decision === 'allow' ? 'not-found' : check.decision, access: 'none', repository: null }
    if (principal.kind === 'user' && (await store.isInstanceAdmin(principal.id))) {
      const ceiling = principal.limits?.ceiling ?? 'admin'
      const scoped = principal.limits?.repositoryIds ?? null
      if (scoped === null || scoped.includes(check.repository.id)) {
        return { decision: atLeast(ceiling, required) ? 'allow' : 'forbidden', access: ceiling, repository: check.repository }
      }
    }
    return { decision: check.decision, access: check.access, repository: check.repository }
  }

  const requireRepositoryAdmin = async (request: Request, repo: RepositoryName): Promise<{ principal: UserPrincipal; repository: RepositorySubject }> => {
    const principal = await requireManager(request)
    const check = await repositoryAccess(principal, repo, 'admin')
    if (check.repository && check.decision === 'allow') return { principal, repository: check.repository }
    const [status, message] = DECISION_STATUS[check.decision === 'allow' ? 'not-found' : check.decision]
    throw new HttpError(status, message)
  }

  const releaseStore = createReleaseStore(db, () => now().getTime())
  const notifications = createNotifications({
    db,
    directory: store,
    storage,
    ...(options.jobs ? { jobs: options.jobs } : {}),
    ...(options.email ? { email: options.email } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    allowInsecureWebhooks: options.allowInsecureWebhooks ?? false,
    ...(options.publicUrl ? { baseUrl: options.publicUrl } : {}),
    now: () => now().getTime(),
  })

  const emit = async (event: ForgeEvent): Promise<void> => {
    try {
      await notifications.emit(event)
    } catch (error) {
      console.error(JSON.stringify({ event: 'emit-failed', name: event.name, repository: `${event.repository.owner}/${event.repository.name}`, error: String(error) }))
    }
  }

  const eventActorOf = (principal: Principal | null): EventActor => {
    switch (principal?.kind) {
      case 'user':
        return { kind: 'user', id: principal.id, login: principal.login }
      case 'app':
        return { kind: 'app', id: principal.id, login: `${principal.slug}[bot]` }
      case 'instance':
        return { kind: 'instance', id: principal.issuer, login: null }
      default:
        return SYSTEM_ACTOR
    }
  }

  const emitMirrorAlarms = async (repo: RepositoryName, config: MirrorConfig, result: SyncResult): Promise<void> => {
    if (result.alarms.length === 0) return
    await emit(
      mirrorAlarmEvent(
        { baseUrl: options.publicUrl ?? 'http://localhost', repository: repo, actor: SYSTEM_ACTOR },
        { remote: config.remote, upstream: config.url, alarms: result.alarms },
      ),
    )
  }

  const mirrorContext = (issuer: string | undefined): MirrorContext => ({
    storage,
    store,
    issuer,
    instanceKey: options.instanceKey,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.digests ? { digests: options.digests } : {}),
    onSynced: emitMirrorAlarms,
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
          unitBytes: options.mirrorUnitBytes,
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

  const currentUser = async (request: Request): Promise<Response> => {
    const principal = await principalOf(request)
    if (principal.kind !== 'user') throw new HttpError(401, 'authentication required', { 'WWW-Authenticate': 'Bearer' })
    const via = request.headers.has('Authorization') ? 'token' : 'session'
    return json(200, { id: principal.id, login: principal.login, admin: await store.isInstanceAdmin(principal.id), via, ceiling: principal.limits?.ceiling ?? null })
  }

  const createInvite = async (request: Request): Promise<Response> => {
    const actor = await requireInstanceAdmin(request)
    const body = await readBody(request)
    const login = optionalString(body, 'login')
    const existing = optionalString(body, 'user')
    const email = optionalString(body, 'email')
    const days = body.expiresInDays ?? 7
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 90) throw new HttpError(400, 'expiresInDays must be an integer between 1 and 90')
    if (login !== undefined && existing !== undefined) throw new HttpError(400, 'pass either login (a new account) or user (an existing one)')
    let userId: string | null = null
    if (existing !== undefined) {
      const account = await store.findAccount(existing)
      if (!account || account.kind !== 'user') throw new HttpError(404, 'user not found')
      userId = account.id
    }
    if (login !== undefined && (await store.findAccount(login))) throw new HttpError(409, `${login} already exists`)
    const invite = await logins.createInvite({ login: login ?? null, userId, email: email ?? null, ttlMs: days * 24 * 60 * 60 * 1000 }, { kind: 'user', id: actor.id })
    return json(201, { code: invite.code, url: new URL(`/login/invite/${invite.code}`, issuerFor(request)).toString(), expiresAt: invite.expiresAt })
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

  const checkRunInput = (check: CheckRunReport): CheckRunInput => ({
    name: check.name,
    status: check.status,
    conclusion: check.conclusion,
    externalId: check.externalId,
    detailsUrl: check.detailsUrl,
    ...(check.title ? { output: { title: check.title } } : {}),
  })

  const checkRuns: CheckRunSink = {
    create: async (repo, check) => {
      const repository = await store.findRepository(repo.owner, repo.name)
      return repository ? recordCheckRun(db, repository.id, check.headSha, checkRunInput(check), COLLABORATION_SYSTEM_ACTOR, now().getTime()) : null
    },
    update: async (repo, id, check) => {
      const repository = await store.findRepository(repo.owner, repo.name)
      if (repository) await updateCheckRunRecord(db, repository.id, id, checkRunInput(check), now().getTime())
    },
  }

  const dispatchOptions = (request: Request): DispatchOptions => {
    const serverUrl = issuerFor(request)
    return {
      db,
      storage,
      urls: { serverUrl, serviceUrl: `${serverUrl}${ACTIONS_SERVICE_PATH}` },
      checks: checkRuns,
      ...(options.actions?.launcher ? { launcher: options.actions.launcher } : {}),
      now: () => now().getTime(),
      log: (event) => console.log(JSON.stringify(event)),
    }
  }

  const isRepositoryAdmin = async (request: Request, owner: string, name: string): Promise<boolean> => {
    if (!isValidName(owner) || !isValidName(name)) return false
    try {
      await requireRepositoryAdmin(request, { owner, name })
      return true
    } catch (error) {
      if (error instanceof HttpError) return false
      throw error
    }
  }

  const hasRepositoryAccess = async (request: Request, owner: string, name: string, required: 'read' | 'write'): Promise<boolean> => {
    if (!isValidName(owner) || !isValidName(name)) return false
    if (required === 'read') return (await withJobTokens(createGitAccess(authenticateOptions(request)).authorize)(request, { owner, name }, 'read', 'git')) === null
    const principal = await authenticateRequest(request, authenticateOptions(request))
    if (!principal) return false
    return (await checkRepositoryAccess(store, principal, { owner, name }, 'write')).decision === 'allow'
  }

  const userLogin = async (request: Request): Promise<string | null> => {
    const principal = await authenticateRequest(request, authenticateOptions(request))
    return principal?.kind === 'user' ? principal.login : null
  }

  const canUseAction = async (job: RepositoryName, action: RepositoryName): Promise<boolean> => {
    if (job.owner === action.owner) return true
    return (await store.findRepository(action.owner, action.name))?.visibility === 'public'
  }

  const actionsRoute = async (request: Request): Promise<Response | null> => {
    const { actions } = options
    const { pathname } = new URL(request.url)
    if (!actions || !(pathname.startsWith(`${ACTIONS_SERVICE_PATH}/`) || pathname === '/api/v3' || pathname.startsWith('/api/v3/'))) return null
    const dispatch = dispatchOptions(request)
    return (
      (await handleActionsService(request, {
        db,
        storage,
        basePath: ACTIONS_SERVICE_PATH,
        instanceId: actions.instanceId,
        serverUrl: dispatch.urls.serverUrl,
        now: () => now().getTime(),
        ...(actions.secrets ? { secrets: actions.secrets } : {}),
        ...(actions.secretsKey ? { secretsKey: actions.secretsKey } : {}),
        checks: checkRuns,
        actionSources: {
          ...(actions.repositories ? { repositories: actions.repositories } : {}),
          githubFallback: actions.githubFallback ?? null,
          canUse: canUseAction,
        },
        onJobCompleted: async (job) => {
          await advanceRun(dispatch, job)
          await emitRunEvents(dispatch.urls.serverUrl, job)
        },
      })) ??
      (await handleGhesApi(request, {
        db,
        storage,
        urls: dispatch.urls,
        authorize: isRepositoryAdmin,
        authorizeRead: (incoming, owner, name) => hasRepositoryAccess(incoming, owner, name, 'read'),
        authorizeWrite: (incoming, owner, name) => hasRepositoryAccess(incoming, owner, name, 'write'),
        actor: userLogin,
        ...(actions.secretsKey ? { secretsKey: actions.secretsKey } : {}),
        ...(actions.launcher ? { launcher: actions.launcher } : {}),
        checks: checkRuns,
        log: dispatch.log!,
        now: () => now().getTime(),
      }))
    )
  }

  const withJobTokens = (authorize: Authorize): Authorize => {
    if (!options.actions) return authorize
    return async (request, repo, access, ...rest) => {
      const credential = parseAuthorization(request.headers.get('Authorization'))
      const secret = credential.kind === 'secret' ? credential.secret : null
      if (access === 'read' && secret?.startsWith(GITHUB_TOKEN_PREFIX)) {
        const grant = await verifyToken(db, secret, 'github', now().getTime())
        if (grant && grant.owner === repo.owner && grant.repo === repo.name) return null
      }
      return authorize(request, repo, access, ...rest)
    }
  }

  const withSessionReads = (authorize: Authorize): Authorize => async (request, repo, access, ...rest) => {
    if (access === 'read' && !request.headers.has('Authorization') && !isUnsafeMethod(request.method)) {
      const active = await readActiveSession(request, loginOptions(request))
      if (active && (await repositoryAccess(sessionUserPrincipal(active.session), repo, 'read')).decision === 'allow') return null
    }
    return authorize(request, repo, access, ...rest)
  }

  const emitRunEvents = async (serverUrl: string, job: JobRow): Promise<void> => {
    const run = await getRun(db, job.run_id)
    if (!run) return
    const context = { baseUrl: serverUrl, repository: { owner: run.owner, name: run.repo }, actor: { kind: 'user' as const, id: null, login: run.actor } }
    await emit(workflowJobEvent(context, workflowJobPayload('completed', job, run, serverUrl, null)))
    const jobs = await listRunJobs(db, run.id)
    if (jobs.some((entry) => entry.status !== 'completed')) return
    const failed = jobs.some((entry) => entry.conclusion !== null && !['success', 'skipped', 'neutral'].includes(entry.conclusion))
    await emit(
      workflowRunEvent(context, 'completed', {
        id: run.id,
        name: run.workflow_name,
        path: run.workflow_path,
        event: run.event,
        status: 'completed',
        conclusion: failed ? 'failure' : 'success',
        headBranch: run.ref.replace(/^refs\/(heads|tags)\//, ''),
        headSha: run.sha,
        actor: run.actor,
        createdAt: run.created_at,
        updatedAt: now().getTime(),
      }),
    )
  }

  const emitPushEvents = async (request: Request, repo: RepositoryName, outcome: PushOutcome, principal: Principal | null): Promise<void> => {
    const actor = eventActorOf(principal)
    const context = { baseUrl: issuerFor(request), repository: repo, actor }
    const odb = new ObjectDatabase(storage, repo)
    const refs = (await readRefs(storage, repo))?.state.refs ?? {}
    const pushed = new Set(outcome.results.map((result) => result.name))
    const otherTips = new Set(Object.entries(refs).flatMap(([name, id]) => (pushed.has(name) || !name.startsWith('refs/heads/') ? [] : [id])))
    const email = principal?.kind === 'user' ? ((await notifications.store.usersById([principal.id]))[0]?.email ?? null) : null
    const infos = await pushInfos(outcome, { name: actor.login ?? actor.kind, email }, (id) => odb.read(id), otherTips)
    for (const info of infos) {
      if (info.before === ZERO_ID) await emit(refEvent(context, 'create', info.ref))
      await emit(pushEvent(context, info))
      if (info.after === ZERO_ID) await emit(refEvent(context, 'delete', info.ref))
    }
  }

  const afterPush = async (request: Request, repo: RepositoryName, outcome: PushOutcome, waitUntil: WaitUntil | undefined, principal: Principal | null): Promise<void> => {
    if (federation) await notifyAfterPush(federation)(repo, outcome)
    if (options.actions) await queueRunsForPush(dispatchOptions(request), { repo, outcome, actor: principal?.kind === 'user' ? principal.login : (principal?.kind ?? 'unknown') })
    if (!outcome.results.some((result) => result.ok)) return
    const events = emitPushEvents(request, repo, outcome, principal).catch((error: unknown) =>
      console.error(JSON.stringify({ event: 'push-events-failed', repository: `${repo.owner}/${repo.name}`, error: String(error) })),
    )
    if (waitUntil) waitUntil(events)
    else await events
  }

  const collaborationOptions = (request: Request, waitUntil?: WaitUntil): CollaborationOptions => ({
    db,
    storage,
    accounts: store,
    now: () => now().getTime(),
    onBranchUpdated: async (update: BranchUpdate) => {
      const outcome: PushOutcome = { unpack: 'ok', results: [{ name: update.ref, oldId: update.oldId, newId: update.newId, ok: true }], pack: null, objectCount: 0, archived: [] }
      await afterPush(request, update.repo, outcome, waitUntil, await apiPrincipal(request))
    },
    onActivity: async (scope, activity) => {
      await emit(await activityEvent(scope, activity, issuerFor(request)))
      if (options.actions && activity.kind === 'pull_request') {
        try {
          const pull = await getPullSummary(scope, activity.number)
          const actor = activity.actor.kind === 'system' ? 'system' : (await loadUsers(scope.db, [activity.actor]))(activity.actor).login
          await queueRunsForPullRequest(dispatchOptions(request), {
            repo: scope.repo,
            number: pull.number,
            action: activity.action,
            actor,
            title: pull.title,
            base: { ref: pull.baseRef, sha: pull.baseSha },
            head: { ref: pull.headRef, sha: pull.headSha, repo: scope.repo },
            trusted: true,
          })
        } catch (error) {
          console.log(JSON.stringify({ event: 'pull-request-runs-failed', repository: `${scope.repo.owner}/${scope.repo.name}`, number: activity.number, error: String(error) }))
        }
      }
    },
  })

  const refreshCollaboration = async (request: Request, repo: RepositoryName, outcome: PushOutcome, principal: Principal | null): Promise<void> => {
    const updates = outcome.results.filter((result) => result.ok)
    if (updates.length === 0) return
    try {
      const scope = await systemScope(collaborationOptions(request), repo.owner, repo.name)
      if (!scope) return
      await handlePushedRefs(scope, updates, (principal && actorRefOf(principal)) ?? { kind: 'system', id: null })
    } catch (error) {
      console.log(JSON.stringify({ event: 'collaboration-push-failed', repository: `${repo.owner}/${repo.name}`, error: (error as Error).message }))
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
    { method: 'POST', pattern: /^\/api\/admin\/invites$/, handler: createInvite },
    { method: 'GET', pattern: /^\/api\/user$/, handler: currentUser },
    { method: 'POST', pattern: /^\/api\/admin\/invites$/, handler: createInvite },
    { method: 'GET', pattern: /^\/api\/user$/, handler: currentUser },
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

  const compactAfterPush = (waitUntil: WaitUntil | undefined) => async (repo: RepositoryName, outcome: PushOutcome) => {
    if (!outcome.pack || options.compactMaxBytes === 0) return
    const compaction = compactRepository(storage, repo, { maxBytes: options.compactMaxBytes }).catch((error: unknown) =>
      console.error(JSON.stringify({ event: 'compaction-failed', repo: `${repo.owner}/${repo.name}`, error: String(error) })),
    )
    if (waitUntil) waitUntil(compaction)
    else await compaction
  }

  const packfileUris = async (request: Request, repo: RepositoryName, authorize: Authorize): Promise<PackfileUri | undefined> => {
    const anonymous = new Request(request.url, { method: 'GET' })
    return (await authorize(anonymous, repo, 'read', 'git')) ? undefined : publicPackfileUris(options.packfileUriBase)(request, repo)
  }

  const handle = async (request: Request, waitUntil?: WaitUntil): Promise<Response> => {
    const wellKnown = options.instanceKey ? handleWellKnownRequest(request, { issuer: issuerFor(request), keys: [options.instanceKey.publicJwk] }) : null
    if (wellKnown) return wellKnown
    const federated = federation ? await handleFederationRequest(federation, request) : null
    if (federated) return federated
    const login = await createLoginHandler(loginOptions(request))(request)
    if (login) return login
    const authentication = authenticateOptions(request)
    const protection = await handleBranchProtectionRequest(request, { store, authenticate: apiPrincipal })
    if (protection) return protection
    const notificationsResponse = await handleNotificationsRequest(request, {
      notifications,
      directory: store,
      authenticate: apiPrincipal,
      isInstanceAdmin: store.isInstanceAdmin,
      baseUrl: issuerFor,
      allowInsecureWebhooks: options.allowInsecureWebhooks ?? false,
    })
    if (notificationsResponse) return notificationsResponse
    const releases = await handleReleasesRequest(request, {
      db,
      storage,
      directory: store,
      authenticate: apiPrincipal,
      isInstanceAdmin: store.isInstanceAdmin,
      baseUrl: issuerFor,
      maxAssetBytes: options.maxLfsObjectBytes,
      ...(options.digests ? { digests: options.digests } : {}),
      now: () => now().getTime(),
      emit,
      onTagCreated: (repo, outcome, principal) => afterPush(request, repo, outcome, waitUntil, principal),
    })
    if (releases) return releases
    const collaboration = await handleCollaborationApi(request, {
      ...collaborationOptions(request, waitUntil),
      authenticate: apiPrincipal,
      verifyInstance: authentication.verifyInstance,
      ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
    })
    if (collaboration) return collaboration
    try {
      const actions = await actionsRoute(request)
      if (actions) return actions
      const api = await route(request)
      if (api) return api
    } catch (error) {
      if (error instanceof HttpError) return json(error.status, { error: error.message }, error.headers)
      if (error instanceof AccountsError) return json(400, { error: error.message })
      throw error
    }
    const access = createGitAccess(authentication)
    const authorize = withJobTokens(access.authorize)
    const content = await handleContentRequest(request, { storage, authorize: withSessionReads(authorize) })
    if (content) return content
    const git = await handleGitRequest(request, {
      storage,
      authorize,
      pushPolicy: access.pushPolicy,
      ...(options.maxPushBytes !== undefined ? { maxPushBytes: options.maxPushBytes } : {}),
      lfs: { maxObjectBytes: options.maxLfsObjectBytes },
      packfileUris: (incoming, repo) => packfileUris(incoming, repo, authorize),
      onPush: async (repo, outcome) => {
        await compactAfterPush(waitUntil)(repo, outcome)
        const principal = await authenticateRequest(request, authentication)
        await refreshCollaboration(request, repo, outcome, principal)
        await afterPush(request, repo, outcome, waitUntil, principal)
      },
    })
    return git ?? json(404, { error: 'not found' })
  }

  return {
    fetch: handle,
    services: {
      storage,
      store,
      authenticate: async (request) => {
        if (!request.headers.has('Authorization')) {
          const active = await readActiveSession(request, loginOptions(request))
          if (active) return sessionUserPrincipal(active.session)
        }
        return authenticateRequest(request, authenticateOptions(request))
      },
      issuer: issuerFor,
      repositoryAccess,
      isInstanceAdmin: async (principal) => principal.kind === 'user' && (await store.isInstanceAdmin(principal.id)),
      session: async (request) => {
        const active = await readActiveSession(request, loginOptions(request))
        return active ? { principal: sessionUserPrincipal(active.session), csrf: active.csrf } : null
      },
      verifySessionWrite: async (request) => {
        const check = await checkSession(request, loginOptions(request))
        return check.kind === 'session' ? { principal: sessionUserPrincipal(check.active.session), csrf: check.active.csrf } : null
      },
      loginOptions: { oidcName: oidc?.config.name ?? null },
      account: {
        listTokens: (user) => store.listTokens({ accountId: user.id }),
        createToken: (user, input) => store.createPersonalAccessToken(user.id, input, { kind: 'user', id: user.id }),
        revokeToken: async (user, tokenId) => {
          const own = (await store.listTokens({ accountId: user.id })).some((token) => token.id === tokenId)
          if (own) await store.revokeToken(tokenId, { kind: 'user', id: user.id })
          return own
        },
        listPasskeys: (user) => logins.listCredentials(user.id),
        revokePasskey: (user, id) => logins.revokeCredential(user.id, id),
      },
      inbox: {
        threads: (user, filter) => notifications.store.threads(user.id, { ...filter, participating: false }),
        markRead: (user, id) => notifications.store.markThreadRead(user.id, id),
        markDone: (user, id) => notifications.store.markThreadDone(user.id, id),
        markAllRead: (user) => notifications.store.markAllRead(user.id, now().getTime()),
      },
      collaboration: async (request, principal, owner, name) => {
        try {
          return await openCollaborationRepository(collaborationOptions(request), principal, owner, name)
        } catch (error) {
          if (error instanceof CollaborationError && error.status === 404) return null
          throw error
        }
      },
      releases: {
        list: (repository, includeDrafts, limit, offset) => releaseStore.list(repository.id, includeDrafts, limit, offset),
        byTag: async (repository, tag, includeDrafts) => {
          const release = await releaseStore.byTag(repository.id, tag)
          return release && (includeDrafts || release.draft === 0) ? release : null
        },
        assets: (releaseIds) => releaseStore.assets(releaseIds),
      },
    },
    scheduled: async (at = now()) => {
      const sweep = await notifications.sweep().catch((error: unknown) => ({ error: String(error) }))
      console.log(JSON.stringify({ event: 'notification-sweep', ...sweep }))
      return federation ? enqueueDueMirrors(federation, at, options.mirrorIntervalMinutes) : syncDueMirrors(mirrorContext(options.publicUrl), at, options.mirrorIntervalMinutes)
    },
    actionsTick: async () => {
      if (!options.actions) return null
      const serverUrl = options.publicUrl ?? 'http://localhost'
      return actionsTick({
        db,
        storage,
        urls: { serverUrl, serviceUrl: `${serverUrl}${ACTIONS_SERVICE_PATH}` },
        checks: checkRuns,
        ...(options.actions.launcher && options.publicUrl ? { launcher: options.actions.launcher } : {}),
        now: () => now().getTime(),
        log: (event) => console.log(JSON.stringify(event)),
      })
    },
    runJob: async (job) => {
      if (isNotificationJob(job)) return notifications.runJob(job)
      if (!federation) throw new Error('jobs need PUBLIC_URL, INSTANCE_KEY and a job queue')
      await runJob(federation, job)
    },
    notifications,
  }
}
