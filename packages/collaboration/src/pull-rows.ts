import { selectProtectionRule, sql, type Statement, first } from '@git-forge/accounts'
import { type ObjectId, type ObjectSource, parseCommit, type RefsState } from '@git-forge/core'
import { actorColumns } from './actors.ts'
import { type EventActor, notFound, type Scope } from './context.ts'
import { branchName, branchTip, objectDatabase } from './git.ts'
import { eventStatement, type IssueRow } from './issues.ts'

export type PullRow = IssueRow & {
  head_ref: string
  base_ref: string
  head_sha: string
  base_sha: string
  draft: number
  last_pusher_kind: string | null
  last_pusher_id: string | null
  merged_at: number | null
  merged_by_kind: string | null
  merged_by_id: string | null
  merge_commit_sha: string | null
  merge_method: 'merge' | 'squash' | 'rebase' | null
  check_key: string | null
  check_result: string | null
}

export const PULL_SELECT = `SELECT i.*, p.head_ref, p.base_ref, p.head_sha, p.base_sha, p.draft, p.last_pusher_kind, p.last_pusher_id, p.merged_at, p.merged_by_kind,
  p.merged_by_id, p.merge_commit_sha, p.merge_method, p.check_key, p.check_result FROM issues i JOIN pull_requests p ON p.issue_id = i.id`

export const pullRow = async (scope: Scope, number: number): Promise<PullRow> => {
  const row = await first<PullRow>(scope.db, sql(`${PULL_SELECT} WHERE i.repository_id = ? AND i.number = ?`, scope.repository.id, number))
  if (!row) throw notFound()
  return row
}

const reloadPull = async (scope: Scope, id: number): Promise<PullRow> => (await first<PullRow>(scope.db, sql(`${PULL_SELECT} WHERE i.id = ?`, id)))!

export const WALK_LIMIT = 1000

export const reachesWithin = async (source: ObjectSource, from: ObjectId, target: ObjectId, limit = WALK_LIMIT): Promise<boolean> => {
  const seen = new Set<ObjectId>()
  const queue = [from]
  while (queue.length > 0 && seen.size < limit) {
    const id = queue.shift()!
    if (id === target) return true
    if (seen.has(id)) continue
    seen.add(id)
    const object = await source.read(id)
    if (object?.type === 'commit') queue.push(...parseCommit(object.data).parents)
  }
  return false
}

export const recentCommits = async (source: ObjectSource, from: ObjectId, stop: ObjectId, limit = 250): Promise<ObjectId[]> => {
  const seen = new Set<ObjectId>([stop])
  const order: ObjectId[] = []
  const queue = [from]
  while (queue.length > 0 && order.length < limit) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const object = await source.read(id)
    if (object?.type !== 'commit') continue
    order.push(id)
    queue.push(...parseCommit(object.data).parents)
  }
  return order
}

export const dismissStatements = async (scope: Scope, row: PullRow, actor: EventActor, message: string, at: number): Promise<Statement[]> => {
  const approvals = await scope.db.all<{ id: number; author_kind: string; author_id: string }>(
    sql("SELECT id, author_kind, author_id FROM pull_request_reviews WHERE issue_id = ? AND state = 'APPROVED'", row.id),
  )
  const [kind, id] = actorColumns(actor)
  return approvals.flatMap((review) => [
    sql(
      "UPDATE pull_request_reviews SET state = 'DISMISSED', dismissed_at = ?, dismissed_by_kind = ?, dismissed_by_id = ?, dismissal_message = ? WHERE id = ?",
      at,
      kind,
      id,
      message,
      review.id,
    ),
    eventStatement(row.id, actor, 'review_dismissed', { dismissed_review: { review_id: review.id, state: 'approved', dismissal_message: message } }, at),
  ])
}

export const refreshPull = async (scope: Scope, row: PullRow, state: RefsState, pusher: EventActor | null): Promise<PullRow> => {
  if (row.merged_at !== null || row.state !== 'open') return row
  const head = branchTip(state, row.head_ref)
  const base = branchTip(state, row.base_ref)
  const odb = objectDatabase(scope)
  const at = scope.now()
  const actor = pusher ?? { kind: 'system', id: null }
  const statements: Statement[] = []
  if (head !== null && head !== row.head_sha) {
    const forced = !(await reachesWithin(odb, head, row.head_sha))
    const [kind, id] = pusher ? actorColumns(pusher) : [null, null]
    statements.push(
      sql('UPDATE pull_requests SET head_sha = ?, last_pusher_kind = ?, last_pusher_id = ? WHERE issue_id = ?', head, kind, id, row.id),
      sql('UPDATE issues SET updated_at = ? WHERE id = ?', at, row.id),
      eventStatement(row.id, actor, forced ? 'head_ref_force_pushed' : 'synchronize', { before: row.head_sha, after: head }, at),
    )
    const rules = await scope.accounts.branchProtectionRules(scope.repository.id)
    const rule = selectProtectionRule(rules, branchName(row.base_ref))
    if (rule?.requiredPullRequestReviews?.dismissStaleReviews) statements.push(...(await dismissStatements(scope, row, actor, 'New commits were pushed', at)))
  }
  const mergedManually = head !== null && base !== null && base !== row.base_sha && (await reachesWithin(odb, base, head))
  if (mergedManually) {
    const [kind, id] = actorColumns(actor)
    statements.push(
      sql(
        "UPDATE pull_requests SET merged_at = ?, merged_by_kind = ?, merged_by_id = ?, merge_commit_sha = ? WHERE issue_id = ?",
        at,
        kind,
        id,
        base,
        row.id,
      ),
      sql("UPDATE issues SET state = 'closed', closed_at = ?, closed_by_kind = ?, closed_by_id = ?, updated_at = ? WHERE id = ?", at, kind, id, at, row.id),
      eventStatement(row.id, actor, 'merged', { commit_id: base }, at),
      eventStatement(row.id, actor, 'closed', { commit_id: base }, at),
    )
  } else if (base !== null && base !== row.base_sha) {
    statements.push(sql('UPDATE pull_requests SET base_sha = ? WHERE issue_id = ?', base, row.id))
  }
  if (statements.length === 0) return row
  await scope.db.batch(statements)
  return reloadPull(scope, row.id)
}
