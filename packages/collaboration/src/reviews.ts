import { atLeast, type Database, first, type Principal, resolveAccess, sql, type Statement } from '@git-forge/accounts'
import { diffFile, diffTrees, type FileDiff, formatHunks, type Hunk, isObjectId, mergeBases, type ObjectId, parseCommit, resolvePath } from '@git-forge/core'
import { loadUsers, type UserSummary } from './actors.ts'
import { type ActorRef, emitActivity, invalid, nodeId, notFound, refFromColumns, requirePermission, sameActor, type Scope } from './context.ts'
import { branchTip, currentRefs, objectDatabase, peelToCommit } from './git.ts'
import { eventStatement, optionalBody, requireBody } from './issues.ts'
import { type PullRow, pullRow, refreshPull } from './pull-rows.ts'

export type ReviewState = 'PENDING' | 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED' | 'DISMISSED'

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'

export type Review = {
  readonly id: number
  readonly nodeId: string
  readonly pullNumber: number
  readonly author: UserSummary
  readonly authorRef: ActorRef | null
  readonly state: ReviewState
  readonly body: string | null
  readonly commitId: ObjectId
  readonly createdAt: number
  readonly submittedAt: number | null
  readonly dismissedAt: number | null
  readonly dismissalMessage: string | null
}

export type Side = 'LEFT' | 'RIGHT'

