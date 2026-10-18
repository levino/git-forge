import { first, sql, type Statement } from '@git-forge/accounts'
import { EXTERNAL_PREFIX } from './actors.ts'
import { type ActorRef, CollaborationError, nodeId, requirePermission, type Scope } from './context.ts'
import { branchRef, objectDatabase } from './git.ts'
import { type IssueState, MAX_BODY, MAX_TITLE, type StateReason } from './issues.ts'
import { PULL_SELECT, type PullRow } from './pull-rows.ts'
import { type ReviewState, type Side, validateAnchor } from './reviews.ts'

export type ImportedUser = { readonly login: string; readonly ref: ActorRef | null }

export type ImportOrigin = {
  readonly source: string
  readonly url: string | null
  readonly author: ImportedUser
  readonly createdAt: number
  readonly updatedAt: number
}

export type ImportedPull = {
  readonly headRef: string
  readonly baseRef: string
  readonly headSha: string
  readonly baseSha: string
  readonly draft: boolean
  readonly mergedAt: number | null
  readonly mergeCommitSha: string | null
}

export type ImportedIssue = ImportOrigin & {
  readonly number: number
  readonly title: string
  readonly body: string | null
  readonly state: IssueState
  readonly stateReason: StateReason | null
  readonly locked: boolean
  readonly lockReason: string | null
  readonly labels: readonly string[]
  readonly assignees: readonly ImportedUser[]
  readonly milestone: number | null
  readonly closedAt: number | null
  readonly pull?: ImportedPull
}

export type ImportedMilestone = {
  readonly number: number
  readonly title: string
  readonly description: string | null
  readonly state: IssueState
  readonly dueOn: number | null
  readonly creator: ImportedUser
  readonly createdAt: number
  readonly updatedAt: number
  readonly closedAt: number | null
}

export type ImportedReviewComment = ImportOrigin & {
  readonly review: string
  readonly inReplyTo: string | null
  readonly commitId: string
  readonly path: string
  readonly line: number | null
  readonly side: Side
  readonly startLine: number | null
  readonly startSide: Side | null
  readonly body: string
}

const REVIEW_STATES: readonly ReviewState[] = ['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']

const columns = (user: ImportedUser): [string, string] => (user.ref ? [user.ref.kind, user.ref.id] : ['user', `${EXTERNAL_PREFIX}${user.login}`])

const origin = (scope: Scope, node: string, item: ImportOrigin, assignees: readonly string[] = []): Statement =>
  sql(
    'INSERT INTO imported_items (node_id, repository_id, source, url, author, created_at, assignees) VALUES (?, ?, ?, ?, ?, ?, ?)',
    node,
    scope.repository.id,
    item.source,
    item.url,
    item.author.login,
    item.createdAt,
    JSON.stringify(assignees),
  )

export const mapImportedUser = async (scope: Scope, login: string, email?: string | null): Promise<ImportedUser> => {
  const account = await scope.accounts.findAccount(login)
  if (account?.kind === 'user') return { login, ref: { kind: 'user', id: account.id } }
  const match = email ? await first<{ id: string }>(scope.db, sql("SELECT id FROM accounts WHERE kind = 'user' AND email = ? COLLATE NOCASE AND disabled_at IS NULL LIMIT 1", email)) : null
  return { login, ref: match ? { kind: 'user', id: match.id } : null }
}

export const importedNode = async (scope: Scope, source: string): Promise<string | null> =>
  (await first<{ node_id: string }>(scope.db, sql('SELECT node_id FROM imported_items WHERE repository_id = ? AND source = ?', scope.repository.id, source)))?.node_id ?? null

const importedPull = (scope: Scope, number: number): Promise<PullRow | null> =>
  first<PullRow>(scope.db, sql(`${PULL_SELECT} JOIN imported_items m ON m.node_id = i.node_id WHERE i.repository_id = ? AND i.number = ?`, scope.repository.id, number))

export const nextImportedPull = async (scope: Scope, after: number): Promise<number | null> =>
  (
    await first<{ number: number }>(
      scope.db,
      sql(
        'SELECT i.number FROM issues i JOIN pull_requests p ON p.issue_id = i.id JOIN imported_items m ON m.node_id = i.node_id WHERE i.repository_id = ? AND i.number > ? ORDER BY i.number LIMIT 1',
        scope.repository.id,
        after,
      ),
    )
  )?.number ?? null

