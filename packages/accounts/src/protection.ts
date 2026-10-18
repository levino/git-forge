import { type Access, atLeast, type Role } from './roles.ts'

export const BRANCH_PREFIX = 'refs/heads/'

export const MAX_REQUIRED_APPROVALS = 6

export type PushAllowances = {
  readonly users: readonly string[]
  readonly teams: readonly string[]
  readonly apps: readonly string[]
  readonly roles: readonly Role[]
}

export type RequiredPullRequestReviews = {
  readonly requiredApprovingReviewCount: number
  readonly dismissStaleReviews: boolean
  readonly requireCodeOwnerReviews: boolean
  readonly requireLastPushApproval: boolean
}

export type RequiredStatusChecks = {
  readonly strict: boolean
  readonly contexts: readonly string[]
}

export type BranchProtectionSettings = {
  readonly allowForcePushes: boolean
  readonly allowDeletions: boolean
  readonly enforceAdmins: boolean
  readonly restrictions: PushAllowances | null
  readonly requiredPullRequestReviews: RequiredPullRequestReviews | null
  readonly requiredStatusChecks: RequiredStatusChecks | null
}

export type BranchProtectionRule = BranchProtectionSettings & {
  readonly id: string
  readonly repositoryId: string
  readonly pattern: string
  readonly createdAt: number
  readonly updatedAt: number
}

export const DEFAULT_PROTECTION: BranchProtectionSettings = {
  allowForcePushes: false,
  allowDeletions: false,
  enforceAdmins: false,
  restrictions: null,
  requiredPullRequestReviews: null,
  requiredStatusChecks: null,
}

export class BranchPatternError extends Error {}

const SPECIAL = /[*?[\]\\]/

export const isWildcardPattern = (pattern: string): boolean => SPECIAL.test(pattern)

const escapeRegex = (char: string): string => char.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')

const bracket = (pattern: string, start: number): { source: string; end: number } => {
  let i = start + 1
  let negate = false
  if (pattern[i] === '!' || pattern[i] === '^') {
    negate = true
    i++
  }
  let body = ''
  let first = true
  while (i < pattern.length && (pattern[i] !== ']' || first)) {
    let char = pattern[i]!
    if (char === '\\' && i + 1 < pattern.length) char = pattern[++i]!
    if (pattern[i + 1] === '-' && i + 2 < pattern.length && pattern[i + 2] !== ']') {
      let to = pattern[i + 2]!
      let skip = 2
      if (to === '\\' && i + 3 < pattern.length) {
        to = pattern[i + 3]!
        skip = 3
      }
      if (to < char) throw new BranchPatternError(`invalid range ${char}-${to} in ${pattern}`)
      body += `${escapeRegex(char)}-${escapeRegex(to)}`
      i += skip + 1
    } else {
      body += escapeRegex(char)
      i++
    }
    first = false
  }
  if (i >= pattern.length) throw new BranchPatternError(`unterminated [ in ${pattern}`)
  return { source: negate ? `[^/${body}]` : `(?!/)[${body}]`, end: i + 1 }
}

export const compileBranchPattern = (pattern: string): RegExp => {
  if (pattern.length === 0 || pattern.length > 255) throw new BranchPatternError('pattern must have 1 to 255 characters')
  if (/[\x00-\x1f\x7f]/.test(pattern)) throw new BranchPatternError('pattern must not contain control characters')
  let source = ''
  let i = 0
  while (i < pattern.length) {
    const char = pattern[i]!
    const atSegmentStart = i === 0 || pattern[i - 1] === '/'
    if (char === '*' && pattern[i + 1] === '*' && pattern[i + 2] === '/' && atSegmentStart) {
      source += '(?:[^/]*/)*'
      i += 3
    } else if (char === '*') {
      source += '[^/]*'
      while (pattern[i] === '*') i++
    } else if (char === '?') {
      source += '[^/]'
      i++
    } else if (char === '[') {
      const compiled = bracket(pattern, i)
      source += compiled.source
      i = compiled.end
    } else if (char === '\\' && i + 1 < pattern.length) {
      source += escapeRegex(pattern[i + 1]!)
      i += 2
    } else {
      source += escapeRegex(char)
      i++
    }
  }
  return new RegExp(`^${source}$`)
}

export const validateBranchPattern = (pattern: string): string => {
  compileBranchPattern(pattern)
  return pattern
}

export const matchesBranchPattern = (pattern: string, branch: string): boolean => {
  try {
    return compileBranchPattern(pattern).test(branch)
  } catch {
    return false
  }
}

export const branchOfRef = (ref: string): string | null => (ref.startsWith(BRANCH_PREFIX) ? ref.slice(BRANCH_PREFIX.length) : null)