export type ReviewComment = {
  readonly id: number
  readonly nodeId: string
  readonly pullNumber: number
  readonly reviewId: number
  readonly author: UserSummary
  readonly authorRef: ActorRef | null
  readonly commitId: ObjectId
  readonly originalCommitId: ObjectId
  readonly path: string
  readonly line: number | null
  readonly originalLine: number
  readonly side: Side
  readonly startLine: number | null
  readonly originalStartLine: number | null
  readonly startSide: Side | null
  readonly inReplyToId: number | null
  readonly body: string
  readonly diffHunk: string
  readonly outdated: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

type ReviewRow = {
  id: number
  node_id: string
  issue_id: number
  number: number
  author_kind: string
  author_id: string
  state: ReviewState
  body: string | null
  commit_id: string
  created_at: number
  submitted_at: number | null
  dismissed_at: number | null
  dismissal_message: string | null
}

type CommentRow = {
  id: number
  node_id: string
  issue_id: number
  number: number
  review_id: number
  review_state: ReviewState
  author_kind: string
  author_id: string
  commit_id: string
  path: string
  line: number
  side: Side
  start_line: number | null
  start_side: Side | null
  in_reply_to_id: number | null
  body: string
  created_at: number
  updated_at: number
}

const REVIEW_SELECT = 'SELECT r.id, r.node_id, r.issue_id, i.number, r.author_kind, r.author_id, r.state, r.body, r.commit_id, r.created_at, r.submitted_at, r.dismissed_at, r.dismissal_message FROM pull_request_reviews r JOIN issues i ON i.id = r.issue_id'

const COMMENT_SELECT = `SELECT c.id, c.node_id, c.issue_id, i.number, c.review_id, r.state AS review_state, c.author_kind, c.author_id, c.commit_id, c.path, c.line, c.side,
  c.start_line, c.start_side, c.in_reply_to_id, c.body, c.created_at, c.updated_at FROM review_comments c JOIN issues i ON i.id = c.issue_id JOIN pull_request_reviews r ON r.id = c.review_id`

const hydrateReviews = async (db: Database, rows: readonly ReviewRow[]): Promise<Review[]> => {
  const users = await loadUsers(db, rows.map((row) => ({ kind: row.author_kind, id: row.author_id })))
  return rows.map((row) => ({
    id: row.id,
    nodeId: row.node_id,
    pullNumber: row.number,
    author: users({ kind: row.author_kind, id: row.author_id }),
    authorRef: refFromColumns(row.author_kind, row.author_id),
    state: row.state,
    body: row.body,
    commitId: row.commit_id,
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
    dismissedAt: row.dismissed_at,
    dismissalMessage: row.dismissal_message,
  }))
}

const visibleTo = (scope: Scope, row: { state: ReviewState; author_kind: string; author_id: string }): boolean =>
  row.state !== 'PENDING' || sameActor(scope.actor.ref, refFromColumns(row.author_kind, row.author_id))

const fresh = async (scope: Scope, number: number): Promise<PullRow> => refreshPull(scope, await pullRow(scope, number), await currentRefs(scope), null)

export const listReviews = async (scope: Scope, number: number): Promise<Review[]> => {
  const pull = await pullRow(scope, number)
  const rows = await scope.db.all<ReviewRow>(sql(`${REVIEW_SELECT} WHERE r.issue_id = ? ORDER BY r.id`, pull.id))
  return hydrateReviews(scope.db, rows.filter((row) => visibleTo(scope, row)))
}

const reviewRow = async (scope: Scope, pull: PullRow, id: number): Promise<ReviewRow> => {
  const row = await first<ReviewRow>(scope.db, sql(`${REVIEW_SELECT} WHERE r.id = ? AND r.issue_id = ?`, id, pull.id))
  if (!row || !visibleTo(scope, row)) throw notFound()
  return row
}

export const getReview = async (scope: Scope, number: number, id: number): Promise<Review> => {
  const pull = await pullRow(scope, number)
  return (await hydrateReviews(scope.db, [await reviewRow(scope, pull, id)]))[0]!
}

const commitDiffBase = async (scope: Scope, pull: PullRow, commit: ObjectId): Promise<ObjectId | null> => {
  const odb = objectDatabase(scope)
  const base = pull.merged_at === null ? (branchTip(await currentRefs(scope), pull.base_ref) ?? pull.base_sha) : pull.base_sha
  const bases = await mergeBases(odb, base, commit)
  return bases[0] ?? null
}

const treeOf = async (scope: Scope, commit: ObjectId | null): Promise<ObjectId | null> => {
  if (commit === null) return null
  const object = await objectDatabase(scope).read(commit)
  return object?.type === 'commit' ? parseCommit(object.data).tree : null
}

const fileDiffAt = async (scope: Scope, pull: PullRow, commit: ObjectId, path: string): Promise<FileDiff | null> => {
  const odb = objectDatabase(scope)
  const changes = await diffTrees(odb, await treeOf(scope, await commitDiffBase(scope, pull, commit)), await treeOf(scope, commit))
  const change = changes.find((candidate) => candidate.path === path)
  return change ? diffFile(odb, change) : null
}

const lineIn = (hunks: readonly Hunk[], line: number, side: Side): { hunk: Hunk; index: number } | null => {
  for (const hunk of hunks) {
    const index = hunk.lines.findIndex((entry) => (side === 'RIGHT' ? entry.newLine === line : entry.oldLine === line && entry.kind !== '+'))
    if (index !== -1) return { hunk, index }
  }
  return null
}

const diffHunkFor = (file: FileDiff | null, line: number, side: Side): string => {
  if (!file) return ''
  const found = lineIn(file.hunks, line, side)
  if (!found) return ''
  const partial: Hunk = { ...found.hunk, lines: found.hunk.lines.slice(0, found.index + 1) }
  return formatHunks([partial]).replace(/\n$/, '')
}

export type CommentAnchor = {
  readonly path: unknown
  readonly line: unknown
  readonly side?: unknown
  readonly startLine?: unknown
  readonly startSide?: unknown
}

export type ValidAnchor = { path: string; line: number; side: Side; startLine: number | null; startSide: Side | null }

const sideOf = (value: unknown, fallback: Side): Side => {
  if (value === undefined || value === null) return fallback
  if (value !== 'LEFT' && value !== 'RIGHT') throw invalid('side must be LEFT or RIGHT')
  return value
}

export const validateAnchor = async (scope: Scope, pull: PullRow, commit: ObjectId, anchor: CommentAnchor): Promise<ValidAnchor> => {
  if (typeof anchor.path !== 'string' || anchor.path === '') throw invalid('path is required')
  if (typeof anchor.line !== 'number' || !Number.isSafeInteger(anchor.line) || anchor.line < 1) throw invalid('line must be a positive integer')
  const side = sideOf(anchor.side, 'RIGHT')
  const startLine = anchor.startLine === undefined || anchor.startLine === null ? null : anchor.startLine
  if (startLine !== null && (typeof startLine !== 'number' || !Number.isSafeInteger(startLine) || startLine < 1)) throw invalid('start_line must be a positive integer')
  const startSide = startLine === null ? null : sideOf(anchor.startSide, side)
  const file = await fileDiffAt(scope, pull, commit, anchor.path)
  if (!file) throw invalid('pull_request_review_thread.path must be part of the diff')
  if (!lineIn(file.hunks, anchor.line, side)) throw invalid('pull_request_review_thread.line must be part of the diff')
  if (startLine !== null) {
    if (!lineIn(file.hunks, startLine, startSide!)) throw invalid('pull_request_review_thread.start_line must be part of the diff')
    if (startSide === side && startLine > anchor.line) throw invalid('pull_request_review_thread.start_line must precede the end line')
  }
  return { path: anchor.path, line: anchor.line, side, startLine: startLine as number | null, startSide }
}

const hydrateComments = async (scope: Scope, rows: readonly CommentRow[]): Promise<ReviewComment[]> => {
  const users = await loadUsers(scope.db, rows.map((row) => ({ kind: row.author_kind, id: row.author_id })))
  const odb = objectDatabase(scope)
  const pulls = new Map<number, PullRow>()
  const files = new Map<string, FileDiff | null>()
  const blobs = new Map<string, string | null>()
  const blobAt = async (commit: ObjectId, path: string) => {
    const key = `${commit}:${path}`
    if (!blobs.has(key)) blobs.set(key, (await resolvePath(odb, commit, path.split('/')))?.id ?? null)
    return blobs.get(key)!
  }
  const result: ReviewComment[] = []
  for (const row of rows) {
    if (!pulls.has(row.number)) pulls.set(row.number, await fresh(scope, row.number))
    const pull = pulls.get(row.number)!
    const fileKey = `${row.number}:${row.commit_id}:${row.path}`
    if (!files.has(fileKey)) files.set(fileKey, await fileDiffAt(scope, pull, row.commit_id, row.path).catch(() => null))
    const current = pull.head_sha
    const outdated = current !== row.commit_id && (await blobAt(row.commit_id, row.path)) !== (await blobAt(current, row.path))
    result.push({
      id: row.id,
      nodeId: row.node_id,
      pullNumber: row.number,
      reviewId: row.review_id,
      author: users({ kind: row.author_kind, id: row.author_id }),
      authorRef: refFromColumns(row.author_kind, row.author_id),
      commitId: outdated ? row.commit_id : current,
      originalCommitId: row.commit_id,
      path: row.path,
      line: outdated ? null : row.line,
      originalLine: row.line,
      side: row.side,
      startLine: outdated ? null : row.start_line,
      originalStartLine: row.start_line,
      startSide: row.start_side,
      inReplyToId: row.in_reply_to_id,
      body: row.body,
      diffHunk: diffHunkFor(files.get(fileKey) ?? null, row.line, row.side),
      outdated,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })
  }
  return result
}

export const listReviewComments = async (scope: Scope, number: number | null, filter: { readonly reviewId?: number } = {}): Promise<ReviewComment[]> => {
  const where = ['i.repository_id = ?', 'c.deleted_at IS NULL']
  const params: (string | number)[] = [scope.repository.id]
  if (number !== null) {
    await pullRow(scope, number)
    where.push('i.number = ?')
    params.push(number)
  }
  if (filter.reviewId !== undefined) {
    where.push('c.review_id = ?')
    params.push(filter.reviewId)
  }
  const rows = await scope.db.all<CommentRow>(sql(`${COMMENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.id`, ...params))
  return hydrateComments(
    scope,
    rows.filter((row) => visibleTo(scope, { state: row.review_state, author_kind: row.author_kind, author_id: row.author_id })),
  )
}

const commentRow = async (scope: Scope, id: number, includeDeleted = false): Promise<CommentRow> => {
  const row = await first<CommentRow>(scope.db, sql(`${COMMENT_SELECT} WHERE c.id = ? AND i.repository_id = ?${includeDeleted ? '' : ' AND c.deleted_at IS NULL'}`, id, scope.repository.id))
  if (!row || !visibleTo(scope, { state: row.review_state, author_kind: row.author_kind, author_id: row.author_id })) throw notFound()
  return row
}

export const getReviewComment = async (scope: Scope, id: number, includeDeleted = false): Promise<ReviewComment> => (await hydrateComments(scope, [await commentRow(scope, id, includeDeleted)]))[0]!

const reviewCommit = async (scope: Scope, pull: PullRow, commitId: unknown): Promise<ObjectId> => {
  if (commitId === undefined || commitId === null) return pull.head_sha
  if (typeof commitId !== 'string' || !isObjectId(commitId) || !(await peelToCommit(objectDatabase(scope), commitId))) throw invalid('commit_id is not part of the pull request')
  return commitId
}

const EVENT_STATE: Readonly<Record<ReviewEvent, ReviewState>> = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }

