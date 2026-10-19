import {
  type Access,
  type AccountsStore,
  atLeast,
  base64UrlEncode,
  type Database,
  first,
  minAccess,
  type Principal,
  randomBytes,
  type RepositorySubject,
  resolveAccess,
  sql,
} from '@git-forge/accounts'
import type { DigestFactory, RepositoryName, Storage } from '@git-forge/core'
import { allowed, type CollaborationSettings, DEFAULT_SETTINGS, type Permission } from './permissions.ts'

export type ActorRef = { readonly kind: 'user' | 'app'; readonly id: string }

export type EventActor = ActorRef | { readonly kind: 'system'; readonly id: null }

export const SYSTEM_ACTOR: EventActor = { kind: 'system', id: null }

export type Actor = {
  readonly principal: Principal
  readonly access: Access
  readonly writable: boolean
  readonly ref: ActorRef | null
}

export type AccountsDirectory = Pick<
  AccountsStore,
  | 'grantsFor'
  | 'isInstanceAdmin'
  | 'teamIdsFor'
  | 'findTeam'
  | 'branchProtectionRules'
  | 'findAccount'
  | 'findRepository'
  | 'findRepositoryById'
  | 'authenticateToken'
  | 'createFork'
  | 'forkInfo'
  | 'listForks'
  | 'forkNetwork'
  | 'organizationRole'
  | 'repositoryNameBlock'
  | 'storagePathClaimed'
>

export type BranchUpdate = {
  readonly repo: RepositoryName
  readonly ref: string
  readonly oldId: string
  readonly newId: string
  readonly actor: EventActor
}

export type ActivityKind = 'issues' | 'issue_comment' | 'pull_request' | 'pull_request_review' | 'pull_request_review_comment' | 'discussion' | 'discussion_comment'

export type Activity = {
  readonly kind: ActivityKind
  readonly action: string
  readonly number: number
  readonly actor: EventActor
  readonly commentId?: number
  readonly reviewId?: number
  readonly changes?: Record<string, unknown>
  readonly requestedReviewer?: string
  readonly before?: string
  readonly after?: string
  readonly deleted?: boolean
}

export type ActivityHandler = (scope: Scope, activity: Activity) => Promise<void>

export type LfsOptions = {
  readonly maxObjectBytes?: number
  readonly digests?: DigestFactory
  readonly onStored?: (key: string, size: number) => Promise<void>
}

export type CollaborationOptions = {
  readonly db: Database
  readonly storage: Storage
  readonly accounts: AccountsDirectory
  readonly now?: () => number
  readonly onBranchUpdated?: (update: BranchUpdate) => Promise<void>
  readonly onActivity?: ActivityHandler
  readonly noreplyDomain?: string
  readonly lfs?: LfsOptions
}

export type Scope = {
  readonly db: Database
  readonly storage: Storage
  readonly accounts: AccountsDirectory
  readonly now: () => number
  readonly onBranchUpdated: ((update: BranchUpdate) => Promise<void>) | undefined
  readonly onActivity: ActivityHandler | undefined
  readonly noreplyDomain: string
  readonly repository: RepositorySubject
  readonly repo: RepositoryName
  readonly actor: Actor
  readonly settings: CollaborationSettings
  readonly lfs?: LfsOptions
}

export type ErrorStatus = 400 | 401 | 403 | 404 | 405 | 409 | 410 | 422

export class CollaborationError extends Error {
  constructor(
    readonly status: ErrorStatus,
    message: string,
    readonly details: readonly unknown[] = [],
  ) {
    super(message)
  }
}

export const notFound = (what = 'Not Found'): CollaborationError => new CollaborationError(404, what)

export const invalid = (message: string): CollaborationError => new CollaborationError(422, message)

export const nodeId = (prefix: string): string => `${prefix}_${base64UrlEncode(randomBytes(12))}`

export const actorRefOf = (principal: Principal): ActorRef | null =>
  principal.kind === 'user' ? { kind: 'user', id: principal.id } : principal.kind === 'app' ? { kind: 'app', id: principal.id } : null

