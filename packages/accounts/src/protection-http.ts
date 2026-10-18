import type { Authorize, PushPolicy, RefPolicy, RepositoryName } from '@git-forge/core'
import {
  type AuthenticateOptions,
  authenticateRequest,
  challenge,
  checkRepositoryAccess,
  grantedView,
  REALM,
  type RepositoryDirectory,
} from './authorize.ts'
import type { Principal, RepositorySubject } from './permissions.ts'
import {
  type BranchProtectionRule,
  type BranchProtectionSettings,
  branchOfRef,
  BranchPatternError,
  evaluateBranchUpdate,
  MAX_REQUIRED_APPROVALS,
  type ProtectionActor,
  protectionRejection,
  selectProtectionRule,
  validateBranchPattern,
} from './protection.ts'
import { type Access, isRole, type Role } from './roles.ts'
import { AccountsError, type AccountsStore, type AuditActor } from './store.ts'

export type ProtectionDirectory = RepositoryDirectory & Pick<AccountsStore, 'branchProtectionRules' | 'teamIdsFor'>

export const protectionActor = async (
  directory: Pick<AccountsStore, 'teamIdsFor'>,
  principal: Principal,
  repository: RepositorySubject,
  access: Access,
): Promise<ProtectionActor> => {
  switch (principal.kind) {
    case 'anonymous':
      return { kind: 'anonymous', id: null, access, teamIds: [] }
    case 'user':
      return {
        kind: 'user',
        id: principal.id,
        access,
        teamIds: repository.ownerKind === 'organization' ? await directory.teamIdsFor(principal.id, repository.ownerId) : [],
      }
    case 'app':
      return { kind: 'app', id: principal.id, access, teamIds: [] }
    case 'instance':
      return { kind: 'instance', id: principal.issuer, access, teamIds: [] }
  }
}

export const branchProtectionPolicy = (rules: readonly BranchProtectionRule[], actor: ProtectionActor): RefPolicy | null =>
  rules.length === 0
    ? null
    : (command) => {
        const branch = branchOfRef(command.name)
        if (branch === null) return null
        const rule = selectProtectionRule(rules, branch)
        return protectionRejection(
          evaluateBranchUpdate(rule, actor, { ref: command.name, oldId: command.oldId, newId: command.newId, fastForward: command.fastForward }),
        )
      }

export type GitAccess = {
  readonly authorize: Authorize
  readonly pushPolicy: PushPolicy
}

export const createGitAccess = (options: AuthenticateOptions & { readonly directory: ProtectionDirectory }): GitAccess => {
  const principals = new WeakMap<Request, Promise<Principal | null>>()
  const principalOf = (request: Request): Promise<Principal | null> => {
    const known = principals.get(request)
    if (known) return known
    const pending = authenticateRequest(request, options)
    principals.set(request, pending)
    return pending
  }
  const denyAll: RefPolicy = () => 'permission denied'
  return {
    authorize: async (request, repo, access, surface) => {
      const principal = await principalOf(request)
      if (!principal) return challenge('invalid credentials\n')
      const check = await checkRepositoryAccess(options.directory, principal, repo, access === 'write' ? 'write' : 'read', surface)
      return grantedView(check, principal)
    },
    pushPolicy: async (request, repo) => {
      const principal = await principalOf(request)
      if (!principal) return denyAll
      const check = await checkRepositoryAccess(options.directory, principal, repo, 'write')
      if (check.decision !== 'allow' || !check.repository) return denyAll
      const rules = await options.directory.branchProtectionRules(check.repository.id)
      if (rules.length === 0) return null
      return branchProtectionPolicy(rules, await protectionActor(options.directory, principal, check.repository, check.access))
    },
  }
}

export type ProtectionStore = ProtectionDirectory &
  Pick<AccountsStore, 'setBranchProtection' | 'deleteBranchProtection' | 'namedAllowances' | 'findAccount' | 'findTeam' | 'findApp'>

export type BranchProtectionApiOptions = {
  readonly store: ProtectionStore
  readonly verifyInstance?: AuthenticateOptions['verifyInstance']
  readonly authenticate?: (request: Request) => Promise<Principal | null>
  readonly prefix?: string
}

export type JsonObject = Record<string, unknown>

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  })

const failed = (errors: readonly string[]) => json(422, { message: 'Validation Failed', errors: errors.map((message) => ({ message })) })

export class ProtectionValidationError extends Error {}

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value)