const eventOf = (value: unknown): ReviewEvent | null => {
  if (value === undefined || value === null || value === '' || value === 'PENDING') return null
  if (value !== 'APPROVE' && value !== 'REQUEST_CHANGES' && value !== 'COMMENT') throw invalid('event must be APPROVE, REQUEST_CHANGES or COMMENT')
  return value
}

const checkSubmission = (pull: PullRow, author: ActorRef, event: ReviewEvent, body: string | null, comments: number) => {
  const own = refFromColumns(pull.author_kind, pull.author_id)
  if (event !== 'COMMENT' && own && sameActor(own, author)) {
    throw invalid(event === 'APPROVE' ? 'Can not approve your own pull request' : 'Can not request changes on your own pull request')
  }
  if (event !== 'COMMENT' && pull.state !== 'open') throw invalid(`Can not ${event === 'APPROVE' ? 'approve' : 'request changes on'} a closed pull request`)
  if (event === 'REQUEST_CHANGES' && (body === null || body.trim() === '')) throw invalid('Review body is required when requesting changes')
  if (event === 'COMMENT' && (body === null || body.trim() === '') && comments === 0) throw invalid('Review body is required when commenting')
}

const submitStatements = (pull: PullRow, reviewId: number, author: ActorRef, event: ReviewEvent, at: number): Statement[] => [
  sql('DELETE FROM review_requests WHERE issue_id = ? AND user_id = ?', pull.id, author.kind === 'user' ? author.id : ''),
  eventStatement(pull.id, author, 'reviewed', { review_id: reviewId, state: EVENT_STATE[event].toLowerCase() }, at),
  sql('UPDATE issues SET updated_at = ? WHERE id = ?', at, pull.id),
]

