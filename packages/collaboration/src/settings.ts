import { atLeast, sql } from '@git-forge/accounts'
import { invalid, readSettings, requirePermission, type Scope } from './context.ts'
import type { CollaborationSettings } from './permissions.ts'

export type SettingsInput = { readonly [K in keyof CollaborationSettings]?: unknown }

const KEYS: readonly (keyof CollaborationSettings)[] = ['hasIssues', 'hasDiscussions', 'readCanParticipate', 'allowMergeCommit', 'allowSquashMerge', 'allowRebaseMerge']

export const updateSettings = async (scope: Scope, input: SettingsInput): Promise<CollaborationSettings> => {
  requirePermission(scope, 'settings:manage')
  const next: Record<string, boolean> = { ...scope.settings }
  for (const key of KEYS) {
    const value = input[key]
    if (value === undefined) continue
    if (typeof value !== 'boolean') throw invalid(`${key} must be a boolean`)
    next[key] = value
  }
  const settings = next as CollaborationSettings
  if (!settings.allowMergeCommit && !settings.allowSquashMerge && !settings.allowRebaseMerge) throw invalid('at least one merge method must be allowed')
  const flag = (value: boolean) => (value ? 1 : 0)
  await scope.db.run(
    sql(
      `INSERT INTO collaboration_settings (repository_id, has_issues, has_discussions, read_can_participate, allow_merge_commit, allow_squash_merge, allow_rebase_merge, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repository_id) DO UPDATE SET has_issues = excluded.has_issues, has_discussions = excluded.has_discussions,
         read_can_participate = excluded.read_can_participate, allow_merge_commit = excluded.allow_merge_commit,
         allow_squash_merge = excluded.allow_squash_merge, allow_rebase_merge = excluded.allow_rebase_merge, updated_at = excluded.updated_at`,
      scope.repository.id,
      flag(settings.hasIssues),
      flag(settings.hasDiscussions),
      flag(settings.readCanParticipate),
      flag(settings.allowMergeCommit),
      flag(settings.allowSquashMerge),
      flag(settings.allowRebaseMerge),
      scope.now(),
    ),
  )
  return readSettings(scope.db, scope.repository.id)
}

export const rolePermissions = (scope: Scope) => ({
  admin: atLeast(scope.actor.access, 'admin'),
  maintain: atLeast(scope.actor.access, 'maintain'),
  push: atLeast(scope.actor.access, 'write'),
  triage: atLeast(scope.actor.access, 'triage'),
  pull: atLeast(scope.actor.access, 'read'),
})
