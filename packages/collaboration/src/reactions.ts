import { type Database, first, sql } from '@git-forge/accounts'
import { actorColumns, loadUsers, type UserSummary } from './actors.ts'
import { CollaborationError, invalid, nodeId, notFound, requirePermission, type Scope } from './context.ts'
import { allIn, issueRow } from './issues.ts'
import { getReviewComment } from './reviews.ts'

export const REACTIONS = ['+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes'] as const

export type ReactionContent = (typeof REACTIONS)[number]

export const REACTION_EMOJI: Readonly<Record<ReactionContent, string>> = { '+1': '👍', '-1': '👎', laugh: '😄', confused: '😕', heart: '❤️', hooray: '🎉', rocket: '🚀', eyes: '👀' }

export const REACTION_KINDS = ['issue', 'issue_comment', 'review_comment'] as const

export type ReactionKind = (typeof REACTION_KINDS)[number]

export type ReactionSubject = { readonly kind: ReactionKind; readonly id: number }

export type ReactionRollup = { readonly total: number; readonly counts: Readonly<Record<ReactionContent, number>> }

export type Reaction = { readonly id: number; readonly nodeId: string; readonly user: UserSummary; readonly content: ReactionContent; readonly createdAt: number }

type ReactionRow = { id: number; node_id: string; subject_id: number; user_kind: string; user_id: string; content: ReactionContent; created_at: number }

export const EMPTY_ROLLUP: ReactionRollup = { total: 0, counts: Object.fromEntries(REACTIONS.map((content) => [content, 0])) as Record<ReactionContent, number> }

export const reactionRollups = async (db: Database, kind: ReactionKind, ids: readonly number[]): Promise<Map<number, ReactionRollup>> => {
  const rows = await allIn<{ subject_id: number; content: ReactionContent; count: number }>(
    db,
    (marks) => `SELECT subject_id, content, COUNT(*) AS count FROM reactions WHERE subject_kind = ? AND subject_id IN (${marks}) GROUP BY subject_id, content`,
    ids,
    kind,
  )
  const rollups = new Map<number, ReactionRollup>()
  for (const row of rows) {
    const current = rollups.get(row.subject_id) ?? EMPTY_ROLLUP
    rollups.set(row.subject_id, { total: current.total + row.count, counts: { ...current.counts, [row.content]: row.count } })
  }
  return rollups
}

const isContent = (value: unknown): value is ReactionContent => typeof value === 'string' && (REACTIONS as readonly string[]).includes(value)

const resolveSubject = async (scope: Scope, subject: ReactionSubject): Promise<{ readonly id: number; readonly locked: boolean }> => {
  if (subject.kind === 'issue') {
    const row = await issueRow(scope, subject.id)
    return { id: row.id, locked: row.locked === 1 }
  }
  if (subject.kind === 'review_comment') {
    const comment = await getReviewComment(scope, subject.id)
    return { id: comment.id, locked: (await issueRow(scope, comment.pullNumber)).locked === 1 }
  }
  if (subject.kind !== 'issue_comment') throw notFound()
  const row = await first<{ id: number; locked: number }>(
    scope.db,
    sql('SELECT c.id, i.locked FROM issue_comments c JOIN issues i ON i.id = c.issue_id WHERE c.id = ? AND i.repository_id = ? AND c.deleted_at IS NULL', subject.id, scope.repository.id),
  )
  if (!row) throw notFound()
  return { id: row.id, locked: row.locked === 1 }
}

const hydrate = async (db: Database, rows: readonly ReactionRow[]): Promise<Reaction[]> => {
  const users = await loadUsers(db, rows.map((row) => ({ kind: row.user_kind, id: row.user_id })))
  return rows.map((row) => ({ id: row.id, nodeId: row.node_id, user: users({ kind: row.user_kind, id: row.user_id }), content: row.content, createdAt: row.created_at }))
}

const SELECT = 'SELECT id, node_id, subject_id, user_kind, user_id, content, created_at FROM reactions'

export const listReactions = async (scope: Scope, subject: ReactionSubject, content: string | null = null): Promise<Reaction[]> => {
  const { id } = await resolveSubject(scope, subject)
  if (content !== null && !isContent(content)) return []
  const rows = await scope.db.all<ReactionRow>(
    content === null
      ? sql(`${SELECT} WHERE subject_kind = ? AND subject_id = ? ORDER BY id`, subject.kind, id)
      : sql(`${SELECT} WHERE subject_kind = ? AND subject_id = ? AND content = ? ORDER BY id`, subject.kind, id, content),
  )
  return hydrate(scope.db, rows)
}

export const createReaction = async (scope: Scope, subject: ReactionSubject, content: unknown): Promise<{ readonly reaction: Reaction; readonly created: boolean }> => {
  const target = await resolveSubject(scope, subject)
  const actor = requirePermission(scope, 'reaction:create', { locked: target.locked })
  if (!isContent(content)) throw invalid(`content must be one of ${REACTIONS.join(', ')}`)
  const [kind, userId] = actorColumns(actor)
  const result = await scope.db.run(
    sql(
      'INSERT OR IGNORE INTO reactions (node_id, repository_id, subject_kind, subject_id, user_kind, user_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      nodeId('REA'),
      scope.repository.id,
      subject.kind,
      target.id,
      kind,
      userId,
      content,
      scope.now(),
    ),
  )
  const row = await first<ReactionRow>(scope.db, sql(`${SELECT} WHERE subject_kind = ? AND subject_id = ? AND user_kind = ? AND user_id = ? AND content = ?`, subject.kind, target.id, kind, userId, content))
  return { reaction: (await hydrate(scope.db, [row!]))[0]!, created: result.changes > 0 }
}

export const deleteReaction = async (scope: Scope, subject: ReactionSubject, reactionId: number): Promise<void> => {
  const target = await resolveSubject(scope, subject)
  const actor = requirePermission(scope, 'reaction:create', { locked: target.locked })
  const row = await first<ReactionRow>(scope.db, sql(`${SELECT} WHERE id = ? AND subject_kind = ? AND subject_id = ?`, reactionId, subject.kind, target.id))
  if (!row) throw notFound()
  if (row.user_kind !== actor.kind || row.user_id !== actor.id) throw new CollaborationError(403, 'Resource not accessible by integration')
  await scope.db.run(sql('DELETE FROM reactions WHERE id = ?', reactionId))
}

export const toggleReaction = async (scope: Scope, subject: ReactionSubject, content: unknown): Promise<void> => {
  const { reaction, created } = await createReaction(scope, subject, content)
  if (!created) await deleteReaction(scope, subject, reaction.id)
}

export const viewerReactions = async (scope: Scope, kind: ReactionKind, ids: readonly number[]): Promise<Set<string>> => {
  const actor = scope.actor.ref
  if (!actor) return new Set()
  const rows = await allIn<{ subject_id: number; content: string }>(
    scope.db,
    (marks) => `SELECT subject_id, content FROM reactions WHERE subject_kind = ? AND user_kind = ? AND user_id = ? AND subject_id IN (${marks})`,
    ids,
    kind,
    actor.kind,
    actor.id,
  )
  return new Set(rows.map((row) => `${row.subject_id}:${row.content}`))
}