const bool = (body: JsonObject, key: string, fallback = false): boolean => {
  const value = body[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new ProtectionValidationError(`${key} must be a boolean`)
  return value
}

const strings = (body: JsonObject, key: string): string[] => {
  const value = body[key]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new ProtectionValidationError(`${key} must be an array of strings`)
  return value as string[]
}

const section = (body: JsonObject, key: string): JsonObject | null => {
  const value = body[key]
  if (value === undefined || value === null) return null
  if (!isObject(value)) throw new ProtectionValidationError(`${key} must be an object or null`)
  return value
}

const enforceAdminsOf = (value: unknown): boolean => {
  if (value === undefined || value === null) return false
  if (typeof value === 'boolean') return value
  if (isObject(value) && typeof value.enabled === 'boolean') return value.enabled
  throw new ProtectionValidationError('enforce_admins must be a boolean or null')
}

const toggle = (body: JsonObject, key: string): boolean => {
  const value = body[key]
  if (isObject(value)) return bool(value, 'enabled')
  return bool(body, key)
}

export const parseBranchProtectionSettings = async (body: JsonObject, store: ProtectionStore, repository: RepositorySubject): Promise<BranchProtectionSettings> => {
  const checks = section(body, 'required_status_checks')
  const reviews = section(body, 'required_pull_request_reviews')
  const restrictions = section(body, 'restrictions')
  const contexts = checks
    ? [
        ...strings(checks, 'contexts'),
        ...(Array.isArray(checks.checks)
          ? checks.checks.map((check) => {
              if (!isObject(check) || typeof check.context !== 'string') throw new ProtectionValidationError('checks must be objects with a context')
              return check.context
            })
          : []),
      ]
    : []
  let count = 1
  if (reviews && reviews.required_approving_review_count !== undefined) {
    const value = reviews.required_approving_review_count
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_REQUIRED_APPROVALS) {
      throw new ProtectionValidationError(`required_approving_review_count must be an integer between 0 and ${MAX_REQUIRED_APPROVALS}`)
    }
    count = value
  }
  const resolve = async (names: readonly string[], find: (name: string) => Promise<{ readonly id: string } | null>, what: string): Promise<string[]> => {
    const ids: string[] = []
    for (const name of names) {
      const found = await find(name)
      if (!found) throw new ProtectionValidationError(`unknown ${what} ${name}`)
      ids.push(found.id)
    }
    return ids
  }
  let pushAllowances: BranchProtectionSettings['restrictions'] = null
  if (restrictions) {
    const teamSlugs = strings(restrictions, 'teams')
    if (teamSlugs.length > 0 && repository.ownerKind !== 'organization') throw new ProtectionValidationError('teams can only be used for organization repositories')
    const roles = strings(restrictions, 'roles')
    const invalid = roles.find((role) => !isRole(role))
    if (invalid !== undefined) throw new ProtectionValidationError(`unknown role ${invalid}`)
    pushAllowances = {
      users: await resolve(
        strings(restrictions, 'users'),
        async (login) => {
          const account = await store.findAccount(login)
          return account?.kind === 'user' ? account : null
        },
        'user',
      ),
      teams: await resolve(teamSlugs, (slug) => store.findTeam(repository.ownerId, slug), 'team'),
      apps: await resolve(strings(restrictions, 'apps'), (slug) => store.findApp(slug), 'app'),
      roles: roles as Role[],
    }
  }
  return {
    allowForcePushes: toggle(body, 'allow_force_pushes'),
    allowDeletions: toggle(body, 'allow_deletions'),
    enforceAdmins: enforceAdminsOf(body.enforce_admins),
    restrictions: pushAllowances,
    requiredPullRequestReviews: reviews
      ? {
          requiredApprovingReviewCount: count,
          dismissStaleReviews: bool(reviews, 'dismiss_stale_reviews'),
          requireCodeOwnerReviews: bool(reviews, 'require_code_owner_reviews'),
          requireLastPushApproval: bool(reviews, 'require_last_push_approval'),
        }
      : null,
    requiredStatusChecks: checks ? { strict: bool(checks, 'strict'), contexts } : null,
  }
}

const render = async (store: ProtectionStore, rule: BranchProtectionRule, url: string): Promise<JsonObject> => {
  const names = await store.namedAllowances(rule)
  return {
    url,
    pattern: rule.pattern,
    ...(rule.requiredStatusChecks
      ? {
          required_status_checks: {
            url: `${url}/required_status_checks`,
            strict: rule.requiredStatusChecks.strict,
            contexts: rule.requiredStatusChecks.contexts,
            checks: rule.requiredStatusChecks.contexts.map((context) => ({ context, app_id: null })),
          },
        }
      : {}),
    ...(rule.requiredPullRequestReviews
      ? {
          required_pull_request_reviews: {
            url: `${url}/required_pull_request_reviews`,
            required_approving_review_count: rule.requiredPullRequestReviews.requiredApprovingReviewCount,
            dismiss_stale_reviews: rule.requiredPullRequestReviews.dismissStaleReviews,
            require_code_owner_reviews: rule.requiredPullRequestReviews.requireCodeOwnerReviews,
            require_last_push_approval: rule.requiredPullRequestReviews.requireLastPushApproval,
          },
        }
      : {}),
    enforce_admins: { url: `${url}/enforce_admins`, enabled: rule.enforceAdmins },
    ...(rule.restrictions
      ? {
          restrictions: {
            url: `${url}/restrictions`,
            users: names.users.map((user) => ({ id: user.id, login: user.login, type: 'User' })),
            teams: names.teams.map((team) => ({ id: team.id, slug: team.slug, name: team.name })),
            apps: names.apps.map((app) => ({ id: app.id, slug: app.slug, name: app.name })),
            roles: rule.restrictions.roles,
          },
        }
      : {}),
    allow_force_pushes: { enabled: rule.allowForcePushes },
    allow_deletions: { enabled: rule.allowDeletions },
  }
}

