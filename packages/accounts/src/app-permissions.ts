import { type ObjectDatabase, type ObjectId, pathIdAt, type RefCheck, ZERO_ID } from '@git-forge/core'
import type { AppPermissions, PermissionLevel } from './apps.ts'

export type PermissionNeed = readonly [permission: string, level: 'read' | 'write']

type Rule = readonly [pattern: RegExp, read: string | null, write?: string | null | readonly PermissionNeed[]]

const REPO_RULES: readonly Rule[] = [
  [/^$/, 'metadata', 'administration'],
  [/^\/(languages|contributors|stargazers|tags\/protection)$/, 'metadata', null],
  [/^\/topics$/, 'metadata', 'administration'],
  [/^\/forks$/, 'metadata', 'administration'],
  [/^\/branches\/[^/]+\/protection(\/.*)?$/, 'administration'],
  [/^\/commits\/[^/]+\/(status|statuses)$/, 'statuses'],
  [/^\/commits\/[^/]+\/(check-runs|check-suites)$/, 'checks'],
  [/^\/pulls\/\d+\/(merge|update-branch)$/, 'pull_requests', [['pull_requests', 'write'], ['contents', 'write']]],
  [/^\/(issues|labels|milestones|assignees)(\/.*)?$/, 'issues'],
  [/^\/pulls(\/.*)?$/, 'pull_requests'],
  [/^\/(contents|git|commits|branches|tags|compare|readme|tarball|zipball|merges|archive|releases)(\/.*)?$/, 'contents'],
  [/^\/statuses(\/.*)?$/, 'statuses'],
  [/^\/(check-runs|check-suites)(\/.*)?$/, 'checks'],
  [/^\/hooks(\/.*)?$/, 'repository_hooks'],
  [/^\/actions\/secrets(\/.*)?$/, 'secrets'],
  [/^\/actions\/variables(\/.*)?$/, 'variables'],
  [/^\/actions\/runners(\/.*)?$/, 'administration'],
  [/^\/actions(\/.*)?$/, 'actions'],
  [/^\/environments\/[^/]+\/(secrets|variables)(\/.*)?$/, 'secrets'],
  [/^\/environments(\/.*)?$/, 'actions', 'administration'],
  [/^\/deployments(\/.*)?$/, 'deployments'],
  [/^\/pages(\/.*)?$/, 'pages'],
  [/^\/discussions(\/.*)?$/, 'discussions'],
  [/^\/(collaborators|transfer|import|mirrors|lfs|keys)(\/.*)?$/, 'administration'],
]

const GLOBAL_RULES: readonly Rule[] = [
  [/^\/installation\/(repositories|token)$/, null, null],
  [/^\/(meta|rate_limit)$/, null, null],
  [/^\/search\/.+$/, 'metadata', null],
  [/^\/users\/[^/]+$/, 'metadata', null],
  [/^\/orgs\/[^/]+$/, 'metadata', 'organization_administration'],
  [/^\/orgs\/[^/]+\/hooks(\/.*)?$/, 'organization_hooks'],
  [/^\/orgs\/[^/]+\/(members|memberships|teams|outside_collaborators)(\/.*)?$/, 'members'],
  [/^\/uploads\/repos\/[^/]+\/[^/]+\/releases\/\d+\/assets$/, 'contents', 'contents'],
]

const READ_METHODS = new Set(['GET', 'HEAD'])

const fromRules = (rules: readonly Rule[], rest: string, method: string): readonly PermissionNeed[] | null => {
  const rule = rules.find(([pattern]) => pattern.test(rest))
  if (!rule) return null
  const [, read, write] = rule
  if (READ_METHODS.has(method)) return read === null ? [] : [[read, 'read']]
  if (write === null) return read === null ? [] : null
  if (Array.isArray(write)) return write
  return [[(write as string | undefined) ?? read!, 'write']]
}

const GIT_REPO = /^\/[^/]+\/[^/]+?(?:\.git)?(\/.*)$/

const gitNeeds = (method: string, url: URL, lfsOperation: string | null): readonly PermissionNeed[] | null => {
  const path = GIT_REPO.exec(url.pathname)?.[1]
  if (!path) return null
  if (path === '/info/refs') return [['contents', url.searchParams.get('service') === 'git-receive-pack' ? 'write' : 'read']]
  if (path === '/git-receive-pack' || path.startsWith('/forge/uploads')) return [['contents', 'write']]
  if (path === '/git-upload-pack' || path === '/HEAD' || path.startsWith('/objects/')) return [['contents', 'read']]
  if (path === '/info/lfs/objects/batch') return [['contents', lfsOperation === 'download' ? 'read' : 'write']]
  if (path.startsWith('/info/lfs/')) return [['contents', READ_METHODS.has(method) ? 'read' : 'write']]
  if (/^\/(raw|media|archive|releases\/download)\//.test(path)) return READ_METHODS.has(method) ? [['contents', 'read']] : null
  return null
}

export const isLfsBatchPath = (pathname: string): boolean => /\/info\/lfs\/objects\/batch$/.test(pathname)

export const installationNeeds = (method: string, url: URL, lfsOperation: string | null = null): readonly PermissionNeed[] | null => {
  const api = /^\/api(?:\/v3)?(\/.*?)\/?$/.exec(url.pathname)
  if (!api) return gitNeeds(method, url, lfsOperation)
  const path = api[1]!
  const repo = /^\/repos\/[^/]+\/[^/]+(\/.*)?$/.exec(path)
  return repo ? fromRules(REPO_RULES, repo[1] ?? '', method) : fromRules(GLOBAL_RULES, path, method)
}

const RANK: Readonly<Record<PermissionLevel, number>> = { read: 1, write: 2, admin: 3 }

export const grantsNeed = (permissions: AppPermissions, need: PermissionNeed): boolean =>
  need[0] === 'metadata' && need[1] === 'read' ? true : permissions[need[0]] !== undefined && RANK[permissions[need[0]]!] >= RANK[need[1]]

export const missingPermission = (permissions: AppPermissions, needs: readonly PermissionNeed[] | null): string | null => {
  if (needs === null) return 'this endpoint is not available to installation tokens'
  const missing = needs.find((need) => !grantsNeed(permissions, need))
  return missing ? `this installation token needs ${missing[0]}: ${missing[1]}` : null
}

const WORKFLOWS = ['.github', 'workflows']

export const WORKFLOWS_REFUSAL = 'refusing to allow a GitHub App to create or update workflow files without the workflows permission'

export const workflowCheck =
  (odb: ObjectDatabase, base: () => Promise<ObjectId | null>): RefCheck =>
  async (command) => {
    if (command.newId === ZERO_ID) return null
    const before = command.oldId !== ZERO_ID ? command.oldId : await base()
    const prior = before ? await pathIdAt(odb, before, WORKFLOWS) : null
    return (await pathIdAt(odb, command.newId, WORKFLOWS)) === prior ? null : WORKFLOWS_REFUSAL
  }
