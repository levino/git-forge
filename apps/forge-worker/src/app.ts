import {
  type ActionsTick,
  actionsTick,
  advanceRun,
  cancelRun,
  type CheckRunReport,
  type CheckRunSink,
  queueRunsForPullRequest,
  type DispatchOptions,
  handleActionsService,
  handleResultsService,
  type CacheLimits,
  type IdTokenKey,
  isResultsServicePath,
  type SealedSecret,
  type SecretsKey,
  handleGhesApi,
  queueRunsForPush,
  type RunnerLauncher,
  type SecretsProvider,
  GITHUB_TOKEN_PREFIX,
  getJobById,
  getRun,
  getRunnerIncludingRemoved,
  type JobEventSink,
  type JobRow,
  listCurrentJobs,
  listRunJobs,
  listRuns,
  listRunWorkflows,
  openArtifactFile,
  readJobLog,
  RerunError,
  rerunRun,
  type RunRow,
  type RunWorkflow,
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
  createAppsStore,
  createMirrorVerificationStore,
  createLoginHandler,
  createLoginStore,
  createOidcProvider,
  createGitAccess,
  createInstanceVerifier,
  type InstancePrincipal,
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
  type AppPermissions,
  installationNeeds,
  isLfsBatchPath,
  missingPermission,
  tokenKindOf,
  repositoryWorkflowCheck,
  restrictsWorkflows,
  type Principal,
  type RepositorySubject,
  type Role,
  type UserPrincipal,
  type VisibilityAudience,
  readActiveSession,
  isUnsafeMethod,
  type CreatedToken,
  type CredentialSummary,
  createOrganizationOperations,
  createScimHandler,
  type OrganizationOperations,
  OrganizationError,
  createInstanceAdministration,
  type InstanceAdministration,
  InstanceAdministrationError,
  isReservedLogin,
  archivedBlocks,
  LOGIN_PATTERN,
  parseRepositoryMetadata,
  type LoginStore,
  type OidcProvider,
  sql,
  type BranchProtectionRule,
  type NamedAllowances,
  validateBranchPattern,
  parseBranchProtectionSettings,
  protectionAuditActor,
  ProtectionValidationError,
  BranchPatternError,
  type TokenScope,
  listReadableRepositories,
  type Page,
  type RepositoryListing,
  type RepositoryListOptions,
  SEARCH_INDEX_REBUILD,
  type SearchResults,
  type SearchType,
  setRepositoryStats,
} from '@git-forge/accounts'
import {
  type Authorize,
  type ReadView,
  compactRepository,
  configureMirror,
  createRepository,
  deepCheckMirror,
  detachMirror,
  type CopyBudget,
  type DigestFactory,
  EmailRejectedError,
  type EmailSender,
  type FetchFunction,
  GitHubApiError,
  handleArchiveRequest,
  handleContentRequest,
  handleGitRequest,
  type JobQueue,
  importLfsObject,
  type ImportJob,
  type ImportLfsJob,
  type ImportMetadataResult,
  javascriptDigests,
  type ImportScheduler,
  type ImportState,
  ImportRunningError,
  isValidImportUrl,
  isValidName,
  listGitHubRepositories,
  listLfsOids,
  listMirrors,
  type LfsPublisher,
  type MirrorConfig,
  type MirrorMode,
  type MirrorSettings,
  type MirrorStatus,
  type DeepCheck,
  MirrorExistsError,
  MirrorNotFoundError,
  ObjectDatabase,
  type PackfileUri,
  PermanentJobError,
  type Presigner,
  publicPackfileUris,
  publishLfsObjects,
  type PushOutcome,
  readAll,
  readMirrorConfig,
  readImportState,
  readMirrorStatus,
  readRefs,
  repositoryStats,
  RepositoryExistsError,
  type RepositoryName,
  type SentEmail,
  SizeLimitError,
  startImport,
  type Storage,
  type SyncResult,
  withPresigner,
  locatedStorage,
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
  maintainerPushBranches,
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
import { type ArtifactSource, createPages, isPagesJob, type PagesJob } from '@git-forge/pages'
import { type AssetRow, createReleaseStore, handleReleasesRequest, type ReleaseOperations, releaseOperations, type ReleaseRow, type ReleasesOptions } from '@git-forge/releases'
import { AdminError, type AdminOperations, createAdminOperations, readOidcSettings } from './admin/operations.ts'
import { createJobFailures } from './admin/jobs.ts'
import { createInstanceSettings, deriveSettingsKey } from './admin/settings.ts'
import type { Location } from './admin/setup.ts'
import { createUsageMeter, type UsageScanJob } from './admin/usage.ts'
import { activityEvent } from './collaboration-events.ts'
import { parseSearchRequest, repositoryJson, runSearch, type SearchRequest, searchResponseJson } from './search.ts'
import { type GithubProgress, githubImportStep, githubRepository } from './github-import.ts'
import { mirrorOverview, recordChecksums, signOverview } from './mirror-verification.ts'
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
import { type BackupJob, type BackupStatus, backupStatus, backupStep, startBackup, verifyBackup } from './backup.ts'
import { MirrorAuthError, type MirrorContext, runMirrorSync, type ScheduledMirrorRun, syncDueMirrors } from './mirrors.ts'
import { receiveGitHubWebhook, setUpGitHubWebhook } from './github-mirrors.ts'
import { createGitHubApps, type GitHubApps } from './github-apps.ts'
import { createMirrorSecrets, MirrorSecretsUnavailableError } from './mirror-secrets.ts'

export type ActionsOptions = {
  readonly instanceId: string
  readonly launcher?: RunnerLauncher
  readonly secrets?: SecretsProvider
  readonly secretsKey?: SecretsKey
  readonly repositories?: Readonly<Record<string, string>>
  readonly githubFallback?: string | null
  readonly idTokenKeys?: readonly IdTokenKey[]
  readonly artifactRetentionDays?: number
  readonly cacheLimits?: CacheLimits
}

export type ForgeOptions = ForgeSettings & {
  readonly storage: Storage
  readonly db: Database
  readonly fetch?: FetchFunction
  readonly now?: () => Date
  readonly actions?: ActionsOptions
  readonly jobs?: JobQueue<AppJob>
  readonly digests?: DigestFactory
  readonly secretsKey?: SecretsKey
  readonly presigner?: Presigner
  readonly scheduleImport?: ImportScheduler
  readonly email?: EmailSender
  readonly renderLoginPage?: LoginPageRenderer
  readonly clientAddress?: (request: Request) => string | null
  readonly artifacts?: ArtifactSource
  readonly lfsPublisher?: LfsPublisher
  readonly version?: string
  readonly location?: (request: Request) => Promise<Location>
  readonly backup?: Storage
  readonly backupBudget?: CopyBudget
}

export type LfsPublishJob = { readonly kind: 'lfs-publish'; readonly owner: string; readonly name: string; readonly oids: readonly string[] | null }

export type GitHubMirrorJob = {
  readonly kind: 'mirror-github'
  readonly owner: string
  readonly name: string
  readonly url: string
  readonly visibility: 'private' | 'public'
  readonly defaultBranch: string
  readonly actor: { readonly id: string; readonly login: string }
  readonly mode: MirrorMode
  readonly lfs: boolean
  readonly private: boolean
  readonly webhook: boolean
  readonly sealedToken?: SealedSecret
}

export type AppJob = ForgeJob | NotificationJob | PagesJob | LfsPublishJob | ImportLfsJob | GitHubMirrorJob | BackupJob | UsageScanJob

export const LFS_PUBLISH_BATCH = 100

export const OIDC_SETTINGS_TTL_MS = 30_000

export type WaitUntil = (promise: Promise<unknown>) => void

export const ACTIONS_SERVICE_PATH = '/_services/actions'

export const PRESIGN_HINT =
  'the instance admin can let larger objects go straight to R2 by setting R2_S3_ENDPOINT, R2_BUCKET_NAME, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY and raising MAX_LFS_OBJECT_BYTES (see "Large LFS objects" in the instance README)'

export const RAISE_LIMIT_HINT = 'the instance admin can raise MAX_LFS_OBJECT_BYTES up to about 5 GiB'

export type ForgeServices = {
  readonly storage: Storage
  readonly store: AccountsStore
  readonly authenticate: (request: Request) => Promise<Principal | null>
  readonly issuer: (request: Request) => string
  readonly repositoryAccess: (principal: Principal, repo: RepositoryName, required: Role) => Promise<RepositoryAccess>
  readonly isInstanceAdmin: (principal: Principal) => Promise<boolean>
  readonly session: (request: Request) => Promise<UiSession | null>
  readonly verifySessionWrite: (request: Request) => Promise<UiSession | null>
  readonly loginMethods: () => Promise<{ readonly oidcName: string | null; readonly passkeys: boolean }>
  readonly observe: (waitUntil?: WaitUntil) => Promise<void>
  readonly account: AccountOperations
  readonly repositories: RepositoryOperations
  readonly inbox: InboxOperations
  readonly releases: ReleaseReads
  readonly collaboration: (request: Request, principal: Principal, owner: string, name: string) => Promise<CollaborationScope | null>
  readonly actions: ActionsOperations
  readonly settings: RepositorySettingsOperations
  readonly organizations: OrganizationOperations
  readonly instance: InstanceOperations
  readonly renameAccount: (principal: Principal, login: string, newLogin: string) => Promise<{ readonly id: string; readonly login: string }>
  readonly redirect: (request: Request, principal: Principal) => Promise<string | null>
  readonly listRepositories: (principal: Principal, options: RepositoryListOptions) => Promise<Page<RepositoryListing>>
  readonly search: (principal: Principal, request: SearchRequest) => Promise<SearchResults>
  readonly githubApps: GitHubApps['ui']
}

export type MirrorOverviewEntry = { readonly repository: RepositoryName; readonly config: MirrorConfig; readonly status: MirrorStatus | null }

export type BackupOperations = {
  readonly status: (principal: Principal) => Promise<BackupStatus>
  readonly run: (principal: Principal) => Promise<BackupStatus>
  readonly verify: (principal: Principal, sample: number) => Promise<{ readonly checked: number; readonly failures: string[] }>
}

export type InstanceOperations = InstanceAdministration &
  AdminOperations & {
    readonly mirrors: (principal: Principal) => Promise<MirrorOverviewEntry[]>
    readonly sendTestEmail: (principal: Principal, to: string | null) => Promise<SentEmail>
    readonly backup: BackupOperations
  }

export type InboxOperations = {
  readonly threads: (user: UserPrincipal, filter: { readonly all: boolean; readonly limit: number; readonly offset: number }) => Promise<ThreadRow[]>
  readonly markRead: (user: UserPrincipal, id: number) => Promise<boolean>
  readonly markDone: (user: UserPrincipal, id: number) => Promise<boolean>
  readonly markAllRead: (user: UserPrincipal) => Promise<number>
}

export type RepositorySettings = {
  readonly repository: RepositorySubject
  readonly collaborators: readonly { readonly id: string; readonly login: string; readonly role: Role }[]
  readonly instances: readonly { readonly issuer: string; readonly role: string }[]
  readonly mirrors: readonly { readonly config: MirrorConfig; readonly status: MirrorStatus | null }[]
}

export type RepositorySettingsOperations = {
  readonly read: (principal: Principal, repo: RepositoryName) => Promise<RepositorySettings>
  readonly setVisibility: (principal: Principal, repo: RepositoryName, visibility: string) => Promise<{ readonly owner: string; readonly name: string; readonly visibility: string }>
  readonly setCollaborator: (principal: Principal, repo: RepositoryName, login: string, role: string) => Promise<{ readonly login: string; readonly role: Role }>
  readonly removeCollaborator: (principal: Principal, repo: RepositoryName, login: string) => Promise<void>
  readonly grantInstance: (principal: Principal, repo: RepositoryName, issuer: string) => Promise<{ readonly issuer: string; readonly role: string }>
  readonly revokeInstance: (principal: Principal, repo: RepositoryName, issuer: string) => Promise<void>
  readonly addMirror: (principal: Principal, repo: RepositoryName, input: MirrorSettings, token?: string) => Promise<MirrorConfig>
  readonly syncMirror: (principal: Principal, repo: RepositoryName, remote: string, issuer: string | undefined) => Promise<SyncResult>
  readonly verifyMirror: (principal: Principal, repo: RepositoryName, remote: string) => Promise<DeepCheck>
  readonly detachMirror: (principal: Principal, repo: RepositoryName, remote: string) => Promise<MirrorConfig>
  readonly branchProtection: (principal: Principal, repo: RepositoryName) => Promise<readonly { readonly rule: BranchProtectionRule; readonly names: NamedAllowances }[]>
  readonly setBranchProtection: (principal: Principal, repo: RepositoryName, pattern: string, body: Record<string, unknown>) => Promise<BranchProtectionRule>
  readonly deleteBranchProtection: (principal: Principal, repo: RepositoryName, pattern: string) => Promise<boolean>
  readonly setMetadata: (principal: Principal, repo: RepositoryName, input: Record<string, unknown>) => Promise<void>
  readonly setArchived: (principal: Principal, repo: RepositoryName, archived: boolean) => Promise<void>
  readonly move: (principal: Principal, repo: RepositoryName, target: { readonly owner?: string; readonly name?: string }) => Promise<RepositoryName>
  readonly remove: (principal: Principal, repo: RepositoryName) => Promise<void>
}

export class ForgeError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message)
  }
}