export const protectionAuditActor = (principal: Principal): AuditActor => {
  switch (principal.kind) {
    case 'user':
      return { kind: 'user', id: principal.id }
    case 'app':
      return { kind: 'app', id: principal.id }
    case 'instance':
      return { kind: 'instance', id: principal.issuer }
    case 'anonymous':
      return { kind: 'system' }
  }
}

const decodeSegment = (segment: string): string | null => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

type ProtectionRoute = { readonly repo: RepositoryName; readonly pattern: string | null }

export const matchProtectionRoute = (pathname: string, prefix = '/api'): ProtectionRoute | null => {
  if (!pathname.startsWith(`${prefix}/repos/`)) return null
  const rest = pathname.slice(`${prefix}/repos/`.length)
  const list = /^([^/]+)\/([^/]+)\/branch-protection$/.exec(rest)
  if (list) {
    const owner = decodeSegment(list[1]!)
    const name = decodeSegment(list[2]!)
    return owner && name ? { repo: { owner, name }, pattern: null } : null
  }
  const single = /^([^/]+)\/([^/]+)\/branches\/(.+)\/protection$/.exec(rest)
  if (!single) return null
  const owner = decodeSegment(single[1]!)
  const name = decodeSegment(single[2]!)
  const pattern = decodeSegment(single[3]!)
  return owner && name && pattern ? { repo: { owner, name }, pattern } : null
}

export const handleBranchProtectionRequest = async (request: Request, options: BranchProtectionApiOptions): Promise<Response | null> => {
  const url = new URL(request.url)
  const route = matchProtectionRoute(url.pathname, options.prefix)
  if (!route) return null
  const { store } = options
  const allowed = route.pattern === null ? ['GET'] : ['GET', 'PUT', 'DELETE']
  if (!allowed.includes(request.method)) return json(405, { message: 'Method Not Allowed' }, { Allow: allowed.join(', ') })
  const principal = options.authenticate
    ? await options.authenticate(request)
    : await authenticateRequest(request, { directory: store, ...(options.verifyInstance ? { verifyInstance: options.verifyInstance } : {}) })
  if (!principal) return json(401, { message: 'Bad credentials' }, { 'WWW-Authenticate': `Basic realm="${REALM}"` })
  const check = await checkRepositoryAccess(store, principal, route.repo, 'admin')
  const { decision } = check
  if (decision === 'unauthenticated') return json(401, { message: 'Requires authentication' }, { 'WWW-Authenticate': `Basic realm="${REALM}"` })
  if (decision === 'not-found' || !check.repository) return json(404, { message: 'Not Found' })
  if (decision === 'forbidden') return json(403, { message: 'Must have admin rights to Repository.' })
  const repository = check.repository
  const rules = await store.branchProtectionRules(repository.id)
  const base = `${url.origin}${options.prefix ?? '/api'}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`
  const ruleUrl = (pattern: string) => `${base}/branches/${encodeURIComponent(pattern)}/protection`
  if (route.pattern === null) return json(200, await Promise.all(rules.map((rule) => render(store, rule, ruleUrl(rule.pattern)))))
  const pattern = route.pattern
  const existing = rules.find((rule) => rule.pattern === pattern) ?? null
  if (request.method === 'GET') return existing ? json(200, await render(store, existing, ruleUrl(pattern))) : json(404, { message: 'Branch not protected' })
  if (request.method === 'DELETE') {
    return (await store.deleteBranchProtection(repository.id, pattern, protectionAuditActor(principal))) ? json(204, null) : json(404, { message: 'Branch not protected' })
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json(400, { message: 'Problems parsing JSON' })
  }
  if (!isObject(body)) return json(400, { message: 'Body must be a JSON object' })
  try {
    validateBranchPattern(pattern)
    const settings = await parseBranchProtectionSettings(body, store, repository)
    const rule = await store.setBranchProtection(repository.id, pattern, settings, protectionAuditActor(principal))
    return json(200, await render(store, rule, ruleUrl(pattern)))
  } catch (error) {
    if (error instanceof ProtectionValidationError || error instanceof AccountsError || error instanceof BranchPatternError) return failed([error.message])
    throw error
  }
}
