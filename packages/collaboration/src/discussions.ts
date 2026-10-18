import { type Database, first, sql, type Statement } from '@git-forge/accounts'
import { actorColumns, loadUsers, type UserSummary } from './actors.ts'
import { type ActorRef, CollaborationError, invalid, nodeId, notFound, refFromColumns, requirePermission, type Scope } from './context.ts'
import { DEFAULT_PAGE, numberStatement, offset, type Page, type Paged, requireBody, requireTitle } from './issues.ts'

export type DiscussionCategory = {
  readonly id: number
  readonly nodeId: string
  readonly slug: string
  readonly name: string
  readonly emoji: string
  readonly description: string
  readonly answerable: boolean
  readonly createdAt: number
}

export type DiscussionState = 'open' | 'closed'

export type DiscussionStateReason = 'resolved' | 'outdated' | 'duplicate' | 'reopened'

export type Discussion = {
  readonly id: number
  readonly nodeId: string
  readonly number: number
  readonly category: DiscussionCategory
  readonly title: string
  readonly body: string
  readonly author: UserSummary
  readonly authorRef: ActorRef | null
  readonly state: DiscussionState
  readonly stateReason: DiscussionStateReason | null
  readonly locked: boolean
  readonly answerCommentId: number | null
  readonly answerChosenAt: number | null
  readonly answerChosenBy: UserSummary | null
  readonly comments: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly closedAt: number | null
}

export type DiscussionComment = {
  readonly id: number
  readonly nodeId: string
  readonly discussionNumber: number
  readonly parentId: number | null
  readonly author: UserSummary
  readonly authorRef: ActorRef | null
  readonly body: string
  readonly isAnswer: boolean
  readonly replies: number
  readonly createdAt: number
  readonly updatedAt: number
}

type CategoryRow = { id: number; node_id: string; slug: string; name: string; emoji: string; description: string; answerable: number; created_at: number }

type DiscussionRow = {
  id: number
  node_id: string
  number: number
  category_id: number
  title: string
  body: string
  author_kind: string
  author_id: string
  state: DiscussionState
  state_reason: DiscussionStateReason | null
  locked: number
  answer_comment_id: number | null
  answer_chosen_at: number | null
  answer_chosen_by_kind: string | null
  answer_chosen_by_id: string | null
  comment_count: number
  created_at: number
  updated_at: number
  closed_at: number | null
}

type CommentRow = {
  id: number
  node_id: string
  discussion_id: number
  number: number
  parent_id: number | null
  author_kind: string
  author_id: string
  body: string
  created_at: number
  updated_at: number
  answer_comment_id: number | null
  locked: number
}

export const DEFAULT_CATEGORIES: readonly { readonly slug: string; readonly name: string; readonly emoji: string; readonly description: string; readonly answerable: boolean }[] = [
  { slug: 'general', name: 'General', emoji: ':speech_balloon:', description: 'Chat about anything and everything here', answerable: false },
  { slug: 'q-a', name: 'Q&A', emoji: ':pray:', description: 'Ask the community for help', answerable: true },
  { slug: 'ideas', name: 'Ideas', emoji: ':bulb:', description: 'Share ideas for new features', answerable: false },
  { slug: 'announcements', name: 'Announcements', emoji: ':mega:', description: 'Updates from maintainers', answerable: false },
]

const toCategory = (row: CategoryRow): DiscussionCategory => ({
  id: row.id,
  nodeId: row.node_id,
  slug: row.slug,
  name: row.name,
  emoji: row.emoji,
  description: row.description,
  answerable: row.answerable === 1,
  createdAt: row.created_at,
})

const requireDiscussions = (scope: Scope) => {
  if (!scope.settings.hasDiscussions) throw new CollaborationError(410, 'Discussions are disabled for this repository')
}

const ensureCategories = async (scope: Scope): Promise<void> => {
  const existing = await first<{ count: number }>(scope.db, sql('SELECT COUNT(*) AS count FROM discussion_categories WHERE repository_id = ?', scope.repository.id))
  if ((existing?.count ?? 0) > 0) return
  await scope.db.batch(
    DEFAULT_CATEGORIES.map((category) =>
      sql(
        'INSERT OR IGNORE INTO discussion_categories (node_id, repository_id, slug, name, emoji, description, answerable, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        nodeId('DIC'),
        scope.repository.id,
        category.slug,
        category.name,
        category.emoji,
        category.description,
        category.answerable ? 1 : 0,
        scope.now(),
      ),
    ),
  )
}