export const resolveActor = async (accounts: AccountsDirectory, principal: Principal, repository: RepositorySubject): Promise<Actor> => {
  if (principal.kind === 'instance') return { principal, access: resolveAccess({ kind: 'anonymous' }, repository), writable: false, ref: null }
  let access = resolveAccess(principal, repository, await accounts.grantsFor(principal, repository))
  const limits = principal.kind === 'user' || principal.kind === 'app' ? principal.limits : null
  if (principal.kind === 'user' && (await accounts.isInstanceAdmin(principal.id))) {
    const restricted = limits?.repositoryIds && !limits.repositoryIds.includes(repository.id)
    if (!restricted) access = limits ? minAccess('admin', limits.ceiling) : 'admin'
  }
  const writable = principal.kind !== 'anonymous' && !repository.archived && (limits === null || atLeast(limits.ceiling, 'write'))
  return { principal, access, writable, ref: actorRefOf(principal) }
}

type SettingsRow = {
  has_issues: number
  has_discussions: number
  read_can_participate: number
  allow_merge_commit: number
  allow_squash_merge: number
  allow_rebase_merge: number
}

export const readSettings = async (db: Database, repositoryId: string): Promise<CollaborationSettings> => {
  const row = await first<SettingsRow>(db, sql('SELECT * FROM collaboration_settings WHERE repository_id = ?', repositoryId))
  if (!row) return DEFAULT_SETTINGS
  return {
    hasIssues: row.has_issues === 1,
    hasDiscussions: row.has_discussions === 1,
    readCanParticipate: row.read_can_participate === 1,
    allowMergeCommit: row.allow_merge_commit === 1,
    allowSquashMerge: row.allow_squash_merge === 1,
    allowRebaseMerge: row.allow_rebase_merge === 1,
  }
}

export const openRepository = async (options: CollaborationOptions, principal: Principal, owner: string, name: string): Promise<Scope> => {
  const repository = await options.accounts.findRepository(owner, name)
  if (!repository) throw notFound()
  const actor = await resolveActor(options.accounts, principal, repository)
  if (!atLeast(actor.access, 'read')) throw notFound()
  return {
    db: options.db,
    storage: options.storage,
    accounts: options.accounts,
    now: options.now ?? Date.now,
    onBranchUpdated: options.onBranchUpdated,
    onActivity: options.onActivity,
    noreplyDomain: options.noreplyDomain ?? 'users.noreply.invalid',
    repository,
    repo: { owner: repository.owner, name: repository.name },
    actor,
    settings: await readSettings(options.db, repository.id),
    ...(options.lfs ? { lfs: options.lfs } : {}),
  }
}

export const scopeOptions = (scope: Scope): CollaborationOptions => ({
  db: scope.db,
  storage: scope.storage,
  accounts: scope.accounts,
  now: scope.now,
  noreplyDomain: scope.noreplyDomain,
  ...(scope.onActivity ? { onActivity: scope.onActivity } : {}),
  ...(scope.onBranchUpdated ? { onBranchUpdated: scope.onBranchUpdated } : {}),
  ...(scope.lfs ? { lfs: scope.lfs } : {}),
})

export const can = (scope: Scope, permission: Permission, extra: { readonly author?: ActorRef | null; readonly locked?: boolean } = {}): boolean =>
  allowed(permission, {
    access: scope.actor.access,
    authenticated: scope.actor.ref !== null,
    writable: scope.actor.writable,
    isAuthor: extra.author !== undefined && extra.author !== null && sameActor(scope.actor.ref, extra.author),
    locked: extra.locked ?? false,
    settings: scope.settings,
  })

export const requirePermission = (scope: Scope, permission: Permission, extra: Parameters<typeof can>[2] = {}): ActorRef => {
  if (!scope.actor.ref) throw new CollaborationError(401, 'Requires authentication')
  if (!can(scope, permission, extra)) {
    if (extra.locked && !atLeast(scope.actor.access, 'write')) throw new CollaborationError(403, 'This conversation is locked.')
    throw new CollaborationError(403, 'Resource not accessible by integration')
  }
  return scope.actor.ref
}

export const sameActor = (a: ActorRef | EventActor | null, b: ActorRef | EventActor | null): boolean =>
  a !== null && b !== null && a.kind === b.kind && a.id === b.id

export const refFromColumns = (kind: string | null, id: string | null): ActorRef | null =>
  (kind === 'user' || kind === 'app') && id !== null ? { kind, id } : null

export const emitActivity = async (scope: Scope, activity: Activity): Promise<void> => {
  if (!scope.onActivity) return
  try {
    await scope.onActivity(scope, activity)
  } catch (error) {
    console.error(JSON.stringify({ event: 'collaboration-activity-failed', kind: activity.kind, action: activity.action, error: String(error) }))
  }
}
