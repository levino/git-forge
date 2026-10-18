import { describe, expect, it } from 'vitest'
import {
  type BranchProtectionSettings,
  BranchPatternError,
  branchProtectionPolicy,
  compileBranchPattern,
  DEFAULT_PROTECTION,
  evaluateBranchUpdate,
  isWildcardPattern,
  matchesBranchPattern,
  matchProtectionRoute,
  type ProtectionActor,
  protectionRejection,
  selectProtectionRule,
} from '../src/index.ts'

const ZERO = '0'.repeat(40)
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

const writer: ProtectionActor = { kind: 'user', id: 'u-writer', access: 'write', teamIds: ['t-core'] }
const admin: ProtectionActor = { kind: 'user', id: 'u-admin', access: 'admin', teamIds: [] }
const bot: ProtectionActor = { kind: 'app', id: 'a-bot', access: 'write', teamIds: [] }

const update = (oldId: string, newId: string, fastForward: boolean, ref = 'refs/heads/main') => ({ ref, oldId, newId, fastForward })

const rule = (settings: Partial<BranchProtectionSettings>): BranchProtectionSettings => ({ ...DEFAULT_PROTECTION, ...settings })

describe('branch name patterns (fnmatch with FNM_PATHNAME, as on GitHub)', () => {
  it.each([
    ['main', 'main', true],
    ['main', 'mainline', false],
    ['*', 'main', true],
    ['*', 'feature/x', false],
    ['release/*', 'release/1.0', true],
    ['release/*', 'release/1.0/hotfix', false],
    ['release/**/*', 'release/1.0/hotfix', true],
    ['release/**/*', 'release/1.0', true],
    ['**/*', 'a/b/c', true],
    ['v?', 'v1', true],
    ['v?', 'v10', false],
    ['v[0-9]*', 'v2-beta', true],
    ['v[0-9]*', 'vx', false],
    ['[!d]*', 'main', true],
    ['[!d]*', 'dev', false],
    ['[^d]*', 'dev', false],
    ['feat[/]x', 'feat/x', false],
    ['a\\*b', 'a*b', true],
    ['a\\*b', 'axb', false],
    ['qa*', 'qa/foo', false],
    ['us.er', 'usxer', false],
  ])('%s against %s is %s', (pattern, branch, expected) => {
    expect(matchesBranchPattern(pattern, branch)).toBe(expected)
  })

  it('rejects malformed patterns', () => {
    expect(() => compileBranchPattern('')).toThrow(BranchPatternError)
    expect(() => compileBranchPattern('[abc')).toThrow(BranchPatternError)
    expect(() => compileBranchPattern('[z-a]')).toThrow(BranchPatternError)
    expect(() => compileBranchPattern('a\nb')).toThrow(BranchPatternError)
    expect(matchesBranchPattern('[abc', 'a')).toBe(false)
  })

  it('treats *, ?, [, ] and \\ as wildcard markers', () => {
    expect(isWildcardPattern('main')).toBe(false)
    expect(isWildcardPattern('release/*')).toBe(true)
    expect(isWildcardPattern('v]')).toBe(true)
  })
})

describe('rule selection', () => {
  const rules = [
    { id: 'wild-new', pattern: '*', createdAt: 3 },
    { id: 'wild-old', pattern: 'ma*', createdAt: 2 },
    { id: 'exact', pattern: 'main', createdAt: 5 },
    { id: 'release', pattern: 'release/*', createdAt: 1 },
  ]

  it('prefers a rule naming the branch exactly, then the oldest matching wildcard rule', () => {
    expect(selectProtectionRule(rules, 'main')?.id).toBe('exact')
    expect(selectProtectionRule(rules, 'master')?.id).toBe('wild-old')
    expect(selectProtectionRule(rules, 'dev')?.id).toBe('wild-new')
    expect(selectProtectionRule(rules, 'release/1')?.id).toBe('release')
    expect(selectProtectionRule(rules, 'feature/x')).toBeNull()
  })
})