export const listCategories = async (scope: Scope): Promise<DiscussionCategory[]> => {
  requireDiscussions(scope)
  await ensureCategories(scope)
  const rows = await scope.db.all<CategoryRow>(sql('SELECT * FROM discussion_categories WHERE repository_id = ? ORDER BY id', scope.repository.id))
  return rows.map(toCategory)
}

const categoryRow = async (scope: Scope, slug: string): Promise<CategoryRow> => {
  await ensureCategories(scope)
  const row = await first<CategoryRow>(scope.db, sql('SELECT * FROM discussion_categories WHERE repository_id = ? AND slug = ?', scope.repository.id, slug))
  if (!row) throw notFound()
  return row
}

export const getCategory = async (scope: Scope, slug: string): Promise<DiscussionCategory> => {
  requireDiscussions(scope)
  return toCategory(await categoryRow(scope, slug))
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,49}$/

export type CategoryInput = { readonly slug?: unknown; readonly name?: unknown; readonly emoji?: unknown; readonly description?: unknown; readonly answerable?: unknown }

const categoryFields = (input: CategoryInput, fallback?: CategoryRow) => {
  const name = input.name ?? fallback?.name
  if (typeof name !== 'string' || name.trim() === '' || name.length > 100) throw invalid('name must have 1 to 100 characters')
  const slug = input.slug ?? fallback?.slug ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (typeof slug !== 'string' || !SLUG.test(slug)) throw invalid('slug must match [a-z0-9][a-z0-9-]*')
  const emoji = input.emoji ?? fallback?.emoji ?? ''
  const description = input.description ?? fallback?.description ?? ''
  if (typeof emoji !== 'string' || emoji.length > 64) throw invalid('emoji must be a short string')
  if (typeof description !== 'string' || description.length > 1000) throw invalid('description must have at most 1000 characters')
  const answerable = input.answerable ?? (fallback ? fallback.answerable === 1 : false)
  if (typeof answerable !== 'boolean') throw invalid('answerable must be a boolean')
  return { name, slug, emoji, description, answerable }
}

export const createCategory = async (scope: Scope, input: CategoryInput): Promise<DiscussionCategory> => {
  requireDiscussions(scope)
  requirePermission(scope, 'discussion:category')
  await ensureCategories(scope)
  const fields = categoryFields(input)
  if (await first(scope.db, sql('SELECT id FROM discussion_categories WHERE repository_id = ? AND slug = ?', scope.repository.id, fields.slug))) {
    throw new CollaborationError(422, 'Validation Failed', [{ resource: 'DiscussionCategory', code: 'already_exists', field: 'slug' }])
  }
  await scope.db.run(
    sql(
      'INSERT INTO discussion_categories (node_id, repository_id, slug, name, emoji, description, answerable, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      nodeId('DIC'),
      scope.repository.id,
      fields.slug,
      fields.name,
      fields.emoji,
      fields.description,
      fields.answerable ? 1 : 0,
      scope.now(),
    ),
  )
  return getCategory(scope, fields.slug)
}

export const updateCategory = async (scope: Scope, slug: string, input: CategoryInput): Promise<DiscussionCategory> => {
  requireDiscussions(scope)
  requirePermission(scope, 'discussion:category')
  const row = await categoryRow(scope, slug)
  const fields = categoryFields(input, row)
  if (fields.slug !== row.slug && (await first(scope.db, sql('SELECT id FROM discussion_categories WHERE repository_id = ? AND slug = ?', scope.repository.id, fields.slug)))) {
    throw new CollaborationError(422, 'Validation Failed', [{ resource: 'DiscussionCategory', code: 'already_exists', field: 'slug' }])
  }
  await scope.db.run(
    sql('UPDATE discussion_categories SET slug = ?, name = ?, emoji = ?, description = ?, answerable = ? WHERE id = ?', fields.slug, fields.name, fields.emoji, fields.description, fields.answerable ? 1 : 0, row.id),
  )
  return getCategory(scope, fields.slug)
}

export const deleteCategory = async (scope: Scope, slug: string): Promise<void> => {
  requireDiscussions(scope)
  requirePermission(scope, 'discussion:category')
  const row = await categoryRow(scope, slug)
  if (await first(scope.db, sql('SELECT id FROM discussions WHERE category_id = ? LIMIT 1', row.id))) throw invalid('Category still has discussions; move them first')
  await scope.db.run(sql('DELETE FROM discussion_categories WHERE id = ?', row.id))
}

