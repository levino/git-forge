import { type Access, atLeast, type Role } from '@git-forge/accounts'

export type CollaborationSettings = {
  readonly hasIssues: boolean
  readonly hasDiscussions: boolean
  readonly readCanParticipate: boolean
  readonly allowMergeCommit: boolean
  readonly allowSquashMerge: boolean
  readonly allowRebaseMerge: boolean
}

export const DEFAULT_SETTINGS: CollaborationSettings = {
  hasIssues: true,
  hasDiscussions: true,
  readCanParticipate: true,
  allowMergeCommit: true,
  allowSquashMerge: true,
  allowRebaseMerge: true,
}

export type Permission =
  | 'view'
  | 'issue:create'
  | 'issue:edit'
  | 'issue:close'
  | 'issue:triage'
  | 'issue:lock'
  | 'comment:create'
  | 'comment:edit'
  | 'label:manage'
  | 'milestone:manage'
  | 'pull:create'
  | 'pull:edit'
  | 'pull:close'
  | 'pull:merge'
  | 'review:submit'
  | 'reaction:create'
  | 'review:dismiss'
  | 'review:request'
  | 'status:write'
  | 'discussion:create'
  | 'discussion:edit'
  | 'discussion:close'
  | 'discussion:lock'
  | 'discussion:answer'
  | 'discussion:category'
  | 'settings:manage'
  | 'import'

export type PermissionSubject = {
  readonly access: Access
  readonly authenticated: boolean
  readonly writable: boolean
  readonly isAuthor?: boolean
  readonly locked?: boolean
  readonly settings: CollaborationSettings
}

type Rule = {
  readonly role: Role
  readonly author?: Role
  readonly participate?: boolean
  readonly feature?: 'issues' | 'discussions'
  readonly respectsLock?: boolean
  readonly mutation?: boolean
}

const RULES: Readonly<Record<Permission, Rule>> = {
  view: { role: 'read', mutation: false },
  'issue:create': { role: 'triage', participate: true, feature: 'issues' },
  'issue:edit': { role: 'write', author: 'read' },
  'issue:close': { role: 'triage', author: 'read' },
  'issue:triage': { role: 'triage' },
  'issue:lock': { role: 'triage' },
  'comment:create': { role: 'triage', participate: true, respectsLock: true },
  'comment:edit': { role: 'write', author: 'read' },
  'label:manage': { role: 'write' },
  'milestone:manage': { role: 'write' },
  'pull:create': { role: 'triage', participate: true },
  'pull:edit': { role: 'write', author: 'read' },
  'pull:close': { role: 'triage', author: 'read' },
  'pull:merge': { role: 'write' },
  'review:submit': { role: 'triage', participate: true, respectsLock: true },
  'review:dismiss': { role: 'write' },
  'reaction:create': { role: 'triage', participate: true, respectsLock: true },
  'review:request': { role: 'triage' },
  'status:write': { role: 'write' },
  'discussion:create': { role: 'triage', participate: true, feature: 'discussions' },
  'discussion:edit': { role: 'write', author: 'read' },
  'discussion:close': { role: 'triage', author: 'read' },
  'discussion:lock': { role: 'triage' },
  'discussion:answer': { role: 'triage', author: 'read' },
  'discussion:category': { role: 'maintain' },
  'settings:manage': { role: 'admin' },
  import: { role: 'admin' },
}

export const allowed = (permission: Permission, subject: PermissionSubject): boolean => {
  const rule = RULES[permission]
  if (!atLeast(subject.access, 'read')) return false
  if (rule.mutation !== false && (!subject.authenticated || !subject.writable)) return false
  if (rule.feature === 'issues' && !subject.settings.hasIssues) return false
  if (rule.feature === 'discussions' && !subject.settings.hasDiscussions) return false
  if (rule.respectsLock && subject.locked && !atLeast(subject.access, 'write')) return false
  if (atLeast(subject.access, rule.role)) return true
  if (rule.author && subject.isAuthor && atLeast(subject.access, rule.author)) return true
  return rule.participate === true && subject.settings.readCanParticipate
}

export const permissionTable = (): readonly { readonly permission: Permission; readonly role: Role; readonly author: Role | null; readonly participate: boolean }[] =>
  (Object.entries(RULES) as [Permission, Rule][]).map(([permission, rule]) => ({
    permission,
    role: rule.role,
    author: rule.author ?? null,
    participate: rule.participate === true,
  }))