describe('evaluateBranchUpdate on push', () => {
  it('allows everything without a rule and ignores refs outside refs/heads/', () => {
    expect(evaluateBranchUpdate(null, writer, update(A, ZERO, false))).toEqual([])
    expect(evaluateBranchUpdate(rule({}), writer, update(A, ZERO, false, 'refs/tags/v1'))).toEqual([])
    expect(evaluateBranchUpdate(rule({}), writer, update(A, ZERO, false, 'refs/upstream/origin/heads/main'))).toEqual([])
  })

  it('blocks force pushes and deletions by default but allows fast-forwards and creation', () => {
    const protectedMain = rule({})
    expect(evaluateBranchUpdate(protectedMain, writer, update(A, B, true))).toEqual([])
    expect(evaluateBranchUpdate(protectedMain, writer, update(ZERO, B, true))).toEqual([])
    expect(evaluateBranchUpdate(protectedMain, writer, update(A, B, false))).toEqual(['force push is not allowed'])
    expect(evaluateBranchUpdate(protectedMain, writer, update(A, ZERO, false))).toEqual(['deletion is not allowed'])
    expect(evaluateBranchUpdate(rule({ allowForcePushes: true, allowDeletions: true }), writer, update(A, B, false))).toEqual([])
    expect(evaluateBranchUpdate(rule({ allowForcePushes: true, allowDeletions: true }), writer, update(A, ZERO, false))).toEqual([])
  })

  it('lets admins bypass unless enforce_admins is set', () => {
    expect(evaluateBranchUpdate(rule({}), admin, update(A, B, false))).toEqual([])
    expect(evaluateBranchUpdate(rule({ enforceAdmins: true }), admin, update(A, B, false))).toEqual(['force push is not allowed'])
  })

  it('restricts pushes to listed users, teams, apps and roles', () => {
    const none = { users: [], teams: [], apps: [], roles: [] }
    const denied = ['you are not allowed to push to this branch']
    expect(evaluateBranchUpdate(rule({ restrictions: none }), writer, update(A, B, true))).toEqual(denied)
    expect(evaluateBranchUpdate(rule({ restrictions: { ...none, users: ['u-writer'] } }), writer, update(A, B, true))).toEqual([])
    expect(evaluateBranchUpdate(rule({ restrictions: { ...none, teams: ['t-core'] } }), writer, update(A, B, true))).toEqual([])
    expect(evaluateBranchUpdate(rule({ restrictions: { ...none, apps: ['a-bot'] } }), bot, update(A, B, true))).toEqual([])
    expect(evaluateBranchUpdate(rule({ restrictions: { ...none, apps: ['a-bot'] } }), writer, update(A, B, true))).toEqual(denied)
    expect(evaluateBranchUpdate(rule({ restrictions: { ...none, roles: ['maintain'] } }), writer, update(A, B, true))).toEqual(denied)
    expect(evaluateBranchUpdate(rule({ restrictions: { ...none, roles: ['write'] } }), writer, update(A, B, true))).toEqual([])
    expect(evaluateBranchUpdate(rule({ restrictions: none, allowDeletions: true }), writer, update(A, ZERO, false))).toEqual(denied)
    expect(evaluateBranchUpdate(rule({ restrictions: none }), admin, update(A, B, true))).toEqual([])
  })

  it('requires pull requests and status checks for direct pushes', () => {
    const reviews = { requiredApprovingReviewCount: 1, dismissStaleReviews: false, requireCodeOwnerReviews: false, requireLastPushApproval: false }
    expect(evaluateBranchUpdate(rule({ requiredPullRequestReviews: reviews }), writer, update(A, B, true))).toEqual([
      'changes must be made through a pull request',
    ])
    const checks = rule({ requiredStatusChecks: { strict: false, contexts: ['ci', 'lint'] } })
    expect(evaluateBranchUpdate(checks, writer, update(A, B, true))).toEqual([
      'required status check "ci" is expected',
      'required status check "lint" is expected',
    ])
    expect(evaluateBranchUpdate(checks, writer, update(A, B, true), { via: 'push', statuses: { ci: 'success', lint: 'failure' } })).toEqual([
      'required status check "lint" has not succeeded',
    ])
    expect(evaluateBranchUpdate(checks, writer, update(A, ZERO, false))).toEqual(['deletion is not allowed'])
  })
})