const hydrateDiscussions = async (db: Database, scope: Scope, rows: readonly DiscussionRow[]): Promise<Discussion[]> => {
  const categories = new Map((await db.all<CategoryRow>(sql('SELECT * FROM discussion_categories WHERE repository_id = ?', scope.repository.id))).map((row) => [row.id, toCategory(row)]))
  const users = await loadUsers(
    db,
    rows.flatMap((row) => [
      { kind: row.author_kind, id: row.author_id },
      { kind: row.answer_chosen_by_kind, id: row.answer_chosen_by_id },
    ]),
  )
  return rows.map((row) => ({
    id: row.id,
    nodeId: row.node_id,
    number: row.number,
    category: categories.get(row.category_id)!,
    title: row.title,
    body: row.body,
    author: users({ kind: row.author_kind, id: row.author_id }),
    authorRef: refFromColumns(row.author_kind, row.author_id),
    state: row.state,
    stateReason: row.state_reason,
    locked: row.locked === 1,
    answerCommentId: row.answer_comment_id,
    answerChosenAt: row.answer_chosen_at,
    answerChosenBy: row.answer_chosen_by_kind ? users({ kind: row.answer_chosen_by_kind, id: row.answer_chosen_by_id }) : null,
    comments: row.comment_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  }))
}

export const listDiscussions = async (
  scope: Scope,
  filters: { readonly category?: string; readonly state?: DiscussionState | 'all'; readonly answered?: boolean } = {},
  page: Page = DEFAULT_PAGE,
): Promise<Paged<Discussion>> => {
  requireDiscussions(scope)
  const where = ['d.repository_id = ?']
  const params: (string | number)[] = [scope.repository.id]
  if (filters.category !== undefined) {
    where.push('d.category_id = ?')
    params.push((await categoryRow(scope, filters.category)).id)
  }
  if (filters.state !== undefined && filters.state !== 'all') {
    where.push('d.state = ?')
    params.push(filters.state)
  }
  if (filters.answered !== undefined) where.push(filters.answered ? 'd.answer_comment_id IS NOT NULL' : 'd.answer_comment_id IS NULL')
  const clause = where.join(' AND ')
  const total = (await first<{ count: number }>(scope.db, sql(`SELECT COUNT(*) AS count FROM discussions d WHERE ${clause}`, ...params)))?.count ?? 0
  const rows = await scope.db.all<DiscussionRow>(sql(`SELECT d.* FROM discussions d WHERE ${clause} ORDER BY d.updated_at DESC, d.number DESC LIMIT ? OFFSET ?`, ...params, page.perPage, offset(page)))
  return { items: await hydrateDiscussions(scope.db, scope, rows), total }
}

const discussionRow = async (scope: Scope, number: number): Promise<DiscussionRow> => {
  requireDiscussions(scope)
  const row = await first<DiscussionRow>(scope.db, sql('SELECT * FROM discussions WHERE repository_id = ? AND number = ?', scope.repository.id, number))
  if (!row) throw notFound()
  return row
}

export const getDiscussion = async (scope: Scope, number: number): Promise<Discussion> => (await hydrateDiscussions(scope.db, scope, [await discussionRow(scope, number)]))[0]!

export type DiscussionInput = { readonly title?: unknown; readonly body?: unknown; readonly category?: unknown }

export const createDiscussion = async (scope: Scope, input: DiscussionInput): Promise<Discussion> => {
  requireDiscussions(scope)
  const author = requirePermission(scope, 'discussion:create')
  const title = requireTitle(input.title)
  const body = requireBody(input.body)
  if (typeof input.category !== 'string') throw invalid('category is required')
  const category = await categoryRow(scope, input.category)
  if (category.slug === 'announcements') requirePermission(scope, 'discussion:category')
  const node = nodeId('D')
  const at = scope.now()
  await scope.db.batch([
    numberStatement(scope, 'discussion', node),
    sql(
      `INSERT INTO discussions (node_id, repository_id, number, category_id, title, body, author_kind, author_id, state, created_at, updated_at)
       SELECT ?, ?, number, ?, ?, ?, ?, ?, 'open', ?, ? FROM repository_numbers WHERE node_id = ?`,
      node,
      scope.repository.id,
      category.id,
      title,
      body,
      author.kind,
      author.id,
      at,
      at,
      node,
    ),
  ])
  const row = (await first<DiscussionRow>(scope.db, sql('SELECT * FROM discussions WHERE node_id = ?', node)))!
  return (await hydrateDiscussions(scope.db, scope, [row]))[0]!
}

const DISCUSSION_REASONS: readonly DiscussionStateReason[] = ['resolved', 'outdated', 'duplicate', 'reopened']

export type DiscussionUpdate = DiscussionInput & { readonly state?: unknown; readonly stateReason?: unknown }