export const importLabel = async (scope: Scope, label: { readonly name: string; readonly color: string; readonly description: string | null }): Promise<boolean> => {
  requirePermission(scope, 'import')
  const color = /^[0-9a-fA-F]{6}$/.test(label.color) ? label.color : 'ededed'
  const result = await scope.db.run(
    sql('INSERT OR IGNORE INTO labels (node_id, repository_id, name, color, description, created_at) VALUES (?, ?, ?, ?, ?, ?)', nodeId('LA'), scope.repository.id, label.name, color, label.description, scope.now()),
  )
  return result.changes > 0
}

export const importMilestone = async (scope: Scope, milestone: ImportedMilestone): Promise<boolean> => {
  requirePermission(scope, 'import')
  const [kind, id] = columns(milestone.creator)
  const result = await scope.db.run(
    sql(
      `INSERT OR IGNORE INTO milestones (node_id, repository_id, number, title, description, state, due_on, creator_kind, creator_id, created_at, updated_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      nodeId('MI'),
      scope.repository.id,
      milestone.number,
      milestone.title,
      milestone.description,
      milestone.state,
      milestone.dueOn,
      kind,
      id,
      milestone.createdAt,
      milestone.updatedAt,
      milestone.closedAt,
    ),
  )
  return result.changes > 0
}

export const importIssue = async (scope: Scope, issue: ImportedIssue): Promise<'imported' | 'exists' | 'taken'> => {
  requirePermission(scope, 'import')
  if (await importedNode(scope, issue.source)) return 'exists'
  if (await first(scope.db, sql('SELECT 1 AS taken FROM repository_numbers WHERE repository_id = ? AND number = ?', scope.repository.id, issue.number))) return 'taken'
  const node = nodeId(issue.pull ? 'PR' : 'I')
  const [kind, id] = columns(issue.author)
  const pull = issue.pull
  await scope.db.batch([
    sql('INSERT INTO repository_numbers (repository_id, number, kind, node_id) VALUES (?, ?, ?, ?)', scope.repository.id, issue.number, pull ? 'pull' : 'issue', node),
    sql(
      `INSERT INTO issues (node_id, repository_id, number, is_pull, title, body, author_kind, author_id, state, state_reason, locked, lock_reason, milestone_id, created_at, updated_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM milestones WHERE repository_id = ? AND number = ?), ?, ?, ?)`,
      node,
      scope.repository.id,
      issue.number,
      pull ? 1 : 0,
      issue.title.slice(0, MAX_TITLE) || `#${issue.number}`,
      issue.body?.slice(0, MAX_BODY) ?? null,
      kind,
      id,
      issue.state,
      issue.stateReason,
      issue.locked ? 1 : 0,
      issue.lockReason,
      scope.repository.id,
      issue.milestone,
      issue.createdAt,
      issue.updatedAt,
      issue.closedAt,
    ),
    ...issue.labels.map((name) =>
      sql('INSERT OR IGNORE INTO issue_labels (issue_id, label_id, created_at) SELECT i.id, l.id, ? FROM issues i JOIN labels l ON l.repository_id = i.repository_id AND l.name = ? WHERE i.node_id = ?', issue.createdAt, name, node),
    ),
    ...issue.assignees.flatMap((user) =>
      user.ref?.kind === 'user' ? [sql('INSERT OR IGNORE INTO issue_assignees (issue_id, user_id, created_at) SELECT id, ?, ? FROM issues WHERE node_id = ?', user.ref.id, issue.createdAt, node)] : [],
    ),
    ...(pull
      ? [
          sql(
            'INSERT INTO pull_requests (issue_id, repository_id, head_ref, base_ref, head_sha, base_sha, draft, merged_at, merge_commit_sha) SELECT id, ?, ?, ?, ?, ?, ?, ?, ? FROM issues WHERE node_id = ?',
            scope.repository.id,
            branchRef(pull.headRef),
            branchRef(pull.baseRef),
            pull.headSha,
            pull.baseSha,
            pull.draft ? 1 : 0,
            pull.mergedAt,
            pull.mergeCommitSha,
            node,
          ),
        ]
      : []),
    origin(scope, node, issue, issue.assignees.filter((user) => user.ref?.kind !== 'user').map((user) => user.login)),
  ])
  return 'imported'
}