describe('evaluateBranchUpdate for a pull request merge', () => {
  const reviews = { requiredApprovingReviewCount: 2, dismissStaleReviews: true, requireCodeOwnerReviews: true, requireLastPushApproval: true }
  const protectedMain = rule({ requiredPullRequestReviews: reviews, requiredStatusChecks: { strict: true, contexts: ['ci'] } })
  const ready = {
    via: 'pull-request' as const,
    approvals: 2,
    changesRequested: false,
    codeOwnerApproved: true,
    lastPushApproved: true,
    upToDate: true,
    statuses: { ci: 'success' as const },
  }

  it('passes when reviews and checks are satisfied', () => {
    expect(evaluateBranchUpdate(protectedMain, writer, update(A, B, true), ready)).toEqual([])
  })

  it('lists every unmet requirement', () => {
    expect(
      evaluateBranchUpdate(protectedMain, writer, update(A, B, true), {
        ...ready,
        approvals: 1,
        changesRequested: true,
        codeOwnerApproved: false,
        lastPushApproved: false,
        upToDate: false,
        statuses: { ci: 'pending' },
      }),
    ).toEqual([
      '2 approving reviews are required',
      'changes were requested by a reviewer',
      'review from a code owner is required',
      'the most recent push must be approved by someone else',
      'required status check "ci" is expected',
      'branch must be up to date before merging',
    ])
  })

  it('still applies push restrictions to the merging actor', () => {
    const restricted = rule({ ...protectedMain, restrictions: { users: [], teams: [], apps: [], roles: ['admin'] }, enforceAdmins: true })
    expect(evaluateBranchUpdate(restricted, writer, update(A, B, true), ready)).toEqual(['you are not allowed to push to this branch'])
  })
})

describe('receive-pack policy', () => {
  it('turns the first problem into an ng reason and only looks at branches', () => {
    expect(protectionRejection([])).toBeNull()
    expect(protectionRejection(['force push is not allowed', 'x'])).toBe('protected branch: force push is not allowed')
    const rules = [{ ...rule({}), id: 'r', repositoryId: 'repo', pattern: 'main', createdAt: 1, updatedAt: 1 }]
    const policy = branchProtectionPolicy(rules, writer)!
    expect(policy({ name: 'refs/heads/main', oldId: A, newId: B, fastForward: false })).toBe('protected branch: force push is not allowed')
    expect(policy({ name: 'refs/heads/other', oldId: A, newId: B, fastForward: false })).toBeNull()
    expect(policy({ name: 'refs/tags/main', oldId: A, newId: ZERO, fastForward: false })).toBeNull()
    expect(branchProtectionPolicy([], writer)).toBeNull()
  })
})

describe('API routes', () => {
  it('matches GitHub-style protection paths under the prefix', () => {
    expect(matchProtectionRoute('/api/repos/village/archive/branches/main/protection')).toEqual({ repo: { owner: 'village', name: 'archive' }, pattern: 'main' })
    expect(matchProtectionRoute('/api/repos/village/archive/branches/release/*/protection')?.pattern).toBe('release/*')
    expect(matchProtectionRoute('/api/repos/village/archive/branches/release%2F%2A/protection')?.pattern).toBe('release/*')
    expect(matchProtectionRoute('/api/repos/village/archive/branch-protection')).toEqual({ repo: { owner: 'village', name: 'archive' }, pattern: null })
    expect(matchProtectionRoute('/v3/repos/a/b/branches/main/protection', '/v3')?.pattern).toBe('main')
    expect(matchProtectionRoute('/api/repos/village/archive/branches/main')).toBeNull()
    expect(matchProtectionRoute('/village/archive.git/info/refs')).toBeNull()
  })
})