export const selectProtectionRule = <T extends Pick<BranchProtectionRule, 'pattern' | 'createdAt'>>(rules: readonly T[], branch: string): T | null => {
  const exact = rules.filter((rule) => !isWildcardPattern(rule.pattern) && rule.pattern === branch)
  const wildcard = rules.filter((rule) => isWildcardPattern(rule.pattern) && matchesBranchPattern(rule.pattern, branch))
  const byAge = (a: T, b: T) => a.createdAt - b.createdAt
  return [...exact].sort(byAge)[0] ?? [...wildcard].sort(byAge)[0] ?? null
}

export type ProtectionActor = {
  readonly kind: 'anonymous' | 'user' | 'app' | 'instance'
  readonly id: string | null
  readonly access: Access
  readonly teamIds: readonly string[]
}

export type BranchUpdate = {
  readonly ref: string
  readonly oldId: string
  readonly newId: string
  readonly fastForward: boolean
}

export type CheckState = 'success' | 'neutral' | 'skipped' | 'pending' | 'failure' | 'error'

export type UpdateEvidence =
  | { readonly via: 'push'; readonly statuses?: Readonly<Record<string, CheckState>> }
  | {
      readonly via: 'pull-request'
      readonly approvals: number
      readonly changesRequested: boolean
      readonly codeOwnerApproved: boolean
      readonly lastPushApproved: boolean
      readonly upToDate: boolean
      readonly statuses: Readonly<Record<string, CheckState>>
    }

const ZERO = /^0+$/

const PASSING: ReadonlySet<CheckState> = new Set(['success', 'neutral', 'skipped'])

export const isAdminBypass = (rule: BranchProtectionSettings, actor: ProtectionActor): boolean =>
  !rule.enforceAdmins && atLeast(actor.access, 'admin')

export const mayPush = (allowances: PushAllowances, actor: ProtectionActor): boolean => {
  if (actor.id !== null && actor.kind === 'user' && allowances.users.includes(actor.id)) return true
  if (actor.id !== null && actor.kind === 'app' && allowances.apps.includes(actor.id)) return true
  if (actor.kind === 'user' && actor.teamIds.some((team) => allowances.teams.includes(team))) return true
  return (actor.kind === 'user' || actor.kind === 'app') && allowances.roles.some((role) => atLeast(actor.access, role))
}

const statusProblems = (checks: RequiredStatusChecks, statuses: Readonly<Record<string, CheckState>>): string[] =>
  checks.contexts.flatMap((context) => {
    const state = statuses[context]
    if (state === undefined || state === 'pending') return [`required status check "${context}" is expected`]
    return PASSING.has(state) ? [] : [`required status check "${context}" has not succeeded`]
  })

const reviewProblems = (reviews: RequiredPullRequestReviews, evidence: Extract<UpdateEvidence, { via: 'pull-request' }>): string[] => {
  const problems: string[] = []
  const count = reviews.requiredApprovingReviewCount
  if (evidence.approvals < count) problems.push(`${count} approving review${count === 1 ? ' is' : 's are'} required`)
  if (evidence.changesRequested) problems.push('changes were requested by a reviewer')
  if (reviews.requireCodeOwnerReviews && !evidence.codeOwnerApproved) problems.push('review from a code owner is required')
  if (reviews.requireLastPushApproval && !evidence.lastPushApproved) problems.push('the most recent push must be approved by someone else')
  return problems
}

export const evaluateBranchUpdate = (
  rule: BranchProtectionSettings | null,
  actor: ProtectionActor,
  update: BranchUpdate,
  evidence: UpdateEvidence = { via: 'push' },
): readonly string[] => {
  if (!rule || branchOfRef(update.ref) === null || isAdminBypass(rule, actor)) return []
  const deletion = ZERO.test(update.newId)
  const creation = ZERO.test(update.oldId)
  if (deletion) {
    if (!rule.allowDeletions) return ['deletion is not allowed']
    return rule.restrictions && !mayPush(rule.restrictions, actor) ? ['you are not allowed to push to this branch'] : []
  }
  const problems: string[] = []
  if (!creation && !update.fastForward && !rule.allowForcePushes) problems.push('force push is not allowed')
  if (rule.restrictions && !mayPush(rule.restrictions, actor)) problems.push('you are not allowed to push to this branch')
  if (evidence.via === 'push') {
    if (rule.requiredPullRequestReviews) problems.push('changes must be made through a pull request')
    if (rule.requiredStatusChecks) problems.push(...statusProblems(rule.requiredStatusChecks, evidence.statuses ?? {}))
    return problems
  }
  if (rule.requiredPullRequestReviews) problems.push(...reviewProblems(rule.requiredPullRequestReviews, evidence))
  if (rule.requiredStatusChecks) {
    problems.push(...statusProblems(rule.requiredStatusChecks, evidence.statuses))
    if (rule.requiredStatusChecks.strict && !evidence.upToDate) problems.push('branch must be up to date before merging')
  }
  return problems
}

export const protectionRejection = (problems: readonly string[]): string | null =>
  problems.length === 0 ? null : `protected branch: ${problems[0]}`