export const importComment = async (scope: Scope, number: number, comment: ImportOrigin & { readonly body: string }): Promise<boolean> => {
  requirePermission(scope, 'import')
  if (await importedNode(scope, comment.source)) return false
  const issue = await first<{ id: number }>(
    scope.db,
    sql('SELECT i.id FROM issues i JOIN imported_items m ON m.node_id = i.node_id WHERE i.repository_id = ? AND i.number = ?', scope.repository.id, number),
  )
  if (!issue) return false
  const node = nodeId('IC')
  const [kind, id] = columns(comment.author)
  await scope.db.batch([
    sql('INSERT INTO issue_comments (node_id, issue_id, author_kind, author_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', node, issue.id, kind, id, comment.body.slice(0, MAX_BODY), comment.createdAt, comment.updatedAt),
    sql('UPDATE issues SET comment_count = comment_count + 1 WHERE id = ?', issue.id),
    origin(scope, node, comment),
  ])
  return true
}

export const importReview = async (scope: Scope, number: number, review: ImportOrigin & { readonly state: string; readonly body: string | null; readonly commitId: string | null }): Promise<boolean> => {
  requirePermission(scope, 'import')
  if (!REVIEW_STATES.includes(review.state as ReviewState) || (await importedNode(scope, review.source))) return false
  const pull = await importedPull(scope, number)
  if (!pull) return false
  const node = nodeId('PRR')
  const [kind, id] = columns(review.author)
  await scope.db.batch([
    sql(
      'INSERT INTO pull_request_reviews (node_id, issue_id, author_kind, author_id, state, body, commit_id, created_at, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      node,
      pull.id,
      kind,
      id,
      review.state,
      review.body?.slice(0, MAX_BODY) || null,
      review.commitId ?? pull.head_sha,
      review.createdAt,
      review.createdAt,
    ),
    origin(scope, node, review),
  ])
  return true
}

const nodeRow = async <T extends Record<string, number | null>>(scope: Scope, table: string, source: string | null, fields: string): Promise<T | null> => {
  const node = source ? await importedNode(scope, source) : null
  return node ? first<T>(scope.db, sql(`SELECT ${fields} FROM ${table} WHERE node_id = ?`, node)) : null
}

export const importReviewComment = async (scope: Scope, number: number, comment: ImportedReviewComment): Promise<'imported' | 'exists' | 'unanchored'> => {
  requirePermission(scope, 'import')
  if (await importedNode(scope, comment.source)) return 'exists'
  const pull = await importedPull(scope, number)
  const review = await nodeRow<{ id: number }>(scope, 'pull_request_reviews', comment.review, 'id')
  if (!pull || !review || comment.line === null || !(await objectDatabase(scope).has(comment.commitId))) return 'unanchored'
  let anchor
  try {
    anchor = await validateAnchor(scope, pull, comment.commitId, comment)
  } catch (error) {
    if (error instanceof CollaborationError) return 'unanchored'
    throw error
  }
  const parent = await nodeRow<{ id: number; in_reply_to_id: number | null }>(scope, 'review_comments', comment.inReplyTo, 'id, in_reply_to_id')
  const node = nodeId('PRRC')
  const [kind, id] = columns(comment.author)
  await scope.db.batch([
    sql(
      `INSERT INTO review_comments (node_id, issue_id, review_id, author_kind, author_id, commit_id, path, line, side, start_line, start_side, in_reply_to_id, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      node,
      pull.id,
      review.id,
      kind,
      id,
      comment.commitId,
      anchor.path,
      anchor.line,
      anchor.side,
      anchor.startLine,
      anchor.startSide,
      parent ? (parent.in_reply_to_id ?? parent.id) : null,
      comment.body.slice(0, MAX_BODY),
      comment.createdAt,
      comment.updatedAt,
    ),
    origin(scope, node, comment),
  ])
  return 'imported'
}