export const updateDiscussion = async (scope: Scope, number: number, input: DiscussionUpdate): Promise<Discussion> => {
  const row = await discussionRow(scope, number)
  const author = refFromColumns(row.author_kind, row.author_id)
  const at = scope.now()
  const statements: Statement[] = []
  if (input.title !== undefined || input.body !== undefined || input.category !== undefined) {
    requirePermission(scope, 'discussion:edit', { author })
    const title = input.title !== undefined ? requireTitle(input.title) : row.title
    const body = input.body !== undefined ? requireBody(input.body) : row.body
    let categoryId = row.category_id
    if (input.category !== undefined) {
      if (typeof input.category !== 'string') throw invalid('category must be a category slug')
      categoryId = (await categoryRow(scope, input.category)).id
    }
    statements.push(sql('UPDATE discussions SET title = ?, body = ?, category_id = ?, updated_at = ? WHERE id = ?', title, body, categoryId, at, row.id))
  }
  if (input.state !== undefined) {
    if (input.state !== 'open' && input.state !== 'closed') throw invalid('state must be open or closed')
    const reason = input.stateReason ?? (input.state === 'closed' ? 'resolved' : 'reopened')
    if (!DISCUSSION_REASONS.includes(reason as DiscussionStateReason)) throw invalid('state_reason must be resolved, outdated, duplicate or reopened')
    if (input.state !== row.state) {
      requirePermission(scope, 'discussion:close', { author })
      statements.push(
        sql('UPDATE discussions SET state = ?, state_reason = ?, closed_at = ?, updated_at = ? WHERE id = ?', input.state, reason as string, input.state === 'closed' ? at : null, at, row.id),
      )
    }
  }
  if (statements.length > 0) await scope.db.batch(statements)
  return getDiscussion(scope, number)
}

export const setDiscussionLocked = async (scope: Scope, number: number, locked: boolean): Promise<Discussion> => {
  requirePermission(scope, 'discussion:lock')
  const row = await discussionRow(scope, number)
  await scope.db.run(sql('UPDATE discussions SET locked = ?, updated_at = ? WHERE id = ?', locked ? 1 : 0, scope.now(), row.id))
  return getDiscussion(scope, number)
}

const COMMENT_SELECT = `SELECT c.id, c.node_id, c.discussion_id, d.number, c.parent_id, c.author_kind, c.author_id, c.body, c.created_at, c.updated_at, d.answer_comment_id, d.locked
  FROM discussion_comments c JOIN discussions d ON d.id = c.discussion_id`