export type ReviewInput = {
  readonly commitId?: unknown
  readonly body?: unknown
  readonly event?: unknown
  readonly comments?: readonly (CommentAnchor & { readonly body: unknown })[]
}

export const createReview = async (scope: Scope, number: number, input: ReviewInput): Promise<Review> => {
  const pull = await fresh(scope, number)
  const author = requirePermission(scope, 'review:submit', { locked: pull.locked === 1 })
  const event = eventOf(input.event)
  const body = optionalBody(input.body)
  const commit = await reviewCommit(scope, pull, input.commitId)
  const comments = []
  for (const comment of input.comments ?? []) comments.push({ ...(await validateAnchor(scope, pull, commit, comment)), body: requireBody(comment.body) })
  if (event) checkSubmission(pull, author, event, body, comments.length)
  else if (await first(scope.db, sql("SELECT id FROM pull_request_reviews WHERE issue_id = ? AND state = 'PENDING' AND author_kind = ? AND author_id = ?", pull.id, author.kind, author.id))) {
    throw invalid('You already have a pending review on this pull request')
  }
  const node = nodeId('PRR')
  const at = scope.now()
  await scope.db.run(
    sql(
      'INSERT INTO pull_request_reviews (node_id, issue_id, author_kind, author_id, state, body, commit_id, created_at, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      node,
      pull.id,
      author.kind,
      author.id,
      event ? EVENT_STATE[event] : 'PENDING',
      body,
      commit,
      at,
      event ? at : null,
    ),
  )
  const review = (await first<{ id: number }>(scope.db, sql('SELECT id FROM pull_request_reviews WHERE node_id = ?', node)))!
  await scope.db.batch([
    ...comments.map((comment) =>
      sql(
        `INSERT INTO review_comments (node_id, issue_id, review_id, author_kind, author_id, commit_id, path, line, side, start_line, start_side, body, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        nodeId('PRRC'),
        pull.id,
        review.id,
        author.kind,
        author.id,
        commit,
        comment.path,
        comment.line,
        comment.side,
        comment.startLine,
        comment.startSide,
        comment.body,
        at,
        at,
      ),
    ),
    ...(event ? submitStatements(pull, review.id, author, event, at) : []),
  ])
  if (event) await emitActivity(scope, { kind: 'pull_request_review', action: 'submitted', number, actor: author, reviewId: review.id })
  return getReview(scope, number, review.id)
}

export const submitReview = async (scope: Scope, number: number, id: number, input: { readonly event?: unknown; readonly body?: unknown }): Promise<Review> => {
  const pull = await fresh(scope, number)
  const author = requirePermission(scope, 'review:submit', { locked: pull.locked === 1 })
  const row = await reviewRow(scope, pull, id)
  if (row.state !== 'PENDING') throw invalid('This review has already been submitted')
  const event = eventOf(input.event)
  if (!event) throw invalid('event must be APPROVE, REQUEST_CHANGES or COMMENT')
  const body = input.body === undefined ? row.body : optionalBody(input.body)
  const comments = (await first<{ count: number }>(scope.db, sql('SELECT COUNT(*) AS count FROM review_comments WHERE review_id = ?', id)))?.count ?? 0
  checkSubmission(pull, author, event, body, comments)
  const at = scope.now()
  await scope.db.batch([
    sql('UPDATE pull_request_reviews SET state = ?, body = ?, submitted_at = ? WHERE id = ?', EVENT_STATE[event], body, at, id),
    ...submitStatements(pull, id, author, event, at),
  ])
  await emitActivity(scope, { kind: 'pull_request_review', action: 'submitted', number, actor: author, reviewId: id })
  return getReview(scope, number, id)
}

export const updateReviewBody = async (scope: Scope, number: number, id: number, body: unknown): Promise<Review> => {
  const pull = await pullRow(scope, number)
  const row = await reviewRow(scope, pull, id)
  const actor = requirePermission(scope, 'comment:edit', { author: refFromColumns(row.author_kind, row.author_id) })
  await scope.db.run(sql('UPDATE pull_request_reviews SET body = ? WHERE id = ?', requireBody(body), id))
  if (row.state !== 'PENDING') await emitActivity(scope, { kind: 'pull_request_review', action: 'edited', number, actor, reviewId: id, changes: { body: { from: row.body } } })
  return getReview(scope, number, id)
}

export const deletePendingReview = async (scope: Scope, number: number, id: number): Promise<Review> => {
  const pull = await pullRow(scope, number)
  const row = await reviewRow(scope, pull, id)
  requirePermission(scope, 'review:submit')
  if (row.state !== 'PENDING') throw invalid('Can not delete a submitted review')
  const [review] = await hydrateReviews(scope.db, [row])
  await scope.db.batch([sql('DELETE FROM review_comments WHERE review_id = ?', id), sql('DELETE FROM pull_request_reviews WHERE id = ?', id)])
  return review!
}

export const dismissReview = async (scope: Scope, number: number, id: number, message: unknown): Promise<Review> => {
  const actor = requirePermission(scope, 'review:dismiss')
  const pull = await pullRow(scope, number)
  const row = await reviewRow(scope, pull, id)
  if (row.state !== 'APPROVED' && row.state !== 'CHANGES_REQUESTED') throw invalid(`Can not dismiss a ${row.state.toLowerCase().replace('_', ' ')} pull request review`)
  const text = requireBody(message)
  const at = scope.now()
  await scope.db.batch([
    sql(
      "UPDATE pull_request_reviews SET state = 'DISMISSED', dismissed_at = ?, dismissed_by_kind = ?, dismissed_by_id = ?, dismissal_message = ? WHERE id = ?",
      at,
      actor.kind,
      actor.id,
      text,
      id,
    ),
    eventStatement(pull.id, actor, 'review_dismissed', { dismissed_review: { review_id: id, state: row.state.toLowerCase(), dismissal_message: text } }, at),
  ])
  await emitActivity(scope, { kind: 'pull_request_review', action: 'dismissed', number, actor, reviewId: id })
  return getReview(scope, number, id)
}

export type ReviewCommentInput = CommentAnchor & {
  readonly body: unknown
  readonly commitId?: unknown
  readonly inReplyTo?: unknown
}

export const createReviewComment = async (scope: Scope, number: number, input: ReviewCommentInput): Promise<ReviewComment> => {
  const pull = await fresh(scope, number)
  const author = requirePermission(scope, 'review:submit', { locked: pull.locked === 1 })
  const body = requireBody(input.body)
  let anchor: ValidAnchor
  let commit: ObjectId
  let replyTo: number | null = null
  if (input.inReplyTo !== undefined && input.inReplyTo !== null) {
    if (typeof input.inReplyTo !== 'number') throw invalid('in_reply_to must be a comment id')
    const parent = await commentRow(scope, input.inReplyTo)
    if (parent.number !== number) throw invalid('in_reply_to must be a comment of this pull request')
    replyTo = parent.in_reply_to_id ?? parent.id
    anchor = { path: parent.path, line: parent.line, side: parent.side, startLine: parent.start_line, startSide: parent.start_side }
    commit = parent.commit_id
  } else {
    commit = await reviewCommit(scope, pull, input.commitId)
    anchor = await validateAnchor(scope, pull, commit, input)
  }
  const reviewNode = nodeId('PRR')
  const commentNode = nodeId('PRRC')
  const at = scope.now()
  await scope.db.batch([
    sql(
      "INSERT INTO pull_request_reviews (node_id, issue_id, author_kind, author_id, state, body, commit_id, created_at, submitted_at) VALUES (?, ?, ?, ?, 'COMMENTED', NULL, ?, ?, ?)",
      reviewNode,
      pull.id,
      author.kind,
      author.id,
      commit,
      at,
      at,
    ),
    sql(
      `INSERT INTO review_comments (node_id, issue_id, review_id, author_kind, author_id, commit_id, path, line, side, start_line, start_side, in_reply_to_id, body, created_at, updated_at)
       SELECT ?, ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM pull_request_reviews WHERE node_id = ?`,
      commentNode,
      pull.id,
      author.kind,
      author.id,
      commit,
      anchor.path,
      anchor.line,
      anchor.side,
      anchor.startLine,
      anchor.startSide,
      replyTo,
      body,
      at,
      at,
      reviewNode,
    ),
    sql('UPDATE issues SET updated_at = ? WHERE id = ?', at, pull.id),
  ])
  const created = (await first<{ id: number }>(scope.db, sql('SELECT id FROM review_comments WHERE node_id = ?', commentNode)))!
  await emitActivity(scope, { kind: 'pull_request_review_comment', action: 'created', number, actor: author, commentId: created.id })
  return getReviewComment(scope, created.id)
}

export const updateReviewComment = async (scope: Scope, id: number, body: unknown): Promise<ReviewComment> => {
  const row = await commentRow(scope, id)
  const actor = requirePermission(scope, 'comment:edit', { author: refFromColumns(row.author_kind, row.author_id) })
  await scope.db.run(sql('UPDATE review_comments SET body = ?, updated_at = ? WHERE id = ?', requireBody(body), scope.now(), id))
  await emitActivity(scope, { kind: 'pull_request_review_comment', action: 'edited', number: row.number, actor, commentId: id, changes: { body: { from: row.body } } })
  return getReviewComment(scope, id)
}

export const deleteReviewComment = async (scope: Scope, id: number): Promise<void> => {
  const row = await commentRow(scope, id)
  const actor = requirePermission(scope, 'comment:edit', { author: refFromColumns(row.author_kind, row.author_id) })
  await scope.db.run(sql('UPDATE review_comments SET deleted_at = ?, updated_at = ? WHERE id = ?', scope.now(), scope.now(), id))
  await emitActivity(scope, { kind: 'pull_request_review_comment', action: 'deleted', number: row.number, actor, commentId: id, deleted: true })
}

export const accessOf = async (scope: Scope, ref: ActorRef): Promise<ReturnType<typeof resolveAccess>> => {
  if (ref.kind === 'app') {
    const principal: Principal = { kind: 'app', id: ref.id, slug: '', limits: { ceiling: 'admin', repositoryIds: null }, tokenId: '' }
    return resolveAccess(principal, scope.repository, await scope.accounts.grantsFor(principal, scope.repository))
  }
  const principal: Principal = { kind: 'user', id: ref.id, login: '', limits: null, tokenId: null }
  if (await scope.accounts.isInstanceAdmin(ref.id)) return 'admin'
  return resolveAccess(principal, scope.repository, await scope.accounts.grantsFor(principal, scope.repository))
}

export const listRequestedReviewers = async (scope: Scope, number: number): Promise<UserSummary[]> => {
  const pull = await pullRow(scope, number)
  const rows = await scope.db.all<{ user_id: string }>(sql('SELECT user_id FROM review_requests WHERE issue_id = ? ORDER BY created_at, rowid', pull.id))
  const users = await loadUsers(scope.db, rows.map((row) => ({ kind: 'user', id: row.user_id })))
  return rows.map((row) => users({ kind: 'user', id: row.user_id }))
}

export const changeRequestedReviewers = async (scope: Scope, number: number, logins: readonly string[], mode: 'add' | 'remove'): Promise<UserSummary[]> => {
  const actor = requirePermission(scope, 'review:request')
  const pull = await pullRow(scope, number)
  const author = refFromColumns(pull.author_kind, pull.author_id)
  const at = scope.now()
  const statements: Statement[] = []
  for (const login of logins) {
    const account = await scope.accounts.findAccount(login)
    if (!account || account.kind !== 'user') throw invalid(`Reviews may only be requested from collaborators. ${login} is not a collaborator.`)
    const ref: ActorRef = { kind: 'user', id: account.id }
    if (mode === 'add') {
      if (sameActor(ref, author)) throw invalid('Review cannot be requested from pull request author.')
      if (!atLeast(await accessOf(scope, ref), 'read')) throw invalid(`Reviews may only be requested from collaborators. ${login} is not a collaborator.`)
      statements.push(
        sql('INSERT OR IGNORE INTO review_requests (issue_id, user_id, created_at) VALUES (?, ?, ?)', pull.id, account.id, at),
        eventStatement(pull.id, actor, 'review_requested', { requested_reviewer: { login: account.login } }, at),
      )
    } else {
      statements.push(
        sql('DELETE FROM review_requests WHERE issue_id = ? AND user_id = ?', pull.id, account.id),
        eventStatement(pull.id, actor, 'review_request_removed', { requested_reviewer: { login: account.login } }, at),
      )
    }
  }
  if (statements.length > 0) await scope.db.batch(statements)
  for (const login of logins) await emitActivity(scope, { kind: 'pull_request', action: mode === 'add' ? 'review_requested' : 'review_request_removed', number, actor, requestedReviewer: login })
  return listRequestedReviewers(scope, number)
}

export type ReviewEvidence = {
  readonly approvals: number
  readonly changesRequested: boolean
  readonly lastPushApproved: boolean
  readonly approvers: readonly ActorRef[]
}

export const reviewEvidence = async (scope: Scope, pull: PullRow): Promise<ReviewEvidence> => {
  const rows = await scope.db.all<{ author_kind: string; author_id: string; state: ReviewState; commit_id: string }>(
    sql("SELECT author_kind, author_id, state, commit_id FROM pull_request_reviews WHERE issue_id = ? AND state IN ('APPROVED', 'CHANGES_REQUESTED', 'DISMISSED') ORDER BY submitted_at, id", pull.id),
  )
  const latest = new Map<string, { ref: ActorRef; state: ReviewState; commit: string }>()
  for (const row of rows) {
    const ref = refFromColumns(row.author_kind, row.author_id)
    if (ref) latest.set(`${ref.kind}:${ref.id}`, { ref, state: row.state, commit: row.commit_id })
  }
  const author = refFromColumns(pull.author_kind, pull.author_id)
  const pusher = refFromColumns(pull.last_pusher_kind, pull.last_pusher_id) ?? author
  const approvers: ActorRef[] = []
  let changesRequested = false
  let lastPushApproved = false
  for (const entry of latest.values()) {
    if (sameActor(entry.ref, author)) continue
    if (!atLeast(await accessOf(scope, entry.ref), 'write')) continue
    if (entry.state === 'APPROVED') {
      approvers.push(entry.ref)
      if (entry.commit === pull.head_sha && !sameActor(entry.ref, pusher)) lastPushApproved = true
    }
    if (entry.state === 'CHANGES_REQUESTED') changesRequested = true
  }
  return { approvals: approvers.length, changesRequested, lastPushApproved, approvers }
}