export type RerunChoice = { readonly kind: 'all' } | { readonly kind: 'failed' } | { readonly kind: 'job'; readonly jobId: string }

export type ActionsOperations = {
  readonly runs: (repository: RepositoryName, limit: number, workflowPath?: string | null) => Promise<RunRow[]>
  readonly workflows: (repository: RepositoryName) => Promise<RunWorkflow[]>
  readonly run: (repository: RepositoryName, id: number) => Promise<{ readonly run: RunRow; readonly jobs: readonly JobRow[] } | null>
  readonly log: (repository: RepositoryName, runId: number, jobId: string) => Promise<{ readonly job: JobRow; readonly log: Uint8Array[] } | null>
  readonly canWrite: (principal: Principal, repository: RepositoryName) => Promise<boolean>
  readonly cancel: (principal: Principal, repository: RepositoryName, runId: number, issuer: string) => Promise<void>
  readonly rerun: (principal: Principal, repository: RepositoryName, runId: number, choice: RerunChoice, issuer: string) => Promise<number>
}

export type ReleaseReads = {
  readonly list: (repository: RepositorySubject, includeDrafts: boolean, limit: number, offset: number) => Promise<ReleaseRow[]>
  readonly byTag: (repository: RepositorySubject, tag: string, includeDrafts: boolean) => Promise<ReleaseRow | null>
  readonly assets: (releaseIds: readonly number[]) => Promise<AssetRow[]>
  readonly latest: (repository: RepositorySubject) => Promise<ReleaseRow | null>
  readonly write: (request: Request, principal: Principal) => ReleaseOperations
}

export type NewRepository = { readonly owner: string; readonly name: string; readonly visibility?: string; readonly defaultBranch?: string }

export type CreatedRepository = { readonly owner: string; readonly name: string; readonly visibility: string; readonly defaultBranch: string }

export type NewImport = NewRepository & {
  readonly url: string
  readonly token?: string
  readonly username?: string
  readonly lfs?: boolean
  readonly lfsUrl?: string
  readonly commitsPerStep?: number
  readonly metadata?: boolean
}

export type StartedImport = RepositoryName & { readonly state: ImportState }

export type GitHubBackup = {
  readonly account: string
  readonly owner: string
  readonly token?: string
  readonly visibility?: string
  readonly mode?: string
  readonly forks?: boolean
  readonly archived?: boolean
  readonly webhook?: boolean
  readonly lfs?: boolean
}

export type GitHubBackupResult = {
  readonly owner: string
  readonly account: string
  readonly queued: readonly { readonly github: string; readonly repository: string }[]
  readonly skipped: readonly { readonly github: string; readonly repository: string; readonly reason: string }[]
}

export type RepositoryOperations = {
  readonly owners: (user: UserPrincipal) => Promise<string[]>
  readonly create: (user: UserPrincipal, input: NewRepository) => Promise<CreatedRepository>
  readonly importsEnabled: boolean
  readonly startImport: (user: UserPrincipal, input: NewImport) => Promise<StartedImport>
  readonly importStatus: (user: UserPrincipal, repo: RepositoryName) => Promise<ImportState | null>
  readonly mirrorGitHub: (user: UserPrincipal, input: GitHubBackup) => Promise<GitHubBackupResult>
}

export type UiSession = { readonly principal: UserPrincipal; readonly csrf: string; readonly sessionId: string }

export type AccountOperations = {
  readonly listTokens: (user: UserPrincipal) => ReturnType<AccountsStore['listTokens']>
  readonly createToken: (user: UserPrincipal, input: { readonly name: string; readonly scopes: readonly TokenScope[]; readonly expiresAt: number | null }) => Promise<CreatedToken>
  readonly revokeToken: (user: UserPrincipal, tokenId: string) => Promise<boolean>
  readonly listPasskeys: (user: UserPrincipal) => Promise<CredentialSummary[]>
  readonly revokePasskey: (user: UserPrincipal, id: string) => Promise<boolean>
  readonly listIdentities: (user: UserPrincipal) => ReturnType<AccountsStore['listExternalIdentities']>
  readonly unlinkIdentity: (user: UserPrincipal, issuer: string, subject: string) => Promise<boolean>
  readonly listSessions: (user: UserPrincipal) => ReturnType<LoginStore['listSessions']>
  readonly revokeSession: (user: UserPrincipal, id: string) => Promise<boolean>
}

export type RepositoryAccess = {
  readonly decision: Decision
  readonly access: Access
  readonly repository: RepositorySubject | null
  readonly view?: ReadView | null
}

export type Forge = {
  readonly fetch: (request: Request, waitUntil?: WaitUntil) => Promise<Response>
  readonly isPagesRequest: (request: Request) => boolean
  readonly services: ForgeServices
  readonly scheduled: (at?: Date) => Promise<ScheduledMirrorRun[]>
  readonly actionsTick: () => Promise<ActionsTick | null>
  readonly runJob: (job: AppJob, attempt?: number) => Promise<void>
  readonly refreshRepository: (repo: RepositoryName) => Promise<void>
  readonly importMetadata: (job: ImportJob, state: ImportState) => Promise<ImportMetadataResult>
  readonly notifications: Notifications
}

export const HttpError = ForgeError

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } })

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

const REPOSITORY_URL = /^(\/api(?:\/v3|\/uploads)?\/repos)?\/([^/]+)\/([^/]+?)(\.git)?(\/.*)?$/

const unprocessable = <T>(parse: () => T): T => {
  try {
    return parse()
  } catch (error) {
    if (error instanceof AccountsError) throw new HttpError(422, error.message)
    throw error
  }
}

export const basicAuthorization = (username: string, password: string): string => {
  const bytes = new TextEncoder().encode(`${username}:${password}`)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `Basic ${btoa(binary)}`
}

type Route = { readonly pattern: RegExp; readonly method: string; readonly handler: (request: Request, params: string[]) => Promise<Response> }