const hydrateComments = async (db: Database, rows: readonly CommentRow[]): Promise<DiscussionComment[]> => {
  const users = await loadUsers(db, rows.map((row) => ({ kind: row.author_kind, id: row.author_id })))
  const replyCounts = new Map<number, number>()
  const parents = rows.map((row) => row.id)
  for (let i = 0; i < parents.length; i += 90) {
    const part = parents.slice(i, i + 90)
    const counts = await db.all<{ parent_id: number; count: number }>(
      sql(`SELECT parent_id, COUNT(*) AS count FROM discussion_comments WHERE deleted_at IS NULL AND parent_id IN (${part.map(() => '?').join(', ')}) GROUP BY parent_id`, ...part),
    )
    for (const entry of counts) replyCounts.set(entry.parent_id, entry.count)
  }
  return rows.map((row) => ({
    id: row.id,
    nodeId: row.node_id,
    discussionNumber: row.number,
    parentId: row.parent_id,
    author: users({ kind: row.author_kind, id: row.author_id }),
    authorRef: refFromColumns(row.author_kind, row.author_id),
    body: row.body,
    isAnswer: row.answer_comment_id === row.id,
    replies: replyCounts.get(row.id) ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

export const listDiscussionComments = async (scope: Scope, number: number, options: { readonly parentId?: number } = {}): Promise<DiscussionComment[]> => {
  const discussion = await discussionRow(scope, number)
  const rows = await scope.db.all<CommentRow>(
    options.parentId === undefined
      ? sql(`${COMMENT_SELECT} WHERE c.discussion_id = ? AND c.deleted_at IS NULL ORDER BY c.id`, discussion.id)
      : sql(`${COMMENT_SELECT} WHERE c.discussion_id = ? AND c.parent_id = ? AND c.deleted_at IS NULL ORDER BY c.id`, discussion.id, options.parentId),
  )
  return hydrateComments(scope.db, rows)
}

const commentRow = async (scope: Scope, id: number): Promise<CommentRow> => {
  requireDiscussions(scope)
  const row = await first<CommentRow>(scope.db, sql(`${COMMENT_SELECT} WHERE c.id = ? AND d.repository_id = ? AND c.deleted_at IS NULL`, id, scope.repository.id))
  if (!row) throw notFound()
  return row
}

export const getDiscussionComment = async (scope: Scope, id: number): Promise<DiscussionComment> => (await hydrateComments(scope.db, [await commentRow(scope, id)]))[0]!

export const createDiscussionComment = async (scope: Scope, number: number, input: { readonly body?: unknown; readonly parentId?: unknown }): Promise<DiscussionComment> => {
  const discussion = await discussionRow(scope, number)
  const author = requirePermission(scope, 'comment:create', { locked: discussion.locked === 1 })
  const body = requireBody(input.body)
  let parent: number | null = null
  if (input.parentId !== undefined && input.parentId !== null) {
    if (typeof input.parentId !== 'number') throw invalid('reply_to_id must be a comment id')
    const row = await commentRow(scope, input.parentId)
    if (row.discussion_id !== discussion.id) throw invalid('reply_to_id must be a comment of this discussion')
    parent = row.parent_id ?? row.id
  }
  const node = nodeId('DC')
  const at = scope.now()
  await scope.db.batch([
    sql(
      'INSERT INTO discussion_comments (node_id, discussion_id, parent_id, author_kind, author_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      node,
      discussion.id,
      parent,
      author.kind,
      author.id,
      body,
      at,
      at,
    ),
    sql('UPDATE discussions SET comment_count = comment_count + 1, updated_at = ? WHERE id = ?', at, discussion.id),
  ])
  const row = (await first<CommentRow>(scope.db, sql(`${COMMENT_SELECT} WHERE c.node_id = ?`, node)))!
  return (await hydrateComments(scope.db, [row]))[0]!
}

export const updateDiscussionComment = async (scope: Scope, id: number, body: unknown): Promise<DiscussionComment> => {
  const row = await commentRow(scope, id)
  requirePermission(scope, 'comment:edit', { author: refFromColumns(row.author_kind, row.author_id) })
  await scope.db.run(sql('UPDATE discussion_comments SET body = ?, updated_at = ? WHERE id = ?', requireBody(body), scope.now(), id))
  return getDiscussionComment(scope, id)
}

export const deleteDiscussionComment = async (scope: Scope, id: number): Promise<void> => {
  const row = await commentRow(scope, id)
  requirePermission(scope, 'comment:edit', { author: refFromColumns(row.author_kind, row.author_id) })
  const at = scope.now()
  await scope.db.batch([
    sql('UPDATE discussion_comments SET deleted_at = ?, updated_at = ? WHERE id = ?', at, at, id),
    sql('UPDATE discussions SET comment_count = comment_count - 1 WHERE id = ?', row.discussion_id),
    ...(row.answer_comment_id === id ? [sql('UPDATE discussions SET answer_comment_id = NULL, answer_chosen_at = NULL, answer_chosen_by_kind = NULL, answer_chosen_by_id = NULL WHERE id = ?', row.discussion_id)] : []),
  ])
}

export const setAnswer = async (scope: Scope, number: number, commentId: number | null): Promise<Discussion> => {
  const discussion = await discussionRow(scope, number)
  const actor = requirePermission(scope, 'discussion:answer', { author: refFromColumns(discussion.author_kind, discussion.author_id) })
  const category = (await scope.db.all<CategoryRow>(sql('SELECT * FROM discussion_categories WHERE id = ?', discussion.category_id)))[0]!
  if (category.answerable !== 1) throw invalid('Answers can only be marked in answerable categories')
  if (commentId === null) {
    await scope.db.run(
      sql('UPDATE discussions SET answer_comment_id = NULL, answer_chosen_at = NULL, answer_chosen_by_kind = NULL, answer_chosen_by_id = NULL, updated_at = ? WHERE id = ?', scope.now(), discussion.id),
    )
    return getDiscussion(scope, number)
  }
  const comment = await commentRow(scope, commentId)
  if (comment.discussion_id !== discussion.id) throw invalid('The answer must be a comment of this discussion')
  if (comment.parent_id !== null) throw invalid('Only top-level comments can be marked as the answer')
  const [kind, id] = actorColumns(actor)
  const at = scope.now()
  await scope.db.run(
    sql('UPDATE discussions SET answer_comment_id = ?, answer_chosen_at = ?, answer_chosen_by_kind = ?, answer_chosen_by_id = ?, updated_at = ? WHERE id = ?', commentId, at, kind, id, at, discussion.id),
  )
  return getDiscussion(scope, number)
}

