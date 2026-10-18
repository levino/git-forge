import { type CheckRun, type CombinedStatus, combinedStatus, listCheckRuns, type Scope } from '@git-forge/collaboration'

export type Checks = { readonly runs: readonly CheckRun[]; readonly statuses: CombinedStatus | null }

export const checksFor = async (scope: Scope, sha: string): Promise<Checks> => {
  const [runs, statuses] = await Promise.all([listCheckRuns(scope, sha, { latest: true }, { page: 1, perPage: 100 }), combinedStatus(scope, sha)])
  return { runs: runs.items, statuses: statuses.statuses.length > 0 ? statuses : null }
}

export const checkBadge = (status: string, conclusion: string | null): { readonly label: string; readonly badge: string } => {
  if (status !== 'completed') return { label: status.replace(/_/g, ' '), badge: 'badge-warning' }
  if (conclusion === 'success') return { label: 'success', badge: 'badge-success' }
  if (conclusion === 'neutral' || conclusion === 'skipped') return { label: conclusion, badge: 'badge-ghost' }
  return { label: conclusion ?? 'unknown', badge: 'badge-error' }
}

export const MERGE_LABELS = { merge: 'Create a merge commit', squash: 'Squash and merge', rebase: 'Rebase and merge' } as const