export const createForge = (options: ForgeOptions): Forge => {
  const now = options.now ?? (() => new Date())
  const nowMs = () => now().getTime()
  const meter = createUsageMeter(options.db, nowMs)
  const metered = meter.storage(options.storage)
  const db = meter.database(options.db)
  const store: AccountsStore = createAccountsStore(db, { now: () => now().getTime() })
  const located = (raw: Storage): Storage => locatedStorage(raw, store.locateRepository, () => now().getTime())
  const storage = located(metered)
  const presigningStorage = options.presigner ? located(withPresigner(metered, options.presigner)) : storage
  const storedObject = async (key: string, size: number): Promise<void> => {
    const [, owner, name] = /^repos\/([^/]+)\/([^/]+)\//.exec(key) ?? []
    const path = owner && name ? (await store.locateRepository(owner, name))?.path : null
    await meter.record([{ key: path ? `repos/${path}/${key.split('/').slice(3).join('/')}` : key, size }])
  }
  const verification = createMirrorVerificationStore(db, { now: () => now().getTime() })
  const mirrorSecrets = createMirrorSecrets(db, options.secretsKey ?? options.actions?.secretsKey, () => now().getTime())
  const logins = createLoginStore(db, { now: () => now().getTime() })
  const outbound = (input: string, init?: RequestInit) => (options.fetch ? options.fetch(new Request(input, init)) : fetch(input, init))
  let settingsKey: Promise<SecretsKey | null> | undefined
  const explicitKey = options.secretsKey ?? options.actions?.secretsKey
  const instanceSettings = createInstanceSettings(db, () => (settingsKey ??= explicitKey ? Promise.resolve(explicitKey) : options.bootstrapToken ? deriveSettingsKey(options.bootstrapToken) : Promise.resolve(null)), nowMs)
  const failures = createJobFailures(db, instanceSettings, nowMs)
  let oidcCache: { readonly at: number; readonly key: string; readonly provider: OidcProvider | null } | null = null
  const oidcProvider = async (): Promise<OidcProvider | null> => {
    if (oidcCache && nowMs() - oidcCache.at < OIDC_SETTINGS_TTL_MS) return oidcCache.provider
    const config = options.login?.oidc ?? (await readOidcSettings(instanceSettings))
    const key = JSON.stringify(config)
    const provider = oidcCache?.key === key ? oidcCache.provider : config ? createOidcProvider(config, outbound, nowMs) : null
    oidcCache = { at: nowMs(), key, provider }
    return provider
  }
  const jwks: JwksSource = createJwksCache({
    allowInsecureHttp: options.allowInsecureFederation,
    ...(options.fetch ? { fetch: (input, init) => options.fetch!(new Request(input, init)) } : {}),
  })
  const issuerFor = (request: Request): string => options.publicUrl ?? normalizeIssuer(new URL(request.url).origin)

  const authenticateOptions = (request: Request) => ({
    directory: store,
    verifyInstance: createInstanceVerifier({ audience: issuerFor(request), trust: store.lookupTrustedIssuer, jwks }),
  })

  const membershipSource = options.login?.membershipSource ?? 'forge'

  const loginOptions = async (request: Request): Promise<LoginHttpOptions> => {
    const origin = new URL(issuerFor(request)).origin
    const context: LoginContext = {
      store,
      logins,
      origin,
      rp: relyingParty(origin),
      oidc: await oidcProvider(),
      selfSignup: options.login?.selfSignup ?? false,
      breakGlassKey: options.login?.breakGlassKey ?? null,
      passkeys: options.login?.passkeys ?? true,
      membershipSource: membershipSource,
      ...(options.login?.groupsClaim ? { groupsClaim: options.login.groupsClaim } : {}),
      fetch: outbound,
      now: () => now().getTime(),
    }
    return {
      context,
      secureCookies: origin.startsWith('https:'),
      ...(options.renderLoginPage ? { renderPage: options.renderLoginPage } : {}),
      ...(options.clientAddress ? { clientAddress: options.clientAddress } : {}),
    }
  }

  const principalOf = async (request: Request): Promise<Principal> => {
    if (!request.headers.has('Authorization')) {
      const check = await checkSession(request, (await loginOptions(request)))
      if (check.kind === 'csrf-failed') throw new HttpError(403, 'missing or invalid CSRF token')
      if (check.kind === 'session') return sessionUserPrincipal(check.active.session)
    }
    const principal = await authenticateRequest(request, authenticateOptions(request))
    if (!principal) throw new HttpError(401, 'invalid credentials', { 'WWW-Authenticate': 'Bearer' })
    return principal
  }

  const apiPrincipal = async (request: Request): Promise<Principal | null> => {
    if (!request.headers.has('Authorization')) {
      const check = await checkSession(request, (await loginOptions(request)))
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
        return { decision: atLeast(ceiling, required) && !archivedBlocks(check.repository, required) ? 'allow' : 'forbidden', access: ceiling, repository: check.repository }
      }
    }
    return { decision: check.decision, access: check.access, repository: check.repository, view: check.view ?? null }
  }

  const instanceRead = async (principal: InstancePrincipal, repo: RepositoryName): Promise<ReadView | 'full' | null> => {
    const check = await checkRepositoryAccess(store, principal, repo, 'read')
    return check.decision === 'allow' ? 'full' : (check.view ?? null)
  }

  const refreshRepository = async (repo: RepositoryName): Promise<void> => {
    try {
      const subject = await store.findRepository(repo.owner, repo.name)
      if (subject) await setRepositoryStats(db, subject.id, await repositoryStats(storage, repo), now().getTime())
    } catch (error) {
      console.error(JSON.stringify({ event: 'repository-stats-failed', repository: `${repo.owner}/${repo.name}`, error: String(error) }))
    }
  }

  const listRepositories = async (principal: Principal, listOptions: RepositoryListOptions): Promise<Page<RepositoryListing>> => {
    const page = await listReadableRepositories(db, principal, listOptions)
    const items = await Promise.all(
      page.items.map(async (repo) => {
        if (repo.statsAt !== null) return repo
        const stats = await repositoryStats(storage, repo)
        await setRepositoryStats(db, repo.id, stats, now().getTime())
        return { ...repo, ...stats, statsAt: now().getTime() }
      }),
    )
    return { ...page, items }
  }

  const repositoryAdmin = async (principal: UserPrincipal, repo: RepositoryName): Promise<RepositorySubject> => {
    const check = await repositoryAccess(principal, repo, 'admin')
    if (check.repository && check.decision === 'allow') return check.repository
    const [status, message] = DECISION_STATUS[check.decision === 'allow' ? 'not-found' : check.decision]
    throw new HttpError(status, message)
  }

  const adminOf = async (principal: Principal, repo: RepositoryName): Promise<{ principal: UserPrincipal; repository: RepositorySubject }> => {
    if (principal.kind === 'anonymous') throw new HttpError(401, 'authentication required', { 'WWW-Authenticate': 'Bearer' })
    if (!canManage(principal)) throw new HttpError(403, 'this needs a personal access token with the repo:admin scope')
    return { principal, repository: await repositoryAdmin(principal, repo) }
  }

  const requireRepositoryAdmin = async (request: Request, repo: RepositoryName): Promise<{ principal: UserPrincipal; repository: RepositorySubject }> =>
    adminOf(await principalOf(request), repo)

  const releaseStore = createReleaseStore(db, () => now().getTime())

  const jobTokenRepository = async (request: Request): Promise<RepositoryName | null> => {
    if (!options.actions) return null
    const credential = parseAuthorization(request.headers.get('Authorization'))
    const secret = credential.kind === 'secret' ? credential.secret : null
    if (!secret?.startsWith(GITHUB_TOKEN_PREFIX)) return null
    const grant = await verifyToken(db, secret, 'github', now().getTime())
    if (!grant?.owner || !grant.repo || !grant.job_id) return null
    const job = await getJobById(db, grant.job_id)
    const run = job ? await getRun(db, job.run_id) : null
    return run && run.trusted === 1 && run.event !== 'pull_request' ? { owner: grant.owner, name: grant.repo } : null
  }

  const pages = createPages({
    db,
    storage,
    directory: store,
    hosts: options.pages?.hosts ?? null,
    forgeUrl: options.publicUrl ?? null,
    baseUrl: issuerFor,
    authenticate: apiPrincipal,
    authenticateToken: (request) => authenticateRequest(request, authenticateOptions(request)),
    sessionUser: async (request) => {
      const active = await readActiveSession(request, (await loginOptions(request)))
      return active ? sessionUserPrincipal(active.session) : null
    },
    isInstanceAdmin: store.isInstanceAdmin,
    jobTokenRepository,
    artifacts: options.artifacts ?? (async (repository, artifact) => (artifact.id && /^\d+$/.test(artifact.id) ? openArtifactFile(db, storage, repository.owner, repository.name, Number(artifact.id), now().getTime()) : null)),
    ...(options.jobs ? { schedule: (job: PagesJob) => options.jobs!.enqueue(job) } : {}),
    ...(options.digests ? { digests: options.digests } : {}),
    ...(options.pages?.maxAgeSeconds !== undefined ? { maxAgeSeconds: options.pages.maxAgeSeconds } : {}),
    now: () => now().getTime(),
    log: (event) => console.log(JSON.stringify(event)),
  })

  const publishLfs = async (job: LfsPublishJob): Promise<void> => {
    const publisher = options.lfsPublisher
    const repository = await store.findRepository(job.owner, job.name)
    if (!publisher || repository?.visibility !== 'public') return
    const repo = { owner: repository.owner, name: repository.name }
    if (job.oids === null) {
      let batch: string[] = []
      for await (const oid of listLfsOids(storage, repo)) {
        batch.push(oid)
        if (batch.length === LFS_PUBLISH_BATCH) {
          await scheduleLfsPublish({ ...job, oids: batch })
          batch = []
        }
      }
      if (batch.length > 0) await scheduleLfsPublish({ ...job, oids: batch })
      return
    }
    const summary = await publishLfsObjects(storage, repo, publisher, job.oids)
    console.log(JSON.stringify({ event: 'lfs-published', repository: `${repo.owner}/${repo.name}`, published: summary.published.length, present: summary.present.length, missing: summary.missing.length }))
  }

  const scheduleLfsPublish = async (job: LfsPublishJob): Promise<void> => {
    if (options.jobs) await options.jobs.enqueue(job)
    else await publishLfs(job)
  }

  const publishAfterPush = async (repo: RepositoryName, outcome: PushOutcome): Promise<void> => {
    const oids = [...new Set((outcome.lfsPointers ?? []).map((pointer) => pointer.oid))]
    if (!options.lfsPublisher || oids.length === 0 || !outcome.results.some((result) => result.ok)) return
    if ((await store.findRepository(repo.owner, repo.name))?.visibility !== 'public') return
    for (let i = 0; i < oids.length; i += LFS_PUBLISH_BATCH) await scheduleLfsPublish({ kind: 'lfs-publish', owner: repo.owner, name: repo.name, oids: oids.slice(i, i + LFS_PUBLISH_BATCH) })
  }

  const publishRepositoryLfs = async (request: Request, params: string[]): Promise<Response> => {
    const { repository } = await requireRepositoryAdmin(request, repoName(params))
    if (!options.lfsPublisher) throw new HttpError(503, 'no LFS publish target is configured')
    if (repository.visibility !== 'public') throw new HttpError(422, 'only public repositories are published')
    await scheduleLfsPublish({ kind: 'lfs-publish', owner: repository.owner, name: repository.name, oids: null })
    return json(202, { queued: true })
  }

  const notifications = createNotifications({
    db,
    directory: store,
    storage,
    ...(options.jobs ? { jobs: options.jobs } : {}),
    ...(options.email ? { email: options.email } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    allowInsecureWebhooks: options.allowInsecureWebhooks ?? false,
    ...(mirrorSecrets.available ? { secrets: mirrorSecrets } : {}),
    ...(options.publicUrl ? { baseUrl: options.publicUrl } : {}),
    now: () => now().getTime(),
  })

  const githubApps = createGitHubApps({
    apps: createAppsStore(db, store, () => now().getTime()),
    accounts: store,
    notifications,
    principal: apiPrincipal,
    baseUrl: issuerFor,
    allowInsecureWebhooks: options.allowInsecureWebhooks ?? false,
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
    secrets: mirrorSecrets,
    onSynced: async (repo, config, result) => {
      await emitMirrorAlarms(repo, config, result)
      if (result.updates.length > 0) await refreshRepository(repo)
    },
  })

  const federation: MirrorFederation | null =
    options.publicUrl && options.instanceKey && options.jobs
      ? {
          ...mirrorContext(options.publicUrl),
          issuer: options.publicUrl,
          instanceKey: options.instanceKey,
          jwks,
          jobs: options.jobs,
          verification,
          canRead: instanceRead,
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
    if (presented === null) throw new HttpError(401, 'invalid bootstrap token', { 'WWW-Authenticate': 'Bearer' })
    const body = await readBody(request)
    const email = optionalString(body, 'email')
    const claim = await instance.claim(presented, { login: requiredString(body, 'login'), ...(email ? { email } : {}) }, 'token')
    return json(201, { login: claim.login, token: claim.token })
  }

  const createUser = async (request: Request): Promise<Response> => {
    const actor = await requireInstanceAdmin(request)
    const body = await readBody(request)
    const login = requiredString(body, 'login')
    const email = optionalString(body, 'email')
    if (isReservedLogin(login)) throw new HttpError(422, `${login} is reserved`)
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

  const sendInviteEmail = async (sender: EmailSender, to: string, url: string, days: number): Promise<boolean> => {
    try {
      await sender.send({ to: [to], subject: 'Your git-forge invitation', text: `You are invited to ${new URL(url).host}. Accept within ${days} days:\n\n${url}\n` })
      return true
    } catch (error) {
      console.error(JSON.stringify({ event: 'invite-email-failed', error: String(error) }))
      return false
    }
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
    const url = new URL(`/login/invite/${invite.code}`, issuerFor(request)).toString()
    const emailed = email !== undefined && options.email !== undefined && (await sendInviteEmail(options.email, email, url, days))
    return json(201, { code: invite.code, url, expiresAt: invite.expiresAt, emailed })
  }

  const instanceAdministration = createInstanceAdministration(store)

  const admin = createAdminOperations({
    store,
    logins,
    storage,
    settings: instanceSettings,
    failures,
    meter,
    fetch: outbound,
    now: nowMs,
    version: options.version ?? 'dev',
    bootstrapToken: options.bootstrapToken,
    varsOidc: options.login?.oidc ?? null,
    facts: {
      presigned: options.presigner !== undefined,
      maxLfsObjectBytes: options.maxLfsObjectBytes,
      imports: options.scheduleImport !== undefined,
      jobs: options.jobs !== undefined,
      actions: options.actions !== undefined,
      runners: options.actions?.launcher !== undefined,
      publicUrl: options.publicUrl ?? null,
    },
    location: options.location ?? (async () => ({ colo: null, databaseRegion: null })),
    pingDatabase: () => options.db.all(sql('SELECT 1 AS ok')),
    enqueue: async (job) => (options.jobs ? options.jobs.enqueue(job as AppJob) : runAppJob(job as AppJob)),
    onOidcChanged: () => {
      oidcCache = null
    },
  })

  const instance: InstanceOperations = {
    ...instanceAdministration,
    ...admin,
    mirrors: async (principal) => {
      await instanceAdministration.view(principal)
      const overview: MirrorOverviewEntry[] = []
      for (const subject of await store.listRepositories()) {
        const repository = { owner: subject.owner, name: subject.name }
        for (const config of await listMirrors(storage, repository)) overview.push({ repository, config, status: await readMirrorStatus(storage, repository, config.remote) })
      }
      return overview
    },
    sendTestEmail: async (principal, to) => {
      await instanceAdministration.view(principal)
      if (!options.email) throw new InstanceAdministrationError(422, 'no email provider is configured')
      const address = to || (principal.kind === 'user' ? (await store.findUserById(principal.id))?.email : null)
      if (!address) throw new InstanceAdministrationError(422, 'your account has no email address; enter one')
      try {
        return await options.email.send({ to: [address], subject: 'git-forge test email', text: `Email from ${options.publicUrl ?? 'your git-forge instance'} works.` })
      } catch (error) {
        if (error instanceof EmailRejectedError) throw new InstanceAdministrationError(422, error.message)
        throw error
      }
    },
    backup: {
      status: async (principal) => {
        await instanceAdministration.view(principal)
        return backupStatus(db, options.backup !== undefined, now())
      },
      run: async (principal) => {
        await instanceAdministration.view(principal)
        if (!options.backup) throw new HttpError(409, 'no backup target is configured (BACKUP bucket binding or BACKUP_STORAGE)')
        await startBackup(db, now())
        await scheduleBackup()
        return backupStatus(db, true, now())
      },
      verify: async (principal, sample) => {
        await instanceAdministration.view(principal)
        if (!options.backup) throw new HttpError(409, 'no backup target is configured (BACKUP bucket binding or BACKUP_STORAGE)')
        return verifyBackup(db, options.backup, options.digests ?? javascriptDigests, sample)
      },
    },
  }

  const backupContext = (target: Storage) => ({ db, source: storage, target, digests: options.digests ?? javascriptDigests, now, ...(options.backupBudget ? { budget: options.backupBudget } : {}) })

  const scheduleBackup = async (): Promise<void> => {
    if (!options.backup) return
    if (options.jobs) return options.jobs.enqueue({ kind: 'backup' })
    while (await backupStep(backupContext(options.backup))) {}
  }

  const runBackupJob = async (): Promise<void> => {
    if (options.backup && (await backupStep(backupContext(options.backup)))) await scheduleBackup()
  }

  const sendTestEmailRoute = async (request: Request): Promise<Response> =>
    json(200, await instance.sendTestEmail(await principalOf(request), optionalString(await readBody(request), 'to') ?? null))

  const trustInstance = async (request: Request): Promise<Response> => {
    const principal = await principalOf(request)
    const body = await readBody(request)
    return json(200, await instance.trust(principal, requiredString(body, 'issuer'), optionalString(body, 'pinnedThumbprint') ?? null))
  }

  const listTrustedInstances = async (request: Request): Promise<Response> => json(200, (await instance.view(await principalOf(request))).trustedInstances)

  const distrustInstance = async (request: Request, params: string[]): Promise<Response> => {
    await instance.distrust(await principalOf(request), params[0]!)
    return new Response(null, { status: 204 })
  }

  const listInstanceAdmins = async (request: Request): Promise<Response> => json(200, (await instance.view(await principalOf(request))).admins)

  const setInstanceAdmin = (admin: boolean) => async (request: Request, params: string[]): Promise<Response> => {
    await instance.setAdmin(await principalOf(request), params[0]!, admin)
    return new Response(null, { status: 204 })
  }

  const adminMirrorsRoute = async (request: Request): Promise<Response> => json(200, await instance.mirrors(await principalOf(request)))

  const adminOverviewRoute = async (request: Request): Promise<Response> => json(200, await instance.overview(await principalOf(request)))

  const adminSetupRoute = async (request: Request): Promise<Response> => json(200, await instance.setup(await principalOf(request), request))

  const adminOidcRoute = async (request: Request): Promise<Response> => {
    const principal = await principalOf(request)
    const body = await readBody(request)
    const clientSecret = optionalString(body, 'clientSecret')
    const name = optionalString(body, 'name')
    return json(200, await instance.saveOidc(principal, { issuer: requiredString(body, 'issuer'), clientId: requiredString(body, 'clientId'), ...(clientSecret ? { clientSecret } : {}), ...(name ? { name } : {}) }))
  }

  const adminClearOidcRoute = async (request: Request): Promise<Response> => {
    await instance.clearOidc(await principalOf(request))
    return new Response(null, { status: 204 })
  }

  const adminUpdateRoute = async (request: Request): Promise<Response> => json(200, await instance.checkUpdate(await principalOf(request)))

  const adminApplyUpdateRoute = async (request: Request): Promise<Response> => json(200, await instance.update(await principalOf(request)))

  const adminUpdateRepositoryRoute = async (request: Request): Promise<Response> => {
    const principal = await principalOf(request)
    const body = await readBody(request)
    return json(200, { repository: await instance.setUpdateRepository(principal, { repository: requiredString(body, 'repository'), token: requiredString(body, 'token') }) })
  }

  const adminClearUpdateRepositoryRoute = async (request: Request): Promise<Response> => {
    await instance.clearUpdateRepository(await principalOf(request))
    return new Response(null, { status: 204 })
  }

  const adminRetryJobRoute = async (request: Request, params: string[]): Promise<Response> => {
    await instance.retryJob(await principalOf(request), params[0]!)
    return json(202, { queued: true })
  }

  const adminRecountRoute = async (request: Request): Promise<Response> => json(202, { repositories: await instance.recountUsage(await principalOf(request)) })

  const adminBackupRoute = async (request: Request): Promise<Response> => json(200, await instance.backup.status(await principalOf(request)))

  const runBackupRoute = async (request: Request): Promise<Response> => json(202, await instance.backup.run(await principalOf(request)))

  const verifyBackupRoute = async (request: Request): Promise<Response> => {
    const principal = await principalOf(request)
    const sample = (await readBody(request)).sample ?? 20
    if (typeof sample !== 'number' || !Number.isSafeInteger(sample) || sample < 1 || sample > 1000) throw new HttpError(400, 'sample must be an integer between 1 and 1000')
    const result = await instance.backup.verify(principal, sample)
    return json(result.failures.length === 0 ? 200 : 409, result)
  }

  const organizations = createOrganizationOperations(store, { membershipSource })

  const createScimToken = async (request: Request): Promise<Response> => {
    const actor = await requireInstanceAdmin(request)
    return json(201, await store.createScimToken(actor.id, optionalString(await readBody(request), 'name') ?? 'SCIM', { kind: 'user', id: actor.id }))
  }

  const createOrganizationRoute = async (request: Request): Promise<Response> =>
    json(201, await organizations.create(await principalOf(request), requiredString(await readBody(request), 'login')))

  const organizationRoute = async (request: Request, params: string[]): Promise<Response> => {
    const view = await organizations.view(await principalOf(request), params[0]!)
    if (!view.membership && !view.canAdminister) throw new HttpError(404, 'organization not found')
    return json(200, view)
  }

  const roleOf = async (request: Request): Promise<string> => {
    const role = (await readBody(request)).role
    return typeof role === 'string' ? role : ''
  }

  const setOrganizationMemberRoute = async (request: Request, params: string[]): Promise<Response> => {
    await organizations.setMember(await principalOf(request), params[0]!, params[1]!, await roleOf(request))
    return new Response(null, { status: 204 })
  }

  const removeOrganizationMemberRoute = async (request: Request, params: string[]): Promise<Response> => {
    await organizations.removeMember(await principalOf(request), params[0]!, params[1]!)
    return new Response(null, { status: 204 })
  }

  const createTeamRoute = async (request: Request, params: string[]): Promise<Response> => {
    const principal = await principalOf(request)
    const body = await readBody(request)
    const slug = requiredString(body, 'slug')
    await organizations.createTeam(principal, params[0]!, slug, optionalString(body, 'name') ?? '')
    return json(201, (await organizations.team(principal, params[0]!, slug)).team)
  }

  const teamRoute = async (request: Request, params: string[]): Promise<Response> => json(200, await organizations.team(await principalOf(request), params[0]!, params[1]!))

  const setTeamMemberRoute = async (request: Request, params: string[]): Promise<Response> => {
    await organizations.setTeamMember(await principalOf(request), params[0]!, params[1]!, params[2]!, await roleOf(request))
    return new Response(null, { status: 204 })
  }

  const removeTeamMemberRoute = async (request: Request, params: string[]): Promise<Response> => {
    await organizations.removeTeamMember(await principalOf(request), params[0]!, params[1]!, params[2]!)
    return new Response(null, { status: 204 })
  }

  const setTeamRepositoryRoute = async (request: Request, params: string[]): Promise<Response> => {
    await organizations.setTeamRepository(await principalOf(request), params[0]!, params[1]!, params[2]!, await roleOf(request))
    return new Response(null, { status: 204 })
  }

  const removeTeamRepositoryRoute = async (request: Request, params: string[]): Promise<Response> => {
    await organizations.removeTeamRepository(await principalOf(request), params[0]!, params[1]!, params[2]!)
    return new Response(null, { status: 204 })
  }

  const createRepositoryRoute = async (request: Request): Promise<Response> => {
    const actor = await requireManager(request)
    const body = await readBody(request)
    const created = await createRepositoryFor(actor, newRepository(body, requiredString(body, 'owner'), requiredString(body, 'name')))
    const cloneUrl = new URL(`/${created.owner}/${created.name}.git`, request.url).toString()
    return json(201, { ...created, cloneUrl })
  }

  const newRepository = (body: Body, owner: string, name: string): NewRepository => {
    const visibility = optionalString(body, 'visibility')
    const defaultBranch = optionalString(body, 'defaultBranch')
    return { owner, name, ...(visibility !== undefined ? { visibility } : {}), ...(defaultBranch !== undefined ? { defaultBranch } : {}) }
  }

  const repositoryOwners = async (actor: UserPrincipal): Promise<string[]> => {
    if (await store.isInstanceAdmin(actor.id)) return store.listAccountLogins()
    return [actor.login, ...(await store.ownedOrganizations(actor.id)).filter((login) => login.toLowerCase() !== actor.login.toLowerCase())]
  }

  const creatableOwner = async (actor: UserPrincipal, owner: string) => {
    const account = await store.findAccount(owner)
    if (!account) throw new HttpError(404, `no account ${owner}`)
    const own = account.kind === 'user' ? account.id === actor.id : await store.isOrganizationOwner(account.id, actor.id)
    if (!own && !(await store.isInstanceAdmin(actor.id))) throw new HttpError(403, `you cannot create repositories for ${owner}`)
    return account
  }

  const createRepositoryFor = async (actor: UserPrincipal, input: NewRepository): Promise<CreatedRepository> => {
    const { owner, name } = input
    const visibility = input.visibility ?? 'private'
    const defaultBranch = input.defaultBranch ?? 'main'
    if (!isValidName(owner) || !isValidName(name)) throw new HttpError(400, 'owner and name must match [A-Za-z0-9][A-Za-z0-9._-]* and must not end in .git')
    if (visibility !== 'private' && visibility !== 'public') throw new HttpError(400, 'visibility must be private or public')
    if (!BRANCH.test(defaultBranch) || defaultBranch.includes('..')) throw new HttpError(400, 'invalid defaultBranch')
    const account = await creatableOwner(actor, owner)
    const block = await store.repositoryNameBlock(account.id, name)
    if (block) throw new HttpError(409, block)
    const fresh = await store.storagePathClaimed(`${account.login}/${name}`)
    const path = { owner: account.login, name: fresh ? `${name.slice(0, 90)}.${crypto.randomUUID().slice(0, 8)}` : name }
    try {
      await createRepository(options.storage, path, defaultBranch)
    } catch (error) {
      if (!(error instanceof RepositoryExistsError) || fresh) throw error
    }
    try {
      await store.createRepository({ ownerId: account.id, name, visibility, storagePath: `${path.owner}/${path.name}` }, { kind: 'user', id: actor.id })
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

  const importRepositoryFor = async (actor: UserPrincipal, input: NewImport): Promise<StartedImport> => {
    if (!options.scheduleImport) throw new HttpError(503, 'imports need a queue (IMPORTS binding)')
    const { url, lfsUrl, token, commitsPerStep } = input
    if (!isValidImportUrl(url) || (lfsUrl !== undefined && !isValidImportUrl(lfsUrl))) throw new HttpError(400, 'url and lfsUrl must be http(s) URLs without credentials; pass a token instead')
    if (input.metadata && !githubRepository(url)) throw new HttpError(400, 'importing issues, pull requests and releases needs a GitHub repository URL (https://github.com/owner/repo)')
    let target: RepositoryName
    if (await store.findRepository(input.owner, input.name)) {
      const repository = await repositoryAdmin(actor, input)
      target = { owner: repository.owner, name: repository.name }
    } else {
      const created = await createRepositoryFor(actor, input)
      target = { owner: created.owner, name: created.name }
    }
    let state: ImportState
    try {
      state = await startImport(storage, target, {
        url,
        ...(input.lfs !== undefined ? { lfs: input.lfs } : {}),
        ...(lfsUrl ? { lfsUrl } : {}),
        ...(commitsPerStep ? { commitsPerStep } : {}),
        ...(input.metadata ? { metadata: true } : {}),
      })
    } catch (error) {
      if (error instanceof ImportRunningError) throw new HttpError(409, error.message)
      throw new HttpError(400, (error as Error).message)
    }
    await options.scheduleImport({ ...target, ...(token ? { authorization: basicAuthorization(input.username ?? 'git', token) } : {}), ...(input.metadata ? { actor: actor.id } : {}) }, 0)
    return { ...target, state }
  }

  const importStatusFor = async (actor: UserPrincipal, repo: RepositoryName): Promise<ImportState | null> => {
    const repository = await repositoryAdmin(actor, repo)
    return readImportState(storage, { owner: repository.owner, name: repository.name })
  }

  const importRepository = async (request: Request, params: string[]): Promise<Response> => {
    const repo = repoName(params)
    if (!options.scheduleImport) throw new HttpError(503, 'imports need a queue (IMPORTS binding)')
    const body = await readBody(request)
    const url = requiredString(body, 'url')
    const token = optionalString(body, 'token')
    const username = optionalString(body, 'username')
    const lfsUrl = optionalString(body, 'lfsUrl')
    const commitsPerStep = optionalCount(body, 'commitsPerStep')
    if (body.lfs !== undefined && typeof body.lfs !== 'boolean') throw new HttpError(400, 'lfs must be a boolean')
    const actor = await requireManager(request)
    if (body.metadata !== undefined && typeof body.metadata !== 'boolean') throw new HttpError(400, 'metadata must be a boolean')
    const started = await importRepositoryFor(actor, {
      ...newRepository(body, repo.owner, repo.name),
      url,
      ...(token !== undefined ? { token } : {}),
      ...(username !== undefined ? { username } : {}),
      ...(lfsUrl !== undefined ? { lfsUrl } : {}),
      ...(commitsPerStep !== undefined ? { commitsPerStep } : {}),
      ...(body.lfs !== undefined ? { lfs: body.lfs as boolean } : {}),
      ...(body.metadata === true ? { metadata: true } : {}),
    })
    const statusUrl = new URL(`/api/repos/${started.owner}/${started.name}/import`, request.url).toString()
    const cloneUrl = new URL(`/${started.owner}/${started.name}.git`, request.url).toString()
    return json(202, { ...started.state, statusUrl, cloneUrl }, { Location: statusUrl })
  }

  const importStatus = async (request: Request, params: string[]): Promise<Response> => {
    const state = await importStatusFor(await requireManager(request), repoName(params))
    if (!state) throw new HttpError(404, 'no import for this repository')
    return json(200, state)
  }

  const importMetadata = async (job: ImportJob, state: ImportState): Promise<ImportMetadataResult> => {
    const user = job.actor ? await store.findUserById(job.actor) : null
    if (!user) throw new Error('the user who started the import no longer exists')
    const principal: UserPrincipal = { kind: 'user', id: user.id, login: user.login, limits: null, tokenId: null }
    const scope = await openCollaborationRepository({ db, storage, accounts: store, now: () => now().getTime() }, principal, job.owner, job.name)
    const basic = job.authorization?.startsWith('Basic ') ? atob(job.authorization.slice(6)) : ''
    return githubImportStep(
      {
        scope,
        releases: releaseStore,
        url: state.url,
        token: basic.slice(basic.indexOf(':') + 1) || null,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.digests ? { digests: options.digests } : {}),
      },
      (state.metadata?.progress as GithubProgress | null | undefined) ?? null,
    )
  }

  const settings: RepositorySettingsOperations = {
    read: async (principal, repo) => {
      const { repository } = await adminOf(principal, repo)
      const name = { owner: repository.owner, name: repository.name }
      const mirrors = await listMirrors(storage, name)
      return {
        repository,
        collaborators: await store.listCollaborators(repository.id),
        instances: await store.listInstanceGrants(repository.id),
        mirrors: await Promise.all(mirrors.map(async (config) => ({ config, status: await readMirrorStatus(storage, name, config.remote) }))),
      }
    },
    setVisibility: async (principal, repo, visibility) => {
      const admin = await adminOf(principal, repo)
      if (visibility !== 'private' && visibility !== 'public') throw new HttpError(400, 'visibility must be private or public')
      await store.setRepositoryVisibility(admin.repository.id, visibility, { kind: 'user', id: admin.principal.id })
      return { owner: admin.repository.owner, name: admin.repository.name, visibility }
    },
    setCollaborator: async (principal, repo, login, role) => {
      const admin = await adminOf(principal, repo)
      const account = await store.findAccount(login)
      if (!account || account.kind !== 'user') throw new HttpError(404, 'user not found')
      if (!isRole(role)) throw new HttpError(400, 'role must be read, triage, write, maintain or admin')
      await store.setCollaborator(admin.repository.id, account.id, role, { kind: 'user', id: admin.principal.id })
      return { login: account.login, role }
    },
    removeCollaborator: async (principal, repo, login) => {
      const admin = await adminOf(principal, repo)
      const account = await store.findAccount(login)
      if (!account || account.kind !== 'user') throw new HttpError(404, 'user not found')
      await store.removeCollaborator(admin.repository.id, account.id, { kind: 'user', id: admin.principal.id })
    },
    grantInstance: async (principal, repo, issuerInput) => {
      const admin = await adminOf(principal, repo)
      const issuer = normalizeIssuer(issuerInput)
      if (!(await store.lookupTrustedIssuer(issuer))) throw new HttpError(422, `${issuer} is not a trusted instance; an instance admin must trust it first`)
      await store.grantInstanceRepository(issuer, admin.repository.id, { kind: 'user', id: admin.principal.id })
      return { issuer, role: 'read' }
    },
    revokeInstance: async (principal, repo, issuerInput) => {
      const admin = await adminOf(principal, repo)
      await store.revokeInstanceRepository(normalizeIssuer(issuerInput), admin.repository.id, { kind: 'user', id: admin.principal.id })
    },
    addMirror: async (principal, repo, input, token) => {
      const { repository } = await adminOf(principal, repo)
      const name = { owner: repository.owner, name: repository.name }
      try {
        if (token) await mirrorSecrets.put(name, input.remote ?? 'origin', 'token', token)
        const config = await configureMirror(storage, name, input)
        if (federation) await enqueueMirrorSetup(federation, name, config)
        return config
      } catch (error) {
        if (error instanceof MirrorExistsError) throw new HttpError(409, error.message)
        if (error instanceof HttpError) throw error
        throw new HttpError(400, (error as Error).message)
      }
    },
    syncMirror: async (principal, repo, remote, issuer) => {
      const { repository } = await adminOf(principal, repo)
      const name = { owner: repository.owner, name: repository.name }
      const config = await readMirrorConfig(storage, name, remote)
      if (!config) throw new HttpError(404, 'mirror not configured')
      try {
        return federation ? await syncAndNotify(federation, name, config) : await runMirrorSync(mirrorContext(issuer), name, config)
      } catch (error) {
        if (error instanceof MirrorAuthError) throw new HttpError(409, error.message)
        throw error
      }
    },
    verifyMirror: async (principal, repo, remote) => {
      const { repository } = await adminOf(principal, repo)
      const name = { owner: repository.owner, name: repository.name }
      if (!(await readMirrorConfig(storage, name, remote))) throw new HttpError(404, 'mirror not configured')
      return deepCheckMirror(storage, name, remote, now())
    },
    detachMirror: async (principal, repo, remote) => {
      const { repository } = await adminOf(principal, repo)
      try {
        return await detachMirror(storage, { owner: repository.owner, name: repository.name }, remote, now())
      } catch (error) {
        if (error instanceof MirrorNotFoundError) throw new HttpError(404, 'mirror not configured')
        throw error
      }
    },
    branchProtection: async (principal, repo) => {
      const { repository } = await adminOf(principal, repo)
      const rules = await store.branchProtectionRules(repository.id)
      return Promise.all(rules.map(async (rule) => ({ rule, names: await store.namedAllowances(rule) })))
    },
    setBranchProtection: async (principal, repo, pattern, body) => {
      const { repository } = await adminOf(principal, repo)
      try {
        validateBranchPattern(pattern)
        return await store.setBranchProtection(repository.id, pattern, await parseBranchProtectionSettings(body, store, repository), protectionAuditActor(principal))
      } catch (error) {
        if (error instanceof ProtectionValidationError || error instanceof BranchPatternError || error instanceof AccountsError) throw new HttpError(422, error.message)
        throw error
      }
    },
    deleteBranchProtection: async (principal, repo, pattern) => {
      const { repository } = await adminOf(principal, repo)
      return store.deleteBranchProtection(repository.id, pattern, protectionAuditActor(principal))
    },
    setMetadata: async (principal, repo, input) => {
      const admin = await adminOf(principal, repo)
      await store.setRepositoryMetadata(admin.repository.id, unprocessable(() => parseRepositoryMetadata(input)), { kind: 'user', id: admin.principal.id })
    },
    setArchived: async (principal, repo, archived) => {
      const admin = await adminOf(principal, repo)
      await store.setRepositoryArchived(admin.repository.id, archived, { kind: 'user', id: admin.principal.id })
    },
    move: async (principal, repo, target) => {
      const { principal: actor, repository } = await adminOf(principal, repo)
      const name = target.name ?? repository.name
      if (!isValidName(name)) throw new HttpError(422, 'name must match [A-Za-z0-9][A-Za-z0-9._-]* and must not end in .git')
      const account = await store.findAccount(target.owner ?? repository.owner)
      if (!account) throw new HttpError(404, `no account ${target.owner}`)
      if (account.id !== repository.ownerId && !(await repositoryOwners(actor)).some((login) => login.toLowerCase() === account.login.toLowerCase())) {
        throw new HttpError(403, `you cannot move repositories to ${account.login}`)
      }
      const block = await store.repositoryNameBlock(account.id, name, repository.id)
      if (block) throw new HttpError(409, block)
      await store.moveRepository(repository, { ownerId: account.id, owner: account.login, name }, { kind: 'user', id: actor.id })
      return { owner: account.login, name }
    },
    remove: async (principal, repo) => {
      const admin = await adminOf(principal, repo)
      await store.deleteRepository(admin.repository.id, { kind: 'user', id: admin.principal.id })
    },
  }

  const updateRepositoryWith = async (principal: Principal, repo: RepositoryName, body: Body): Promise<RepositoryName> => {
    await adminOf(principal, repo)
    const metadata = Object.fromEntries(['description', 'homepage', 'topics'].filter((key) => key in body).map((key) => [key, body[key]]))
    if (Object.keys(metadata).length > 0) await settings.setMetadata(principal, repo, metadata)
    if (body.archived !== undefined) {
      if (typeof body.archived !== 'boolean') throw new HttpError(400, 'archived must be a boolean')
      await settings.setArchived(principal, repo, body.archived)
    }
    const visibility = typeof body.private === 'boolean' ? (body.private ? 'private' : 'public') : optionalString(body, 'visibility')
    if (visibility !== undefined) await settings.setVisibility(principal, repo, visibility)
    const name = optionalString(body, 'name')
    return name !== undefined && name !== repo.name ? settings.move(principal, repo, { name }) : repo
  }

  const repositoryState = async (repo: RepositoryName) => {
    const repository = await store.findRepository(repo.owner, repo.name)
    if (!repository) throw new HttpError(404, 'repository not found')
    const { owner, name, visibility, description, homepage, topics, archived } = repository
    return { owner, name, visibility, description, homepage, topics, archived }
  }

  const renameAccount = async (principal: Principal, login: string, newLogin: string): Promise<{ readonly id: string; readonly login: string }> => {
    if (principal.kind !== 'user') throw new HttpError(401, 'authentication required', { 'WWW-Authenticate': 'Bearer' })
    if (!canManage(principal)) throw new HttpError(403, 'this needs a personal access token with the repo:admin scope')
    const account = await store.findAccount(login)
    if (!account) throw new HttpError(404, 'account not found')
    if (account.kind === 'organization' && membershipSource === 'idp') throw new HttpError(409, 'organization names come from the identity provider on this instance')
    const allowed = account.kind === 'user' ? account.id === principal.id : await store.isOrganizationOwner(account.id, principal.id)
    if (!allowed && !(await store.isInstanceAdmin(principal.id))) throw new HttpError(403, `you cannot rename ${account.login}`)
    if (!LOGIN_PATTERN.test(newLogin)) throw new HttpError(422, 'a login has letters, digits and single hyphens (at most 39 characters)')
    if (isReservedLogin(newLogin)) throw new HttpError(422, `${newLogin} is reserved`)
    const taken = await store.findAccount(newLogin)
    if (taken && taken.id !== account.id) throw new HttpError(409, `${newLogin} already exists`)
    if (await store.loginMoveBlock(newLogin)) throw new HttpError(409, `${newLogin} was renamed a moment ago; try again in a few minutes`)
    await store.renameAccount(account.id, newLogin, { kind: 'user', id: principal.id })
    return { id: account.id, login: newLogin }
  }

  const redirect = async (request: Request, principal: Principal): Promise<string | null> => {
    const url = new URL(request.url)
    const repo = REPOSITORY_URL.exec(url.pathname)
    if (repo && isValidName(repo[2]!) && isValidName(repo[3]!)) {
      const target = await store.repositoryRedirect(repo[2]!, repo[3]!)
      if (target && (await repositoryAccess(principal, target, 'read')).decision === 'allow') {
        return new URL(`${repo[1] ?? ''}/${target.owner}/${target.name}${repo[4] ?? ''}${repo[5] ?? ''}${url.search}`, url).toString()
      }
    }
    const account = /^\/([^/]+)$/.exec(url.pathname)
    const login = account && isValidName(account[1]!) ? await store.accountRedirect(account[1]!) : null
    return login ? new URL(`/${login}${url.search}`, url).toString() : null
  }

  const updateRepository = async (request: Request, params: string[]): Promise<Response> =>
    json(200, await repositoryState(await updateRepositoryWith(await principalOf(request), repoName(params), await readBody(request))))

  const transferRepository = async (request: Request, params: string[]): Promise<Response> => {
    const principal = await principalOf(request)
    const body = await readBody(request)
    const name = optionalString(body, 'name')
    return json(200, await repositoryState(await settings.move(principal, repoName(params), { owner: requiredString(body, 'owner'), ...(name ? { name } : {}) })))
  }

  const deleteRepository = async (request: Request, params: string[]): Promise<Response> => {
    await settings.remove(await principalOf(request), repoName(params))
    return new Response(null, { status: 204 })
  }

  const renameAccountRoute = async (request: Request, params: string[]): Promise<Response> =>
    json(200, await renameAccount(await principalOf(request), params[0]!, requiredString(await readBody(request), 'login')))

  const v3Repository = async (request: Request, repo: RepositoryName, status = 200): Promise<Response> => {
    const headers = Object.fromEntries(['authorization', 'cookie'].flatMap((name) => (request.headers.has(name) ? [[name, request.headers.get(name)!]] : [])))
    const response = await handle(new Request(new URL(`/api/v3/repos/${repo.owner}/${repo.name}`, request.url), { headers }))
    return new Response(response.body, { status: response.ok ? status : response.status, headers: response.headers })
  }

  const v3Update = async (request: Request, params: string[]): Promise<Response> =>
    v3Repository(request, await updateRepositoryWith(await principalOf(request), repoName(params), await readBody(request)))

  const v3Transfer = async (request: Request, params: string[]): Promise<Response> => {
    const body = await readBody(request)
    const name = optionalString(body, 'new_name')
    return v3Repository(request, await settings.move(await principalOf(request), repoName(params), { owner: requiredString(body, 'new_owner'), ...(name ? { name } : {}) }), 202)
  }

  const v3Topics = async (request: Request, params: string[]): Promise<Response> => {
    const repo = repoName(params)
    const principal = await principalOf(request)
    if (request.method === 'PUT') await settings.setMetadata(principal, repo, { topics: (await readBody(request)).names })
    const check = await repositoryAccess(principal, repo, 'read')
    if (check.decision !== 'allow' || !check.repository) throw new HttpError(404, 'Not Found')
    return json(200, { names: check.repository.topics })
  }

  const visibilitySubject = async (audience: unknown, subject: string | undefined): Promise<string | null> => {
    if (audience === 'public') return null
    if (!subject) throw new HttpError(422, 'subject is required')
    if (audience === 'instance') return normalizeIssuer(subject)
    const [login = '', slug] = subject.split('/')
    const account = await store.findAccount(login)
    const id = audience === 'user' ? (account?.kind === 'user' ? account.id : null) : account && slug ? ((await store.findTeam(account.id, slug))?.id ?? null) : null
    if (!id) throw new HttpError(422, `unknown ${String(audience)} ${subject}`)
    return id
  }

  const listVisibilityRules = async (request: Request, params: string[]): Promise<Response> =>
    json(200, await store.listVisibilityRules((await requireRepositoryAdmin(request, repoName(params))).repository.id))

  const addVisibilityRule = async (request: Request, params: string[]): Promise<Response> => {
    const { principal, repository } = await requireRepositoryAdmin(request, repoName(params))
    const body = await readBody(request)
    const audience = body.audience as VisibilityAudience
    const subject = await visibilitySubject(audience, optionalString(body, 'subject'))
    return json(201, await store.addVisibilityRule(repository.id, { refs: requiredString(body, 'refs'), path: optionalString(body, 'path') ?? null, audience, subject }, { kind: 'user', id: principal.id }))
  }

  const removeVisibilityRule = async (request: Request, params: string[]): Promise<Response> => {
    const { principal, repository } = await requireRepositoryAdmin(request, repoName(params))
    if (!(await store.removeVisibilityRule(repository.id, params[2]!, { kind: 'user', id: principal.id }))) throw new HttpError(404, 'no such rule')
    return new Response(null, { status: 204 })
  }

  const setCollaborator = async (request: Request, params: string[]): Promise<Response> => {
    const principal = await principalOf(request)
    const repo = repoName(params)
    await adminOf(principal, repo)
    const role = (await readBody(request)).role
    return json(200, await settings.setCollaborator(principal, repo, params[2]!, typeof role === 'string' ? role : ''))
  }

  const grantInstance = async (request: Request, params: string[]): Promise<Response> => {
    const principal = await principalOf(request)
    const repo = repoName(params)
    await adminOf(principal, repo)
    return json(200, await settings.grantInstance(principal, repo, requiredString(await readBody(request), 'issuer')))
  }

  const listMirrorsRoute = async (request: Request, params: string[]): Promise<Response> =>
    json(200, (await settings.read(await principalOf(request), repoName(params))).mirrors)

  const mirrorOverviewRoute = async (request: Request, params: string[]): Promise<Response> => {
    const repo = repoName(params)
    const check = await repositoryAccess(await principalOf(request), repo, 'read')
    if (!check.repository || check.decision !== 'allow') {
      const [status, message] = DECISION_STATUS[check.decision === 'allow' ? 'not-found' : check.decision]
      throw new HttpError(status, message)
    }
    const subject = { owner: check.repository.owner, name: check.repository.name }
    const at = now()
    const readOf = (issuer: string) => instanceRead({ kind: 'instance', issuer, repositories: [`${subject.owner}/${subject.name}`.toLowerCase()], scopes: ['git:read'], tokenId: '' }, subject)
    const overview = await mirrorOverview({ storage, verification, subscribers: store.mirrorSubscriptions, readOf, now: at }, subject)
    if (!overview) throw new HttpError(404, 'repository not found')
    const signed = options.instanceKey && options.publicUrl ? await signOverview(options.instanceKey, options.publicUrl, overview, at) : null
    return json(200, { ...overview, ...(signed ? { signed } : {}) })
  }

  const addMirror = async (request: Request, params: string[]): Promise<Response> => {
    const principal = await principalOf(request)
    const repo = repoName(params)
    await adminOf(principal, repo)
    const body = await readBody(request)
    const mode = optionalString(body, 'mode')
    const auth = optionalString(body, 'auth')
    if (mode !== undefined && mode !== 'auto' && mode !== 'manual') throw new HttpError(400, 'mode must be auto or manual')
    if (auth !== undefined && auth !== 'none' && auth !== 'instance' && auth !== 'token') throw new HttpError(400, 'auth must be none, instance or token')
    const token = optionalString(body, 'token')
    if ((auth === 'token') !== (token !== undefined && token !== '')) throw new HttpError(400, 'auth token needs a token and a token needs auth token')
    if (token && !mirrorSecrets.available) throw new HttpError(503, new MirrorSecretsUnavailableError().message)
    if (body.lfs !== undefined && typeof body.lfs !== 'boolean') throw new HttpError(400, 'lfs must be a boolean')
    const remote = optionalString(body, 'remote')
    const namespace = optionalString(body, 'namespace')
    const lfsUrl = optionalString(body, 'lfsUrl')
    const config = await settings.addMirror(principal, repo, {
      url: requiredString(body, 'url'),
      ...(remote !== undefined ? { remote } : {}),
      ...(mode !== undefined ? { mode } : {}),
      ...(namespace !== undefined ? { namespace } : {}),
      ...(body.lfs !== undefined ? { lfs: body.lfs as boolean } : {}),
      ...(lfsUrl !== undefined ? { lfsUrl } : {}),
      ...(auth !== undefined ? { auth } : {}),
    }, token)
    return json(201, config)
  }

  const syncMirrorRoute = async (request: Request, params: string[]): Promise<Response> => {
    const result = await settings.syncMirror(await principalOf(request), repoName(params), params[2]!, issuerFor(request))
    return json(result.status === 'failed' ? 502 : 200, result)
  }

  const verifyMirrorRoute = async (request: Request, params: string[]): Promise<Response> =>
    json(200, await settings.verifyMirror(await principalOf(request), repoName(params), params[2]!))

  const detachMirrorRoute = async (request: Request, params: string[]): Promise<Response> =>
    json(200, await settings.detachMirror(await principalOf(request), repoName(params), params[2]!))

  const optionalBoolean = (body: Body, key: string, fallback: boolean): boolean => {
    const value = body[key]
    if (value === undefined || value === null) return fallback
    if (typeof value !== 'boolean') throw new HttpError(400, `${key} must be a boolean`)
    return value
  }

  const githubFetch = options.fetch ? { fetch: options.fetch } : {}

  const mirrorWebhookRoute = async (request: Request, params: string[]): Promise<Response> => {
    const repository = await store.findRepository(...(params as [string, string]))
    if (!repository || !isValidName(params[2]!)) throw new HttpError(404, 'mirror not configured')
    return receiveGitHubWebhook({ storage, secrets: mirrorSecrets, federation }, request, { owner: repository.owner, name: repository.name }, params[2]!)
  }

  const webhookFor = async (repo: RepositoryName, remote: string, base: string, githubToken: string | undefined) => {
    try {
      return await setUpGitHubWebhook({ storage, secrets: mirrorSecrets, ...githubFetch }, repo, remote, base, githubToken)
    } catch (error) {
      if (error instanceof MirrorSecretsUnavailableError) throw new HttpError(503, error.message)
      if (error instanceof GitHubApiError) throw new HttpError(502, error.message)
      throw error
    }
  }

  const setUpMirrorWebhookRoute = async (request: Request, params: string[]): Promise<Response> => {
    const { repository } = await requireRepositoryAdmin(request, repoName(params))
    const repo = { owner: repository.owner, name: repository.name }
    if (!(await readMirrorConfig(storage, repo, params[2]!))) throw new HttpError(404, 'mirror not configured')
    const githubToken = optionalString(await readBody(request), 'githubToken')
    return json(200, await webhookFor(repo, params[2]!, issuerFor(request), githubToken || undefined))
  }

  const githubJobContext = (job: Pick<GitHubMirrorJob, 'owner' | 'name'>) => ['git-forge-mirror-github-job', job.owner.toLowerCase(), job.name.toLowerCase()]

  const mirrorGitHubFor = async (actor: UserPrincipal, input: GitHubBackup): Promise<GitHubBackupResult> => {
    const owner = (await creatableOwner(actor, input.owner)).login
    const { account, token } = input
    const visibility = input.visibility ?? 'private'
    const mode = input.mode ?? 'auto'
    const webhook = input.webhook ?? false
    if (!account) throw new HttpError(400, 'account is required')
    if (visibility !== 'private' && visibility !== 'public' && visibility !== 'upstream') throw new HttpError(400, 'visibility must be private, public or upstream')
    if (mode !== 'auto' && mode !== 'manual') throw new HttpError(400, 'mode must be auto or manual')
    if (webhook && !token) throw new HttpError(400, 'webhook needs a token with admin:repo_hook')
    if (!options.jobs) throw new HttpError(503, 'bulk mirroring needs a job queue')
    if (token && !mirrorSecrets.available) throw new HttpError(503, new MirrorSecretsUnavailableError().message)
    let listed
    try {
      listed = await listGitHubRepositories({ account, ...(token ? { token } : {}), ...githubFetch, forks: input.forks ?? false, archived: input.archived ?? true })
    } catch (error) {
      if (error instanceof GitHubApiError) throw new HttpError(502, error.message)
      throw error
    }
    const queued: GitHubBackupResult['queued'][number][] = []
    const skipped: GitHubBackupResult['skipped'][number][] = []
    for (const upstream of listed) {
      const repository = `${owner}/${upstream.name}`
      if (!isValidName(upstream.name)) skipped.push({ github: upstream.fullName, repository, reason: 'invalid name' })
      else if (upstream.private && !token) skipped.push({ github: upstream.fullName, repository, reason: 'private' })
      else if (await store.findRepository(owner, upstream.name)) skipped.push({ github: upstream.fullName, repository, reason: 'exists' })
      else {
        const target = { owner, name: upstream.name }
        await options.jobs.enqueue({
          kind: 'mirror-github',
          ...target,
          url: upstream.cloneUrl,
          visibility: visibility === 'upstream' ? (upstream.private ? 'private' : 'public') : visibility,
          defaultBranch: upstream.defaultBranch,
          actor: { id: actor.id, login: actor.login },
          mode,
          lfs: input.lfs ?? true,
          private: upstream.private,
          webhook,
          ...(token && (upstream.private || webhook) ? { sealedToken: await mirrorSecrets.seal(githubJobContext(target), token) } : {}),
        })
        queued.push({ github: upstream.fullName, repository })
      }
    }
    return { owner, account, queued, skipped }
  }

  const mirrorGitHubRoute = async (request: Request): Promise<Response> => {
    const actor = await requireManager(request)
    const body = await readBody(request)
    const optional = (key: string) => {
      const value = optionalString(body, key)
      return value ? { [key]: value } : {}
    }
    const flags = Object.fromEntries(['forks', 'archived', 'webhook', 'lfs'].filter((key) => body[key] !== undefined && body[key] !== null).map((key) => [key, optionalBoolean(body, key, false)]))
    const result = await mirrorGitHubFor(actor, { account: requiredString(body, 'account'), owner: requiredString(body, 'owner'), ...optional('token'), ...optional('visibility'), ...optional('mode'), ...flags })
    return json(202, result)
  }

  const adoptGitHubRepository = async (job: GitHubMirrorJob): Promise<void> => {
    const actor: UserPrincipal = { kind: 'user', id: job.actor.id, login: job.actor.login, limits: null, tokenId: null }
    const token = job.sealedToken ? await mirrorSecrets.open(githubJobContext(job), job.sealedToken) : undefined
    let existing = await store.findRepository(job.owner, job.name)
    if (!existing) {
      try {
        await createRepositoryFor(actor, { owner: job.owner, name: job.name, visibility: job.visibility, defaultBranch: job.defaultBranch })
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 409) throw error instanceof HttpError ? new PermanentJobError(error.message) : error
      }
      existing = await store.findRepository(job.owner, job.name)
      if (!existing) throw new Error(`${job.owner}/${job.name} was not created`)
    }
    const repo = { owner: existing.owner, name: existing.name }
    let config = await readMirrorConfig(storage, repo, 'origin')
    if (!config) {
      const refs = await readRefs(storage, repo)
      if (refs && Object.keys(refs.state.refs).length > 0) return
      if (job.private && token) await mirrorSecrets.put(repo, 'origin', 'token', token)
      try {
        config = await configureMirror(storage, repo, { url: job.url, mode: job.mode, lfs: job.lfs, ...(job.private && token ? { auth: 'token' as const } : {}) }, now())
      } catch (error) {
        if (!(error instanceof MirrorExistsError)) throw error
        config = await readMirrorConfig(storage, repo, 'origin')
      }
    }
    if (!config || config.url !== job.url) return
    if (job.webhook && token && options.publicUrl) await setUpGitHubWebhook({ storage, secrets: mirrorSecrets, ...githubFetch }, repo, 'origin', options.publicUrl, token)
    if (federation) await enqueueMirrorSetup(federation, repo, config)
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

  const dispatchOptions = (request: Request): DispatchOptions => dispatchOptionsFor(issuerFor(request))

  const dispatchOptionsFor = (serverUrl: string): DispatchOptions => {
    return {
      db,
      storage,
      urls: { serverUrl, serviceUrl: `${serverUrl}${ACTIONS_SERVICE_PATH}` },
      checks: checkRuns,
      ...(options.actions?.launcher ? { launcher: options.actions.launcher } : {}),
      ...(options.actions?.cacheLimits ? { cacheLimits: options.actions.cacheLimits } : {}),
      onJobEvent: jobEvents(serverUrl),
      now: () => now().getTime(),
      log: (event) => console.log(JSON.stringify(event)),
    }
  }

  const jobEvents =
    (serverUrl: string): JobEventSink =>
    async (action, job) => {
      const run = await getRun(db, job.run_id)
      if (!run) return
      const runner = job.runner_id === null ? null : await getRunnerIncludingRemoved(db, job.runner_id)
      const context = { baseUrl: serverUrl, repository: { owner: run.owner, name: run.repo }, actor: { kind: 'user' as const, id: null, login: run.actor } }
      await emit(workflowJobEvent(context, workflowJobPayload(action, job, run, serverUrl, runner?.name.replace(/\/removed\/\d+$/, '') ?? null)))
    }

  const isOrganizationAdmin = async (request: Request, org: string): Promise<boolean> => {
    const principal = await principalOf(request)
    if (principal.kind !== 'user' || !canManage(principal)) return false
    const account = await store.findAccount(org)
    return account?.kind === 'organization' && ((await store.isOrganizationOwner(account.id, principal.id)) || (await store.isInstanceAdmin(principal.id)))
  }

  const repositoryFacts = async (owner: string, name: string) => {
    const repository = await store.findRepository(owner, name)
    return repository ? { id: repository.id, ownerId: repository.ownerId, visibility: repository.visibility } : null
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
    return principal !== null && (await canWriteActions(principal, { owner, name }))
  }

  const canWriteActions = async (principal: Principal, repo: RepositoryName): Promise<boolean> => (await repositoryAccess(principal, repo, 'write')).decision === 'allow'

  const runOf = async (repository: RepositoryName, id: number): Promise<RunRow | null> => {
    const run = await getRun(db, id)
    return run && run.owner.toLowerCase() === repository.owner.toLowerCase() && run.repo.toLowerCase() === repository.name.toLowerCase() ? run : null
  }

  const writableRunOf = async (principal: Principal, repository: RepositoryName, id: number): Promise<RunRow> => {
    if ((await repositoryAccess(principal, repository, 'read')).decision !== 'allow') throw new HttpError(404, 'repository not found')
    const run = await runOf(repository, id)
    if (!run) throw new HttpError(404, 'run not found')
    if (!(await canWriteActions(principal, repository))) throw new HttpError(403, 'write access is required')
    return run
  }

  const actions: ActionsOperations = {
    runs: (repository, limit, workflowPath = null) => listRuns(db, repository.owner, repository.name, limit, workflowPath),
    workflows: (repository) => listRunWorkflows(db, repository.owner, repository.name),
    run: async (repository, id) => {
      const run = await runOf(repository, id)
      return run ? { run, jobs: await listCurrentJobs(db, run.id) } : null
    },
    log: async (repository, runId, jobId) => {
      const run = await runOf(repository, runId)
      if (!run) return null
      const job = (await listRunJobs(db, run.id)).find((candidate) => candidate.id === jobId)
      return job ? { job, log: await readJobLog(db, storage, run, job) } : null
    },
    canWrite: canWriteActions,
    cancel: async (principal, repository, runId, issuer) => {
      const run = await writableRunOf(principal, repository, runId)
      if (!(await cancelRun(dispatchOptionsFor(issuer), run.id))) throw new HttpError(409, 'the run has already completed')
    },
    rerun: async (principal, repository, runId, choice, issuer) => {
      const run = await writableRunOf(principal, repository, runId)
      let mode: Parameters<typeof rerunRun>[2] = choice.kind === 'all' ? { kind: 'all' } : { kind: 'failed' }
      if (choice.kind === 'job') {
        const job = (await listRunJobs(db, run.id)).find((candidate) => candidate.id === choice.jobId)
        if (!job) throw new HttpError(404, 'job not found')
        mode = { kind: 'job', requestId: job.request_id }
      }
      try {
        return await rerunRun(dispatchOptionsFor(issuer), run.id, mode)
      } catch (error) {
        if (error instanceof RerunError) throw new HttpError(409, error.message)
        throw error
      }
    },
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
    if (!actions || !(pathname.startsWith(`${ACTIONS_SERVICE_PATH}/`) || pathname === '/api/v3' || pathname.startsWith('/api/v3/') || isResultsServicePath(pathname))) return null
    const dispatch = dispatchOptions(request)
    return (
      (await handleResultsService(request, {
        db,
        storage,
        serverUrl: dispatch.urls.serverUrl,
        ...(actions.idTokenKeys ? { idTokenKeys: actions.idTokenKeys } : {}),
        repositoryFacts,
        ...(actions.cacheLimits ? { cacheLimits: actions.cacheLimits } : {}),
        ...(actions.artifactRetentionDays ? { artifactRetentionDays: actions.artifactRetentionDays } : {}),
        now: () => now().getTime(),
      })) ??
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
        onJobEvent: jobEvents(dispatch.urls.serverUrl),
        results: { idTokens: (actions.idTokenKeys?.length ?? 0) > 0, ...(actions.artifactRetentionDays ? { artifactRetentionDays: actions.artifactRetentionDays } : {}) },
      })) ??
      (await handleGhesApi(request, {
        db,
        storage,
        urls: dispatch.urls,
        authorize: isRepositoryAdmin,
        authorizeRead: (incoming, owner, name) => hasRepositoryAccess(incoming, owner, name, 'read'),
        authorizeWrite: (incoming, owner, name) => hasRepositoryAccess(incoming, owner, name, 'write'),
        authorizeOrganization: isOrganizationAdmin,
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
      const active = await readActiveSession(request, (await loginOptions(request)))
      const check = active ? await repositoryAccess(sessionUserPrincipal(active.session), repo, 'read') : null
      if (check?.decision === 'allow') return null
      if (check?.view) return check.view
    }
    return authorize(request, repo, access, ...rest)
  }

  const withSessionLfs = (authorize: Authorize): Authorize => async (request, repo, access, surface) => {
    if (surface === 'lfs' && !request.headers.has('Authorization')) {
      const check = await checkSession(request, await loginOptions(request))
      const result = check.kind === 'session' ? await repositoryAccess(sessionUserPrincipal(check.active.session), repo, access === 'write' ? 'write' : 'read') : null
      if (result?.decision === 'allow') return null
    }
    return authorize(request, repo, access, surface)
  }

  const emitRunEvents = async (serverUrl: string, job: JobRow): Promise<void> => {
    const run = await getRun(db, job.run_id)
    if (!run) return
    const context = { baseUrl: serverUrl, repository: { owner: run.owner, name: run.repo }, actor: { kind: 'user' as const, id: null, login: run.actor } }
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
    if (outcome.results.some((result) => result.ok)) await refreshRepository(repo)
    if (federation) await notifyAfterPush(federation)(repo, outcome)
    if (outcome.results.some((result) => result.ok)) {
      await recordChecksums(verification, storage, repo).catch((error: unknown) =>
        console.error(JSON.stringify({ event: 'ref-checksum-failed', repository: `${repo.owner}/${repo.name}`, error: String(error) })),
      )
    }
    const published = Promise.all([pages.onPush(repo, outcome, principal), publishAfterPush(repo, outcome)]).catch((error: unknown) =>
      console.error(JSON.stringify({ event: 'pages-or-publish-failed', repository: `${repo.owner}/${repo.name}`, error: String(error) })),
    )
    if (waitUntil && !options.jobs) waitUntil(published)
    else await published
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
    lfs: { maxObjectBytes: options.maxLfsObjectBytes, onStored: storedObject, ...(options.digests ? { digests: options.digests } : {}) },
    onBranchUpdated: async (update: BranchUpdate) => {
      const outcome: PushOutcome = { unpack: 'ok', results: [{ name: update.ref, oldId: update.oldId, newId: update.newId, ok: true }], pack: null, objectCount: 0, archived: [] }
      const user = update.actor.kind === 'user' ? await store.findUserById(update.actor.id) : null
      const principal: Principal | null = user ? { kind: 'user', id: user.id, login: user.login, limits: null, tokenId: null } : request.bodyUsed ? null : await apiPrincipal(request)
      await afterPush(request, update.repo, outcome, waitUntil, principal)
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
            head: { ref: pull.headRef, sha: pull.headSha, repo: pull.headRepository ? { owner: pull.headRepository.owner, name: pull.headRepository.name } : scope.repo },
            trusted: pull.headRepository === null,
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

  const urlsOf = (request: Request) => {
    const web = options.publicUrl ?? new URL(request.url).origin
    return { web, api: `${web}/api/v3` }
  }

  const listRepositoriesRoute = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const owner = url.searchParams.get('owner')
    const page = await listRepositories(await principalOf(request), {
      sort: url.searchParams.get('sort') === 'name' ? 'name' : 'updated',
      page: Number(url.searchParams.get('page') ?? '1'),
      perPage: Number(url.searchParams.get('per_page') ?? '30'),
      ...(owner ? { owner } : {}),
    })
    return json(200, { total_count: page.total, items: page.items.map((repo) => repositoryJson(urlsOf(request), repo)) })
  }

  const searchRoute = async (request: Request, params: string[]): Promise<Response> => {
    const parsed = parseSearchRequest(new URL(request.url))
    const results = await runSearch(db, await principalOf(request), { ...parsed, type: (params[0] as SearchType | undefined) ?? parsed.type })
    return json(200, await searchResponseJson(db, urlsOf(request), results))
  }

  const rebuildSearchRoute = async (request: Request): Promise<Response> => {
    await requireInstanceAdmin(request)
    await db.batch(SEARCH_INDEX_REBUILD)
    return new Response(null, { status: 204 })
  }

  const SEGMENT = '([^/]+)'
  const REPO = `/api/repos/${SEGMENT}/${SEGMENT}`
  const routes: Route[] = [
    { method: 'GET', pattern: /^\/$/, handler: health },
    { method: 'GET', pattern: /^\/api\/health$/, handler: health },
    { method: 'POST', pattern: /^\/api\/bootstrap$/, handler: bootstrap },
    { method: 'POST', pattern: /^\/api\/admin\/users$/, handler: createUser },
    { method: 'POST', pattern: new RegExp(`^/api/admin/users/${SEGMENT}/tokens$`), handler: createToken },
    { method: 'GET', pattern: /^\/api\/admin\/instances$/, handler: listTrustedInstances },
    { method: 'POST', pattern: /^\/api\/admin\/instances$/, handler: trustInstance },
    { method: 'DELETE', pattern: new RegExp(`^/api/admin/instances/${SEGMENT}$`), handler: distrustInstance },
    { method: 'GET', pattern: /^\/api\/admin\/admins$/, handler: listInstanceAdmins },
    { method: 'PUT', pattern: new RegExp(`^/api/admin/admins/${SEGMENT}$`), handler: setInstanceAdmin(true) },
    { method: 'DELETE', pattern: new RegExp(`^/api/admin/admins/${SEGMENT}$`), handler: setInstanceAdmin(false) },
    { method: 'GET', pattern: /^\/api\/admin\/mirrors$/, handler: adminMirrorsRoute },
    { method: 'GET', pattern: /^\/api\/admin\/overview$/, handler: adminOverviewRoute },
    { method: 'GET', pattern: /^\/api\/admin\/setup$/, handler: adminSetupRoute },
    { method: 'PUT', pattern: /^\/api\/admin\/oidc$/, handler: adminOidcRoute },
    { method: 'DELETE', pattern: /^\/api\/admin\/oidc$/, handler: adminClearOidcRoute },
    { method: 'GET', pattern: /^\/api\/admin\/update$/, handler: adminUpdateRoute },
    { method: 'POST', pattern: /^\/api\/admin\/update$/, handler: adminApplyUpdateRoute },
    { method: 'PUT', pattern: /^\/api\/admin\/update\/repository$/, handler: adminUpdateRepositoryRoute },
    { method: 'DELETE', pattern: /^\/api\/admin\/update\/repository$/, handler: adminClearUpdateRepositoryRoute },
    { method: 'POST', pattern: new RegExp(`^/api/admin/jobs/${SEGMENT}/retry$`), handler: adminRetryJobRoute },
    { method: 'POST', pattern: /^\/api\/admin\/usage\/recount$/, handler: adminRecountRoute },
    { method: 'GET', pattern: /^\/api\/admin\/backup$/, handler: adminBackupRoute },
    { method: 'POST', pattern: /^\/api\/admin\/backup$/, handler: runBackupRoute },
    { method: 'POST', pattern: /^\/api\/admin\/backup\/verify$/, handler: verifyBackupRoute },
    { method: 'POST', pattern: /^\/api\/admin\/invites$/, handler: createInvite },
    { method: 'POST', pattern: /^\/api\/admin\/scim\/tokens$/, handler: createScimToken },
    { method: 'POST', pattern: /^\/api\/admin\/email\/test$/, handler: sendTestEmailRoute },
    { method: 'GET', pattern: /^\/api\/user$/, handler: currentUser },
    { method: 'POST', pattern: /^\/api\/orgs$/, handler: createOrganizationRoute },
    { method: 'GET', pattern: new RegExp(`^/api/orgs/${SEGMENT}$`), handler: organizationRoute },
    { method: 'PUT', pattern: new RegExp(`^/api/orgs/${SEGMENT}/members/${SEGMENT}$`), handler: setOrganizationMemberRoute },
    { method: 'DELETE', pattern: new RegExp(`^/api/orgs/${SEGMENT}/members/${SEGMENT}$`), handler: removeOrganizationMemberRoute },
    { method: 'POST', pattern: new RegExp(`^/api/orgs/${SEGMENT}/teams$`), handler: createTeamRoute },
    { method: 'GET', pattern: new RegExp(`^/api/orgs/${SEGMENT}/teams/${SEGMENT}$`), handler: teamRoute },
    { method: 'PUT', pattern: new RegExp(`^/api/orgs/${SEGMENT}/teams/${SEGMENT}/members/${SEGMENT}$`), handler: setTeamMemberRoute },
    { method: 'DELETE', pattern: new RegExp(`^/api/orgs/${SEGMENT}/teams/${SEGMENT}/members/${SEGMENT}$`), handler: removeTeamMemberRoute },
    { method: 'PUT', pattern: new RegExp(`^/api/orgs/${SEGMENT}/teams/${SEGMENT}/repos/${SEGMENT}$`), handler: setTeamRepositoryRoute },
    { method: 'DELETE', pattern: new RegExp(`^/api/orgs/${SEGMENT}/teams/${SEGMENT}/repos/${SEGMENT}$`), handler: removeTeamRepositoryRoute },
    { method: 'POST', pattern: /^\/api\/repos$/, handler: createRepositoryRoute },
    { method: 'GET', pattern: /^\/api\/repos$/, handler: listRepositoriesRoute },
    { method: 'GET', pattern: /^\/api\/search$/, handler: searchRoute },
    { method: 'GET', pattern: /^\/api\/v3\/search\/(repositories|issues|users)$/, handler: searchRoute },
    { method: 'POST', pattern: /^\/api\/admin\/search\/rebuild$/, handler: rebuildSearchRoute },
    { method: 'PATCH', pattern: new RegExp(`^${REPO}$`), handler: updateRepository },
    { method: 'DELETE', pattern: new RegExp(`^${REPO}$`), handler: deleteRepository },
    { method: 'POST', pattern: new RegExp(`^${REPO}/transfer$`), handler: transferRepository },
    { method: 'PATCH', pattern: new RegExp(`^/api/accounts/${SEGMENT}$`), handler: renameAccountRoute },
    { method: 'PUT', pattern: new RegExp(`^${REPO}/collaborators/${SEGMENT}$`), handler: setCollaborator },
    { method: 'GET', pattern: new RegExp(`^${REPO}/visibility$`), handler: listVisibilityRules },
    { method: 'POST', pattern: new RegExp(`^${REPO}/visibility$`), handler: addVisibilityRule },
    { method: 'DELETE', pattern: new RegExp(`^${REPO}/visibility/${SEGMENT}$`), handler: removeVisibilityRule },
    { method: 'POST', pattern: new RegExp(`^${REPO}/instances$`), handler: grantInstance },
    { method: 'POST', pattern: new RegExp(`^${REPO}/import$`), handler: importRepository },
    { method: 'GET', pattern: new RegExp(`^${REPO}/import$`), handler: importStatus },
    { method: 'GET', pattern: new RegExp(`^${REPO}/mirrors$`), handler: listMirrorsRoute },
    { method: 'GET', pattern: new RegExp(`^${REPO}/mirrors/overview$`), handler: mirrorOverviewRoute },
    { method: 'POST', pattern: new RegExp(`^${REPO}/mirrors$`), handler: addMirror },
    { method: 'POST', pattern: new RegExp(`^${REPO}/mirrors/${SEGMENT}/sync$`), handler: syncMirrorRoute },
    { method: 'POST', pattern: new RegExp(`^${REPO}/mirrors/${SEGMENT}/detach$`), handler: detachMirrorRoute },
    { method: 'POST', pattern: new RegExp(`^${REPO}/mirrors/${SEGMENT}/verify$`), handler: verifyMirrorRoute },
    { method: 'POST', pattern: new RegExp(`^${REPO}/mirrors/${SEGMENT}/webhook$`), handler: mirrorWebhookRoute },
    { method: 'PUT', pattern: new RegExp(`^${REPO}/mirrors/${SEGMENT}/webhook$`), handler: setUpMirrorWebhookRoute },
    { method: 'POST', pattern: /^\/api\/mirrors\/github$/, handler: mirrorGitHubRoute },
    { method: 'POST', pattern: new RegExp(`^${REPO}/lfs/publish$`), handler: publishRepositoryLfs },
  ]

  const V3 = `/api/v3/repos/${SEGMENT}/${SEGMENT}`
  const v3Routes: Route[] = [
    { method: 'PATCH', pattern: new RegExp(`^${V3}$`), handler: v3Update },
    { method: 'DELETE', pattern: new RegExp(`^${V3}$`), handler: deleteRepository },
    { method: 'POST', pattern: new RegExp(`^${V3}/transfer$`), handler: v3Transfer },
    { method: 'GET', pattern: new RegExp(`^${V3}/topics$`), handler: v3Topics },
    { method: 'PUT', pattern: new RegExp(`^${V3}/topics$`), handler: v3Topics },
  ]

  const v3Route = async (request: Request): Promise<Response | null> => {
    const { pathname } = new URL(request.url)
    const match = v3Routes.find((candidate) => candidate.method === request.method && candidate.pattern.test(pathname))
    if (!match) return null
    try {
      return await match.handler(request, match.pattern.exec(pathname)!.slice(1).map(decodeURIComponent))
    } catch (error) {
      if (error instanceof HttpError) return json(error.status, { message: error.message }, error.headers)
      if (error instanceof AccountsError) return json(422, { message: error.message })
      throw error
    }
  }

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

  const releasesOptions = (request: Request, waitUntil?: WaitUntil): ReleasesOptions => ({
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

  const installationPermissions = async (request: Request): Promise<AppPermissions | null> => {
    const credential = parseAuthorization(request.headers.get('Authorization'))
    if (credential.kind !== 'secret' || tokenKindOf(credential.secret) !== 'app') return null
    const principal = await store.authenticateToken(credential.secret)
    return principal?.kind === 'app' && principal.permissions ? (principal.permissions as AppPermissions) : null
  }

  const lfsOperation = async (request: Request): Promise<string | null> => {
    try {
      return String(((await request.clone().json()) as { operation?: unknown }).operation ?? '')
    } catch {
      return null
    }
  }

  const installationGate = async (request: Request): Promise<Response | null> => {
    const permissions = await installationPermissions(request)
    if (!permissions) return null
    const url = new URL(request.url)
    const operation = request.method === 'POST' && isLfsBatchPath(url.pathname) ? await lfsOperation(request) : null
    const problem = missingPermission(permissions, installationNeeds(request.method, url, operation))
    if (!problem) return null
    return url.pathname.startsWith('/api/') ? json(403, { message: `Resource not accessible by integration: ${problem}` }) : new Response(`${problem}\n`, { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  }

  const handle = async (request: Request, waitUntil?: WaitUntil): Promise<Response> => {
    const gated = await installationGate(request)
    if (gated) return gated
    const site = await pages.serve(request)
    if (site) return site
    const wellKnown = options.instanceKey ? handleWellKnownRequest(request, { issuer: issuerFor(request), keys: [options.instanceKey.publicJwk] }) : null
    if (wellKnown) return wellKnown
    const federated = federation ? await handleFederationRequest(federation, request) : null
    if (federated) return federated
    const login = await createLoginHandler((await loginOptions(request)))(request)
    if (login) return login
    const scim = await createScimHandler({
      db,
      store,
      origin: new URL(issuerFor(request)).origin,
      enabled: membershipSource === 'idp',
      authenticate: store.authenticateScimToken,
      now: nowMs,
    })(request)
    if (scim) return scim
    const authentication = authenticateOptions(request)
    const archive = await handleArchiveRequest(request, { storage, authorize: withSessionReads(withJobTokens(createGitAccess(authentication).authorize)) })
    if (archive) return archive
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
    const appsResponse = await githubApps.handle(request)
    if (appsResponse) return appsResponse
    const releases = await handleReleasesRequest(request, releasesOptions(request, waitUntil))
    if (releases) return releases
    const pagesApi = await pages.api(request)
    if (pagesApi) return pagesApi
    const lifecycle = await v3Route(request)
    if (lifecycle) return lifecycle
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
      if (error instanceof OrganizationError || error instanceof InstanceAdministrationError || error instanceof AdminError) return json(error.status, { error: error.message })
      if (error instanceof AccountsError) return json(400, { error: error.message })
      throw error
    }
    const access = createGitAccess({ ...authentication, delegatedBranches: (principal, repository) => maintainerPushBranches({ db, accounts: store }, principal, repository) })
    const authorize = withJobTokens(access.authorize)
    const content = await handleContentRequest(request, { storage, authorize: withSessionReads(authorize) })
    if (content) return content
    const git = await handleGitRequest(request, {
      storage: presigningStorage,
      authorize: withSessionLfs(authorize),
      pushPolicy: access.pushPolicy,
      pushCheck: async (incoming, repo) => {
        const permissions = await installationPermissions(incoming)
        if (!restrictsWorkflows(permissions)) return null
        return repositoryWorkflowCheck(storage, repo)
      },
      ...(options.maxPushBytes !== undefined ? { maxPushBytes: options.maxPushBytes } : {}),
      lfs: {
        maxObjectBytes: options.maxLfsObjectBytes,
        oversizeHint: options.presigner ? RAISE_LIMIT_HINT : PRESIGN_HINT,
        onVerified: storedObject,
        ...(options.digests ? { digests: options.digests } : {}),
      },
      ...(options.presigner ? { uploads: { presignPut: options.presigner.presignPut.bind(options.presigner) } } : {}),
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

  const observe = async (waitUntil?: WaitUntil): Promise<void> => {
    meter.count('requests')
    const flushed = meter.flush().catch((error: unknown) => console.error(JSON.stringify({ event: 'usage-flush-failed', error: String(error) })))
    if (waitUntil) waitUntil(flushed)
    else await flushed
  }

  const runAppJob = async (job: AppJob): Promise<void> => {
    if (isNotificationJob(job)) return notifications.runJob(job)
    if (isPagesJob(job)) return pages.runJob(job)
    if (job.kind === 'lfs-publish') return publishLfs(job)
    if (job.kind === 'backup') return runBackupJob()
    if (job.kind === 'mirror-github') return adoptGitHubRepository(job)
    if (job.kind === 'usage-scan') return void (await meter.scan(options.storage, job))
    if (job.kind === 'import-lfs') return void (await importLfsObject(job, { storage, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.digests ? { digests: options.digests } : {}) }))
    if (!federation) throw new Error('jobs need PUBLIC_URL, INSTANCE_KEY and a job queue')
    await runJob(federation, job)
  }

  const authenticate = async (request: Request): Promise<Principal | null> => {
    if (!request.headers.has('Authorization')) {
      const active = await readActiveSession(request, (await loginOptions(request)))
      if (active) return sessionUserPrincipal(active.session)
    }
    const principal = await authenticateRequest(request, authenticateOptions(request))
    return principal?.kind === 'app' && principal.installationId !== undefined ? null : principal
  }

  return {
    fetch: async (request, waitUntil) => {
      try {
        const response = await handle(request, waitUntil)
        if (![401, 403, 404].includes(response.status) || pages.isPagesRequest(request)) return response
        const location = await redirect(request, (await authenticate(request)) ?? { kind: 'anonymous' })
        return location ? new Response(null, { status: request.method === 'GET' || request.method === 'HEAD' ? 301 : 307, headers: { Location: location } }) : response
      } finally {
        await observe(waitUntil)
      }
    },
    isPagesRequest: pages.isPagesRequest,
    services: {
      storage,
      store,
      authenticate,
      renameAccount,
      redirect,
      issuer: issuerFor,
      repositoryAccess,
      isInstanceAdmin: async (principal) => principal.kind === 'user' && (await store.isInstanceAdmin(principal.id)),
      session: async (request) => {
        const active = await readActiveSession(request, (await loginOptions(request)))
        return active ? { principal: sessionUserPrincipal(active.session), csrf: active.csrf, sessionId: active.session.id } : null
      },
      verifySessionWrite: async (request) => {
        const check = await checkSession(request, (await loginOptions(request)))
        return check.kind === 'session' ? { principal: sessionUserPrincipal(check.active.session), csrf: check.active.csrf, sessionId: check.active.session.id } : null
      },
      loginMethods: async () => ({ oidcName: (await oidcProvider())?.config.name ?? null, passkeys: options.login?.passkeys ?? true }),
      observe,
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
        listIdentities: (user) => store.listExternalIdentities(user.id),
        unlinkIdentity: async (user, issuer, subject) => {
          const identities = await store.listExternalIdentities(user.id)
          const passkeys = (options.login?.passkeys ?? true) ? await logins.listCredentials(user.id) : []
          if (identities.length <= 1 && passkeys.length === 0) throw new HttpError(422, 'keep at least one way to sign in')
          return store.unlinkExternalIdentity(user.id, issuer, subject, { kind: 'user', id: user.id })
        },
        listSessions: (user) => logins.listSessions(user.id),
        revokeSession: (user, id) => logins.revokeUserSession(user.id, id),
      },
      organizations,
      instance,
      listRepositories,
      search: (principal, request) => runSearch(db, principal, request),
      repositories: {
        owners: repositoryOwners,
        create: createRepositoryFor,
        importsEnabled: options.scheduleImport !== undefined,
        startImport: importRepositoryFor,
        importStatus: importStatusFor,
        mirrorGitHub: mirrorGitHubFor,
      },
      inbox: {
        threads: (user, filter) => notifications.store.threads(user.id, { ...filter, participating: false }),
        markRead: (user, id) => notifications.store.markThreadRead(user.id, id),
        markDone: (user, id) => notifications.store.markThreadDone(user.id, id),
        markAllRead: (user) => notifications.store.markAllRead(user.id, now().getTime()),
      },
      githubApps: githubApps.ui,
      collaboration: async (request, principal, owner, name) => {
        try {
          return await openCollaborationRepository(collaborationOptions(request), principal, owner, name)
        } catch (error) {
          if (error instanceof CollaborationError && error.status === 404) return null
          throw error
        }
      },
      settings,
      actions,
      releases: {
        list: (repository, includeDrafts, limit, offset) => releaseStore.list(repository.id, includeDrafts, limit, offset),
        byTag: async (repository, tag, includeDrafts) => {
          const release = await releaseStore.byTag(repository.id, tag)
          return release && (includeDrafts || release.draft === 0) ? release : null
        },
        assets: (releaseIds) => releaseStore.assets(releaseIds),
        latest: (repository) => releaseStore.latest(repository.id),
        write: (request, principal) => releaseOperations(releasesOptions(request), principal, issuerFor(request)),
      },
    },
    scheduled: async (at = now()) => {
      const sweep = await notifications.sweep().catch((error: unknown) => ({ error: String(error) }))
      console.log(JSON.stringify({ event: 'notification-sweep', ...sweep }))
      const purged = await logins.purgeExpired().catch((error: unknown) => ({ error: String(error) }))
      console.log(JSON.stringify({ event: 'login-purge', ...purged }))
      if (options.backup) {
        const backup = await startBackup(db, at)
          .then(async (state) => (await scheduleBackup(), { run: state.run?.id }))
          .catch((error: unknown) => ({ error: String(error) }))
        console.log(JSON.stringify({ event: 'backup-scheduled', ...backup }))
      }
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
    runJob: async (job, attempt = 1) => {
      try {
        await runAppJob(job)
      } catch (error) {
        await failures.recorded(job, attempt, error).catch(() => undefined)
        throw error
      } finally {
        await meter.flush().catch(() => undefined)
      }
      await failures.succeeded(job).catch(() => undefined)
    },
    refreshRepository,
    importMetadata,
    notifications,
  }
}
