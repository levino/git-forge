import { type Database, first, type Principal, resolveAccess, sql, type Statement, atLeast } from '@git-forge/accounts'
import { actorColumns, externalUser, loadUsers, type UserDirectory, type UserSummary } from './actors.ts'
import {
  type ActorRef,
  can,
  CollaborationError,
  emitActivity,
  type EventActor,
  invalid,
  nodeId,
  notFound,
  refFromColumns,
  requirePermission,
  type Scope,
} from './context.ts'
import { localNumbers, parseClosingReferences, parseReferences } from './references.ts'
import { EMPTY_ROLLUP, type ReactionRollup, reactionRollups } from './reactions.ts'

export type IssueState = 'open' | 'closed'

export type StateReason = 'completed' | 'not_planned' | 'reopened' | 'duplicate'

export type Label = {
  readonly id: number
  readonly nodeId: string
  readonly name: string
  readonly color: string
  readonly description: string | null
}

export type Milestone = {
  readonly id: number
  readonly nodeId: string
  readonly number: number
  readonly title: string
  readonly description: string | null
  readonly state: IssueState
  readonly dueOn: number | null
  readonly creator: UserSummary
  readonly openIssues: number
  readonly closedIssues: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly closedAt: number | null
}

export type Issue = {
  readonly id: number
  readonly nodeId: string
  readonly number: number
  readonly isPull: boolean
  readonly title: string
  readonly body: string | null
  readonly author: UserSummary
  readonly authorRef: ActorRef | null
  readonly state: IssueState
  readonly stateReason: StateReason | null
  readonly locked: boolean
  readonly lockReason: string | null
  readonly labels: readonly Label[]
  readonly assignees: readonly UserSummary[]
  readonly milestone: Milestone | null
  readonly comments: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly closedAt: number | null
  readonly closedBy: UserSummary | null
  readonly reactions: ReactionRollup
}

export type IssueComment = {
  readonly id: number
  readonly nodeId: string
  readonly issueNumber: number
  readonly author: UserSummary
  readonly authorRef: ActorRef | null
  readonly body: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly reactions: ReactionRollup
}

export type IssueEvent = {
  readonly id: number
  readonly nodeId: string
  readonly issueNumber: number
  readonly actor: UserSummary
  readonly event: string
  readonly data: Readonly<Record<string, unknown>>
  readonly createdAt: number
}

export type Page = { readonly page: number; readonly perPage: number }

export type Paged<T> = { readonly items: readonly T[]; readonly total: number }

export const DEFAULT_PAGE: Page = { page: 1, perPage: 30 }

export type IssueRow = {
  id: number
  node_id: string
  repository_id: string
  number: number
  is_pull: number
  title: string
  body: string | null
  author_kind: string
  author_id: string
  state: IssueState
  state_reason: StateReason | null
  locked: number
  lock_reason: string | null
  milestone_id: number | null
  comment_count: number
  created_at: number
  updated_at: number
  closed_at: number | null
  closed_by_kind: string | null
  closed_by_id: string | null
}

type LabelRow = { id: number; node_id: string; name: string; color: string; description: string | null }

type MilestoneRow = {
  id: number
  node_id: string
  number: number
  title: string
  description: string | null
  state: IssueState
  due_on: number | null
  creator_kind: string
  creator_id: string
  created_at: number
  updated_at: number
  closed_at: number | null
}

type CommentRow = { id: number; node_id: string; issue_id: number; number: number; author_kind: string; author_id: string; body: string; created_at: number; updated_at: number }

type EventRow = { id: number; node_id: string; number: number; actor_kind: string; actor_id: string | null; event: string; data: string; created_at: number }

export const MAX_TITLE = 256

export const MAX_BODY = 65_536

const MAX_IN = 90

export const chunked = <T>(values: readonly T[], size = MAX_IN): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size))
  return out
}

export const placeholders = (values: readonly unknown[]): string => values.map(() => '?').join(', ')

export const allIn = async <T extends Record<string, unknown>>(db: Database, build: (marks: string) => string, ids: readonly (string | number)[], ...before: (string | number)[]): Promise<T[]> => {
  const rows: T[] = []
  for (const part of chunked([...new Set(ids)])) {
    if (part.length === 0) continue
    rows.push(...(await db.all(sql(build(placeholders(part)), ...before, ...part)) as T[]))
  }
  return rows
}

export const offset = (page: Page): number => (page.page - 1) * page.perPage

export const requireTitle = (title: unknown): string => {
  if (typeof title !== 'string' || title.trim() === '') throw invalid('title is required')
  if (title.length > MAX_TITLE) throw invalid(`title must have at most ${MAX_TITLE} characters`)
  return title
}

export const optionalBody = (body: unknown): string | null => {
  if (body === undefined || body === null) return null
  if (typeof body !== 'string') throw invalid('body must be a string')
  if (body.length > MAX_BODY) throw invalid(`body must have at most ${MAX_BODY} characters`)
  return body
}

export const requireBody = (body: unknown): string => {
  const text = optionalBody(body)
  if (text === null || text.trim() === '') throw invalid('body is required')
  return text
}

export const eventStatement = (issueId: number | { readonly nodeId: string }, actor: EventActor, event: string, data: Record<string, unknown>, at: number): Statement => {
  const [kind, id] = actorColumns(actor)
  const values = [nodeId('E'), kind, id, event, JSON.stringify(data), at] as const
  return typeof issueId === 'number'
    ? sql('INSERT INTO issue_events (node_id, issue_id, actor_kind, actor_id, event, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', values[0], issueId, ...values.slice(1))
    : sql(
        'INSERT INTO issue_events (node_id, issue_id, actor_kind, actor_id, event, data, created_at) SELECT ?, id, ?, ?, ?, ?, ? FROM issues WHERE node_id = ?',
        ...values,
        issueId.nodeId,
      )
}

export const numberStatement = (scope: Scope, kind: 'issue' | 'pull' | 'discussion', node: string): Statement =>
  sql(
    'INSERT INTO repository_numbers (repository_id, number, kind, node_id) SELECT ?, COALESCE(MAX(number), 0) + 1, ?, ? FROM repository_numbers WHERE repository_id = ?',
    scope.repository.id,
    kind,
    node,
    scope.repository.id,
  )

const toLabel = (row: LabelRow): Label => ({ id: row.id, nodeId: row.node_id, name: row.name, color: row.color, description: row.description })

const hydrateMilestones = async (db: Database, rows: readonly MilestoneRow[], users?: UserDirectory): Promise<Milestone[]> => {
  if (rows.length === 0) return []
  const counts = await allIn<{ milestone_id: number; state: IssueState; count: number }>(
    db,
    (marks) => `SELECT milestone_id, state, COUNT(*) AS count FROM issues WHERE milestone_id IN (${marks}) GROUP BY milestone_id, state`,
    rows.map((row) => row.id),
  )
  const directory = users ?? (await loadUsers(db, rows.map((row) => ({ kind: row.creator_kind, id: row.creator_id }))))
  const count = (id: number, state: IssueState) => counts.find((entry) => entry.milestone_id === id && entry.state === state)?.count ?? 0
  return rows.map((row) => ({
    id: row.id,
    nodeId: row.node_id,
    number: row.number,
    title: row.title,
    description: row.description,
    state: row.state,
    dueOn: row.due_on,
    creator: directory({ kind: row.creator_kind, id: row.creator_id }),
    openIssues: count(row.id, 'open'),
    closedIssues: count(row.id, 'closed'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  }))
}

export const hydrateIssues = async (db: Database, rows: readonly IssueRow[]): Promise<Issue[]> => {
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  const labels = await allIn<LabelRow & { issue_id: number }>(
    db,
    (marks) => `SELECT il.issue_id, l.id, l.node_id, l.name, l.color, l.description FROM issue_labels il JOIN labels l ON l.id = il.label_id WHERE il.issue_id IN (${marks}) ORDER BY l.name`,
    ids,
  )
  const assignees = await allIn<{ issue_id: number; user_id: string }>(
    db,
    (marks) => `SELECT issue_id, user_id FROM issue_assignees WHERE issue_id IN (${marks}) ORDER BY created_at, rowid`,
    ids,
  )
  const external = await allIn<{ node_id: string; assignees: string }>(
    db,
    (marks) => `SELECT node_id, assignees FROM imported_items WHERE node_id IN (${marks}) AND assignees != '[]'`,
    rows.map((row) => row.node_id),
  )
  const milestoneIds = rows.map((row) => row.milestone_id).filter((id): id is number => id !== null)
  const milestoneRows = await allIn<MilestoneRow>(db, (marks) => `SELECT * FROM milestones WHERE id IN (${marks})`, milestoneIds)
  const users = await loadUsers(db, [
    ...rows.flatMap((row) => [
      { kind: row.author_kind, id: row.author_id },
      { kind: row.closed_by_kind, id: row.closed_by_id },
    ]),
    ...assignees.map((entry) => ({ kind: 'user', id: entry.user_id })),
    ...milestoneRows.map((row) => ({ kind: row.creator_kind, id: row.creator_id })),
  ])
  const milestones = await hydrateMilestones(db, milestoneRows, users)
  const reactions = await reactionRollups(db, 'issue', ids)
  return rows.map((row) => ({
    id: row.id,
    nodeId: row.node_id,
    number: row.number,
    isPull: row.is_pull === 1,
    title: row.title,
    body: row.body,
    author: users({ kind: row.author_kind, id: row.author_id }),
    authorRef: refFromColumns(row.author_kind, row.author_id),
    state: row.state,
    stateReason: row.state_reason,
    locked: row.locked === 1,
    lockReason: row.lock_reason,
    labels: labels.filter((label) => label.issue_id === row.id).map(toLabel),
    assignees: [
      ...assignees.filter((entry) => entry.issue_id === row.id).map((entry) => users({ kind: 'user', id: entry.user_id })),
      ...(JSON.parse(external.find((entry) => entry.node_id === row.node_id)?.assignees ?? '[]') as string[]).map(externalUser),
    ],
    milestone: milestones.find((milestone) => milestone.id === row.milestone_id) ?? null,
    comments: row.comment_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    closedBy: row.closed_by_kind ? users({ kind: row.closed_by_kind, id: row.closed_by_id }) : null,
    reactions: reactions.get(row.id) ?? EMPTY_ROLLUP,
  }))
}

export const issueRow = async (scope: Scope, number: number): Promise<IssueRow> => {
  const row = await first<IssueRow>(scope.db, sql('SELECT * FROM issues WHERE repository_id = ? AND number = ?', scope.repository.id, number))
  if (!row) throw notFound()
  return row
}

export const issueRowByNode = async (db: Database, node: string): Promise<IssueRow> => {
  const row = await first<IssueRow>(db, sql('SELECT * FROM issues WHERE node_id = ?', node))
  if (!row) throw new Error(`issue ${node} vanished`)
  return row
}

export const getIssue = async (scope: Scope, number: number): Promise<Issue> => (await hydrateIssues(scope.db, [await issueRow(scope, number)]))[0]!

export type IssueFilters = {
  readonly state?: IssueState | 'all'
  readonly labels?: readonly string[]
  readonly assignee?: string
  readonly creator?: string
  readonly milestone?: string
  readonly since?: number
  readonly sort?: 'created' | 'updated' | 'comments'
  readonly direction?: 'asc' | 'desc'
  readonly kind?: 'issue' | 'pull' | 'all'
}

const findUserId = async (scope: Scope, login: string): Promise<string | null> => {
  const account = await scope.accounts.findAccount(login)
  return account?.kind === 'user' ? account.id : null
}

export const listIssues = async (scope: Scope, filters: IssueFilters = {}, page: Page = DEFAULT_PAGE): Promise<Paged<Issue>> => {
  const where = ['i.repository_id = ?']
  const params: (string | number)[] = [scope.repository.id]
  const state = filters.state ?? 'open'
  if (state !== 'all') {
    where.push('i.state = ?')
    params.push(state)
  }
  if (filters.kind === 'issue') where.push('i.is_pull = 0')
  if (filters.kind === 'pull') where.push('i.is_pull = 1')
  for (const name of filters.labels ?? []) {
    where.push('EXISTS (SELECT 1 FROM issue_labels il JOIN labels l ON l.id = il.label_id WHERE il.issue_id = i.id AND l.name = ?)')
    params.push(name)
  }
  if (filters.assignee === 'none') where.push('NOT EXISTS (SELECT 1 FROM issue_assignees a WHERE a.issue_id = i.id)')
  else if (filters.assignee === '*') where.push('EXISTS (SELECT 1 FROM issue_assignees a WHERE a.issue_id = i.id)')
  else if (filters.assignee !== undefined) {
    where.push('EXISTS (SELECT 1 FROM issue_assignees a WHERE a.issue_id = i.id AND a.user_id = ?)')
    params.push((await findUserId(scope, filters.assignee)) ?? '')
  }
  if (filters.creator !== undefined) {
    where.push("i.author_kind = 'user' AND i.author_id = ?")
    params.push((await findUserId(scope, filters.creator)) ?? '')
  }
  if (filters.milestone === 'none') where.push('i.milestone_id IS NULL')
  else if (filters.milestone === '*') where.push('i.milestone_id IS NOT NULL')
  else if (filters.milestone !== undefined) {
    where.push('i.milestone_id = (SELECT id FROM milestones WHERE repository_id = ? AND number = ?)')
    params.push(scope.repository.id, Number(filters.milestone))
  }
  if (filters.since !== undefined) {
    where.push('i.updated_at >= ?')
    params.push(filters.since)
  }
  const column = filters.sort === 'updated' ? 'i.updated_at' : filters.sort === 'comments' ? 'i.comment_count' : 'i.created_at'
  const direction = filters.direction === 'asc' ? 'ASC' : 'DESC'
  const clause = where.join(' AND ')
  const total = (await first<{ count: number }>(scope.db, sql(`SELECT COUNT(*) AS count FROM issues i WHERE ${clause}`, ...params)))?.count ?? 0
  const rows = await scope.db.all<IssueRow>(
    sql(`SELECT i.* FROM issues i WHERE ${clause} ORDER BY ${column} ${direction}, i.number ${direction} LIMIT ? OFFSET ?`, ...params, page.perPage, offset(page)),
  )
  return { items: await hydrateIssues(scope.db, rows), total }
}

export const openCounts = async (scope: Scope): Promise<{ readonly issues: number; readonly pulls: number }> => {
  const row = await first<{ issues: number | null; pulls: number | null }>(
    scope.db,
    sql("SELECT SUM(is_pull = 0) AS issues, SUM(is_pull = 1) AS pulls FROM issues WHERE repository_id = ? AND state = 'open'", scope.repository.id),
  )
  return { issues: row?.issues ?? 0, pulls: row?.pulls ?? 0 }
}

const labelsByName = async (scope: Scope, names: readonly string[], create: boolean): Promise<LabelRow[]> => {
  const unique = [...new Map(names.map((name) => [name.toLowerCase(), name])).values()]
  const rows = await allIn<LabelRow>(scope.db, (marks) => `SELECT id, node_id, name, color, description FROM labels WHERE repository_id = ? AND name IN (${marks})`, unique, scope.repository.id)
  const missing = unique.filter((name) => !rows.some((row) => row.name.toLowerCase() === name.toLowerCase()))
  if (missing.length === 0) return rows
  if (!create || !can(scope, 'label:manage')) throw invalid(`unknown label ${missing[0]}`)
  for (const name of missing) await createLabel(scope, { name, color: 'ededed' })
  return labelsByName(scope, names, false)
}

const assignableUsers = async (scope: Scope, logins: readonly string[]): Promise<{ id: string; login: string }[]> => {
  const users: { id: string; login: string }[] = []
  for (const login of [...new Set(logins.map((value) => value.toLowerCase()))]) {
    const account = await scope.accounts.findAccount(login)
    if (!account || account.kind !== 'user') throw invalid(`unknown assignee ${login}`)
    const principal: Principal = { kind: 'user', id: account.id, login: account.login, limits: null, tokenId: null }
    const access = resolveAccess(principal, scope.repository, await scope.accounts.grantsFor(principal, scope.repository))
    if (!atLeast(access, 'read') && !(await scope.accounts.isInstanceAdmin(account.id))) throw invalid(`${account.login} cannot be assigned to this repository`)
    users.push({ id: account.id, login: account.login })
  }
  return users
}

const milestoneId = async (scope: Scope, value: unknown): Promise<number | null> => {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw invalid('milestone must be a milestone number or null')
  const row = await first<{ id: number }>(scope.db, sql('SELECT id FROM milestones WHERE repository_id = ? AND number = ?', scope.repository.id, value))
  if (!row) throw invalid(`unknown milestone ${value}`)
  return row.id
}

export type IssueInput = {
  readonly title?: unknown
  readonly body?: unknown
  readonly labels?: readonly string[]
  readonly assignees?: readonly string[]
  readonly milestone?: unknown
}

export const crossReferenceStatements = async (scope: Scope, source: { readonly number: number; readonly isPull: boolean; readonly commentId?: number }, text: string | null, actor: EventActor): Promise<Statement[]> => {
  const numbers = localNumbers(parseReferences(text), scope.repo).filter((number) => number !== source.number)
  if (numbers.length === 0) return []
  const targets = await allIn<{ id: number; number: number }>(
    scope.db,
    (marks) => `SELECT id, number FROM issues WHERE repository_id = ? AND number IN (${marks})`,
    numbers,
    scope.repository.id,
  )
  const data = JSON.stringify({ source: { type: source.isPull ? 'pull_request' : 'issue', number: source.number, ...(source.commentId ? { comment_id: source.commentId } : {}) } })
  const [kind, id] = actorColumns(actor)
  return targets.map((target) =>
    sql(
      `INSERT INTO issue_events (node_id, issue_id, actor_kind, actor_id, event, data, created_at)
       SELECT ?, ?, ?, ?, 'cross-referenced', ?, ? WHERE NOT EXISTS (SELECT 1 FROM issue_events WHERE issue_id = ? AND event = 'cross-referenced' AND data = ?)`,
      nodeId('E'),
      target.id,
      kind,
      id,
      data,
      scope.now(),
      target.id,
      data,
    ),
  )
}

export const insertIssueStatements = async (
  scope: Scope,
  author: ActorRef,
  node: string,
  input: IssueInput,
  kind: 'issue' | 'pull',
): Promise<Statement[]> => {
  const title = requireTitle(input.title)
  const body = optionalBody(input.body)
  const triage = can(scope, 'issue:triage')
  const labels = triage && input.labels ? await labelsByName(scope, input.labels, false) : []
  const assignees = triage && input.assignees ? await assignableUsers(scope, input.assignees) : []
  const milestone = triage && input.milestone !== undefined ? await milestoneId(scope, input.milestone) : null
  const at = scope.now()
  return [
    numberStatement(scope, kind, node),
    sql(
      `INSERT INTO issues (node_id, repository_id, number, is_pull, title, body, author_kind, author_id, state, milestone_id, created_at, updated_at)
       SELECT ?, ?, number, ?, ?, ?, ?, ?, 'open', ?, ?, ? FROM repository_numbers WHERE node_id = ?`,
      node,
      scope.repository.id,
      kind === 'pull' ? 1 : 0,
      title,
      body,
      author.kind,
      author.id,
      milestone,
      at,
      at,
      node,
    ),
    ...labels.flatMap((label) => [
      sql('INSERT INTO issue_labels (issue_id, label_id, created_at) SELECT id, ?, ? FROM issues WHERE node_id = ?', label.id, at, node),
      eventStatement({ nodeId: node }, author, 'labeled', { label: { name: label.name, color: label.color } }, at),
    ]),
    ...assignees.flatMap((user) => [
      sql('INSERT INTO issue_assignees (issue_id, user_id, created_at) SELECT id, ?, ? FROM issues WHERE node_id = ?', user.id, at, node),
      eventStatement({ nodeId: node }, author, 'assigned', { assignee: { login: user.login } }, at),
    ]),
    ...(milestone !== null ? [eventStatement({ nodeId: node }, author, 'milestoned', { milestone: { number: input.milestone } }, at)] : []),
  ]
}

export const issueChanges = (before: Issue, after: Issue): { readonly action: string; readonly changes?: Record<string, unknown> }[] => {
  const out: { action: string; changes?: Record<string, unknown> }[] = []
  const changes: Record<string, unknown> = {}
  if (before.title !== after.title) changes.title = { from: before.title }
  if (before.body !== after.body) changes.body = { from: before.body }
  if (Object.keys(changes).length > 0) out.push({ action: 'edited', changes })
  if (before.state !== after.state) out.push({ action: after.state === 'closed' ? 'closed' : 'reopened' })
  const labels = (issue: Issue) => issue.labels.map((label) => label.name.toLowerCase())
  const logins = (issue: Issue) => issue.assignees.map((user) => user.login.toLowerCase())
  if (labels(after).some((name) => !labels(before).includes(name))) out.push({ action: 'labeled' })
  if (labels(before).some((name) => !labels(after).includes(name))) out.push({ action: 'unlabeled' })
  if (logins(after).some((login) => !logins(before).includes(login))) out.push({ action: 'assigned' })
  if (logins(before).some((login) => !logins(after).includes(login))) out.push({ action: 'unassigned' })
  if (before.locked !== after.locked && !after.isPull) out.push({ action: after.locked ? 'locked' : 'unlocked' })
  if (before.milestone?.number !== after.milestone?.number) {
    if (before.milestone) out.push({ action: 'demilestoned', changes: { milestone: { number: before.milestone.number, title: before.milestone.title } } })
    if (after.milestone) out.push({ action: 'milestoned' })
  }
  return out
}

export const emitIssueChanges = async (scope: Scope, before: Issue, after: Issue, actor: EventActor): Promise<void> => {
  for (const change of issueChanges(before, after)) {
    await emitActivity(scope, { kind: after.isPull ? 'pull_request' : 'issues', action: change.action, number: after.number, actor, ...(change.changes ? { changes: change.changes } : {}) })
  }
}

export const createIssue = async (scope: Scope, input: IssueInput): Promise<Issue> => {
  const author = requirePermission(scope, 'issue:create')
  const node = nodeId('I')
  await scope.db.batch(await insertIssueStatements(scope, author, node, input, 'issue'))
  const row = await issueRowByNode(scope.db, node)
  const references = await crossReferenceStatements(scope, { number: row.number, isPull: false }, row.body, author)
  if (references.length > 0) await scope.db.batch(references)
  const issue = (await hydrateIssues(scope.db, [row]))[0]!
  await emitActivity(scope, { kind: 'issues', action: 'opened', number: issue.number, actor: author })
  return issue
}

export type IssueUpdate = IssueInput & {
  readonly state?: unknown
  readonly stateReason?: unknown
}

const STATE_REASONS: readonly StateReason[] = ['completed', 'not_planned', 'reopened', 'duplicate']

export const stateChangeStatements = (row: IssueRow, actor: EventActor, state: IssueState, reason: StateReason | null, at: number, data: Record<string, unknown> = {}): Statement[] => {
  if (row.state === state) return []
  const [kind, id] = actorColumns(actor)
  return state === 'closed'
    ? [
        sql(
          "UPDATE issues SET state = 'closed', state_reason = ?, closed_at = ?, closed_by_kind = ?, closed_by_id = ?, updated_at = ? WHERE id = ?",
          reason ?? 'completed',
          at,
          kind,
          id,
          at,
          row.id,
        ),
        eventStatement(row.id, actor, 'closed', { state_reason: reason ?? 'completed', ...data }, at),
      ]
    : [
        sql("UPDATE issues SET state = 'open', state_reason = 'reopened', closed_at = NULL, closed_by_kind = NULL, closed_by_id = NULL, updated_at = ? WHERE id = ?", at, row.id),
        eventStatement(row.id, actor, 'reopened', data, at),
      ]
}

const labelChangeStatements = (issueId: number, actor: ActorRef, current: readonly LabelRow[], next: readonly LabelRow[], at: number): Statement[] => {
  const added = next.filter((label) => !current.some((existing) => existing.id === label.id))
  const removed = current.filter((label) => !next.some((wanted) => wanted.id === label.id))
  return [
    ...added.flatMap((label) => [
      sql('INSERT OR IGNORE INTO issue_labels (issue_id, label_id, created_at) VALUES (?, ?, ?)', issueId, label.id, at),
      eventStatement(issueId, actor, 'labeled', { label: { name: label.name, color: label.color } }, at),
    ]),
    ...removed.flatMap((label) => [
      sql('DELETE FROM issue_labels WHERE issue_id = ? AND label_id = ?', issueId, label.id),
      eventStatement(issueId, actor, 'unlabeled', { label: { name: label.name, color: label.color } }, at),
    ]),
  ]
}

const currentLabels = (scope: Scope, issueId: number) =>
  scope.db.all<LabelRow>(sql('SELECT l.id, l.node_id, l.name, l.color, l.description FROM issue_labels il JOIN labels l ON l.id = il.label_id WHERE il.issue_id = ?', issueId))

const assigneeChangeStatements = async (scope: Scope, issueId: number, actor: ActorRef, next: readonly { id: string; login: string }[], mode: 'set' | 'add' | 'remove', at: number): Promise<Statement[]> => {
  const current = await scope.db.all<{ user_id: string; login: string }>(
    sql('SELECT a.user_id, u.login FROM issue_assignees a JOIN accounts u ON u.id = a.user_id WHERE a.issue_id = ?', issueId),
  )
  const added = mode === 'remove' ? [] : next.filter((user) => !current.some((existing) => existing.user_id === user.id))
  const removed =
    mode === 'add'
      ? []
      : mode === 'remove'
        ? current.filter((existing) => next.some((user) => user.id === existing.user_id))
        : current.filter((existing) => !next.some((user) => user.id === existing.user_id))
  return [
    ...added.flatMap((user) => [
      sql('INSERT OR IGNORE INTO issue_assignees (issue_id, user_id, created_at) VALUES (?, ?, ?)', issueId, user.id, at),
      eventStatement(issueId, actor, 'assigned', { assignee: { login: user.login } }, at),
    ]),
    ...removed.flatMap((user) => [
      sql('DELETE FROM issue_assignees WHERE issue_id = ? AND user_id = ?', issueId, user.user_id),
      eventStatement(issueId, actor, 'unassigned', { assignee: { login: user.login } }, at),
    ]),
  ]
}

export const updateIssueStatements = async (scope: Scope, row: IssueRow, input: IssueUpdate): Promise<Statement[]> => {
  const actor = requirePermission(scope, 'view')
  const author = refFromColumns(row.author_kind, row.author_id)
  const editKind = row.is_pull === 1 ? 'pull:edit' : 'issue:edit'
  const closeKind = row.is_pull === 1 ? 'pull:close' : 'issue:close'
  const at = scope.now()
  const statements: Statement[] = []
  if (input.title !== undefined || input.body !== undefined) {
    requirePermission(scope, editKind, { author })
    const title = input.title !== undefined ? requireTitle(input.title) : row.title
    const body = input.body !== undefined ? optionalBody(input.body) : row.body
    statements.push(sql('UPDATE issues SET title = ?, body = ?, updated_at = ? WHERE id = ?', title, body, at, row.id))
    if (title !== row.title) statements.push(eventStatement(row.id, actor, 'renamed', { rename: { from: row.title, to: title } }, at))
    if (input.body !== undefined) statements.push(...(await crossReferenceStatements(scope, { number: row.number, isPull: row.is_pull === 1 }, body, actor)))
  }
  if (input.state !== undefined || input.stateReason !== undefined) {
    const state = input.state ?? row.state
    if (state !== 'open' && state !== 'closed') throw invalid('state must be open or closed')
    const reason = input.stateReason ?? null
    if (reason !== null && !STATE_REASONS.includes(reason as StateReason)) throw invalid('state_reason must be completed, not_planned, reopened or duplicate')
    if (state !== row.state) {
      requirePermission(scope, closeKind, { author })
      if (state === 'open' && row.is_pull === 1) {
        const merged = await first<{ merged_at: number | null }>(scope.db, sql('SELECT merged_at FROM pull_requests WHERE issue_id = ?', row.id))
        if (merged?.merged_at) throw invalid('state cannot be changed. The pull request cannot be reopened because it was merged.')
      }
      statements.push(...stateChangeStatements(row, actor, state, reason as StateReason | null, at))
    } else if (state === 'closed' && reason !== null && reason !== row.state_reason) {
      requirePermission(scope, closeKind, { author })
      statements.push(sql('UPDATE issues SET state_reason = ?, updated_at = ? WHERE id = ?', reason as StateReason, at, row.id))
    }
  }
  if (can(scope, 'issue:triage')) {
    if (input.labels !== undefined) statements.push(...labelChangeStatements(row.id, actor, await currentLabels(scope, row.id), await labelsByName(scope, input.labels, false), at))
    if (input.assignees !== undefined) statements.push(...(await assigneeChangeStatements(scope, row.id, actor, await assignableUsers(scope, input.assignees), 'set', at)))
    if (input.milestone !== undefined) {
      const next = await milestoneId(scope, input.milestone)
      if (next !== row.milestone_id) {
        statements.push(sql('UPDATE issues SET milestone_id = ?, updated_at = ? WHERE id = ?', next, at, row.id))
        statements.push(eventStatement(row.id, actor, next === null ? 'demilestoned' : 'milestoned', { milestone: { number: input.milestone ?? null } }, at))
      }
    }
  }
  return statements
}

export const updateIssue = async (scope: Scope, number: number, input: IssueUpdate): Promise<Issue> => {
  const row = await issueRow(scope, number)
  const before = (await hydrateIssues(scope.db, [row]))[0]!
  const statements = await updateIssueStatements(scope, row, input)
  if (statements.length === 0) return before
  await scope.db.batch(statements)
  const after = await getIssue(scope, number)
  await emitIssueChanges(scope, before, after, scope.actor.ref!)
  return after
}

export const LOCK_REASONS = ['off-topic', 'too heated', 'resolved', 'spam'] as const

export const setLocked = async (scope: Scope, number: number, locked: boolean, reason: string | null = null): Promise<void> => {
  const actor = requirePermission(scope, 'issue:lock')
  if (reason !== null && !(LOCK_REASONS as readonly string[]).includes(reason)) throw invalid('lock_reason must be off-topic, too heated, resolved or spam')
  const row = await issueRow(scope, number)
  if ((row.locked === 1) === locked) return
  const at = scope.now()
  await scope.db.batch([
    sql('UPDATE issues SET locked = ?, lock_reason = ?, updated_at = ? WHERE id = ?', locked ? 1 : 0, locked ? reason : null, at, row.id),
    eventStatement(row.id, actor, locked ? 'locked' : 'unlocked', locked ? { lock_reason: reason } : {}, at),
  ])
  if (row.is_pull === 0) await emitActivity(scope, { kind: 'issues', action: locked ? 'locked' : 'unlocked', number, actor })
}

const COMMENT_SELECT = 'SELECT c.id, c.node_id, c.issue_id, i.number, c.author_kind, c.author_id, c.body, c.created_at, c.updated_at FROM issue_comments c JOIN issues i ON i.id = c.issue_id'

const hydrateComments = async (db: Database, rows: readonly CommentRow[]): Promise<IssueComment[]> => {
  const users = await loadUsers(db, rows.map((row) => ({ kind: row.author_kind, id: row.author_id })))
  const reactions = await reactionRollups(db, 'issue_comment', rows.map((row) => row.id))
  return rows.map((row) => ({
    id: row.id,
    nodeId: row.node_id,
    issueNumber: row.number,
    reactions: reactions.get(row.id) ?? EMPTY_ROLLUP,
    author: users({ kind: row.author_kind, id: row.author_id }),
    authorRef: refFromColumns(row.author_kind, row.author_id),
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

export const listComments = async (scope: Scope, number: number | null, options: { readonly since?: number } = {}, page: Page = DEFAULT_PAGE): Promise<Paged<IssueComment>> => {
  const where = ['i.repository_id = ?', 'c.deleted_at IS NULL']
  const params: (string | number)[] = [scope.repository.id]
  if (number !== null) {
    await issueRow(scope, number)
    where.push('i.number = ?')
    params.push(number)
  }
  if (options.since !== undefined) {
    where.push('c.updated_at >= ?')
    params.push(options.since)
  }
  const clause = where.join(' AND ')
  const total = (await first<{ count: number }>(scope.db, sql(`SELECT COUNT(*) AS count FROM issue_comments c JOIN issues i ON i.id = c.issue_id WHERE ${clause}`, ...params)))?.count ?? 0
  const rows = await scope.db.all<CommentRow>(sql(`${COMMENT_SELECT} WHERE ${clause} ORDER BY c.id LIMIT ? OFFSET ?`, ...params, page.perPage, offset(page)))
  return { items: await hydrateComments(scope.db, rows), total }
}

const commentRow = async (scope: Scope, id: number, includeDeleted = false): Promise<CommentRow & { locked: number }> => {
  const row = await first<CommentRow & { locked: number }>(
    scope.db,
    sql(`${COMMENT_SELECT.replace('SELECT ', 'SELECT i.locked, ')} WHERE c.id = ? AND i.repository_id = ?${includeDeleted ? '' : ' AND c.deleted_at IS NULL'}`, id, scope.repository.id),
  )
  if (!row) throw notFound()
  return row
}

export const getComment = async (scope: Scope, id: number, includeDeleted = false): Promise<IssueComment> => (await hydrateComments(scope.db, [await commentRow(scope, id, includeDeleted)]))[0]!

export const createComment = async (scope: Scope, number: number, body: unknown): Promise<IssueComment> => {
  const row = await issueRow(scope, number)
  const author = requirePermission(scope, 'comment:create', { locked: row.locked === 1 })
  const text = requireBody(body)
  const node = nodeId('IC')
  const at = scope.now()
  await scope.db.batch([
    sql('INSERT INTO issue_comments (node_id, issue_id, author_kind, author_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', node, row.id, author.kind, author.id, text, at, at),
    sql('UPDATE issues SET comment_count = comment_count + 1, updated_at = ? WHERE id = ?', at, row.id),
  ])
  const created = await first<CommentRow>(scope.db, sql(`${COMMENT_SELECT} WHERE c.node_id = ?`, node))
  const references = await crossReferenceStatements(scope, { number, isPull: row.is_pull === 1, commentId: created!.id }, text, author)
  if (references.length > 0) await scope.db.batch(references)
  const comment = (await hydrateComments(scope.db, [created!]))[0]!
  await emitActivity(scope, { kind: 'issue_comment', action: 'created', number, actor: author, commentId: comment.id })
  return comment
}

export const updateComment = async (scope: Scope, id: number, body: unknown): Promise<IssueComment> => {
  const row = await commentRow(scope, id)
  const actor = requirePermission(scope, 'comment:edit', { author: refFromColumns(row.author_kind, row.author_id) })
  const text = requireBody(body)
  const at = scope.now()
  await scope.db.batch([
    sql('UPDATE issue_comments SET body = ?, updated_at = ? WHERE id = ?', text, at, id),
    ...(await crossReferenceStatements(scope, { number: row.number, isPull: false, commentId: id }, text, actor)),
  ])
  await emitActivity(scope, { kind: 'issue_comment', action: 'edited', number: row.number, actor, commentId: id, changes: { body: { from: row.body } } })
  return getComment(scope, id)
}

export const deleteComment = async (scope: Scope, id: number): Promise<void> => {
  const row = await commentRow(scope, id)
  const actor = requirePermission(scope, 'comment:edit', { author: refFromColumns(row.author_kind, row.author_id) })
  const at = scope.now()
  await scope.db.batch([
    sql('UPDATE issue_comments SET deleted_at = ?, updated_at = ? WHERE id = ?', at, at, id),
    sql('UPDATE issues SET comment_count = comment_count - 1 WHERE id = ?', row.issue_id),
  ])
  await emitActivity(scope, { kind: 'issue_comment', action: 'deleted', number: row.number, actor, commentId: id, deleted: true })
}

const LABEL_COLOR = /^[0-9a-fA-F]{6}$/

const labelInput = (input: { readonly name?: unknown; readonly color?: unknown; readonly description?: unknown }, fallback?: LabelRow) => {
  const name = input.name ?? fallback?.name
  if (typeof name !== 'string' || name.trim() === '' || name.length > 50) throw invalid('name must have 1 to 50 characters')
  const rawColor = input.color ?? fallback?.color ?? 'ededed'
  const color = typeof rawColor === 'string' ? rawColor.replace(/^#/, '') : ''
  if (!LABEL_COLOR.test(color)) throw invalid('color must be a six-digit hex code')
  const description = input.description === undefined ? (fallback?.description ?? null) : input.description
  if (description !== null && (typeof description !== 'string' || description.length > 100)) throw invalid('description must have at most 100 characters')
  return { name, color: color.toLowerCase(), description: description as string | null }
}

export const listLabels = async (scope: Scope, page: Page = DEFAULT_PAGE): Promise<Paged<Label>> => {
  const total = (await first<{ count: number }>(scope.db, sql('SELECT COUNT(*) AS count FROM labels WHERE repository_id = ?', scope.repository.id)))?.count ?? 0
  const rows = await scope.db.all<LabelRow>(
    sql('SELECT id, node_id, name, color, description FROM labels WHERE repository_id = ? ORDER BY name LIMIT ? OFFSET ?', scope.repository.id, page.perPage, offset(page)),
  )
  return { items: rows.map(toLabel), total }
}

const labelRow = async (scope: Scope, name: string): Promise<LabelRow> => {
  const row = await first<LabelRow>(scope.db, sql('SELECT id, node_id, name, color, description FROM labels WHERE repository_id = ? AND name = ?', scope.repository.id, name))
  if (!row) throw notFound()
  return row
}

export const getLabel = async (scope: Scope, name: string): Promise<Label> => toLabel(await labelRow(scope, name))

export const createLabel = async (scope: Scope, input: { readonly name?: unknown; readonly color?: unknown; readonly description?: unknown }): Promise<Label> => {
  requirePermission(scope, 'label:manage')
  const label = labelInput(input)
  const existing = await first(scope.db, sql('SELECT id FROM labels WHERE repository_id = ? AND name = ?', scope.repository.id, label.name))
  if (existing) throw new CollaborationError(422, 'Validation Failed', [{ resource: 'Label', code: 'already_exists', field: 'name' }])
  await scope.db.run(
    sql(
      'INSERT INTO labels (node_id, repository_id, name, color, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      nodeId('LA'),
      scope.repository.id,
      label.name,
      label.color,
      label.description,
      scope.now(),
    ),
  )
  return getLabel(scope, label.name)
}

export const updateLabel = async (scope: Scope, name: string, input: { readonly newName?: unknown; readonly color?: unknown; readonly description?: unknown }): Promise<Label> => {
  requirePermission(scope, 'label:manage')
  const row = await labelRow(scope, name)
  const label = labelInput({ name: input.newName, color: input.color, description: input.description }, row)
  if (label.name.toLowerCase() !== row.name.toLowerCase()) {
    const clash = await first(scope.db, sql('SELECT id FROM labels WHERE repository_id = ? AND name = ?', scope.repository.id, label.name))
    if (clash) throw new CollaborationError(422, 'Validation Failed', [{ resource: 'Label', code: 'already_exists', field: 'name' }])
  }
  await scope.db.run(sql('UPDATE labels SET name = ?, color = ?, description = ? WHERE id = ?', label.name, label.color, label.description, row.id))
  return getLabel(scope, label.name)
}

export const deleteLabel = async (scope: Scope, name: string): Promise<void> => {
  requirePermission(scope, 'label:manage')
  const row = await labelRow(scope, name)
  await scope.db.batch([sql('DELETE FROM issue_labels WHERE label_id = ?', row.id), sql('DELETE FROM labels WHERE id = ?', row.id)])
}

export const listIssueLabels = async (scope: Scope, number: number): Promise<Label[]> => (await currentLabels(scope, (await issueRow(scope, number)).id)).map(toLabel).sort((a, b) => a.name.localeCompare(b.name))

export const changeIssueLabels = async (scope: Scope, number: number, names: readonly string[], mode: 'add' | 'set' | 'remove'): Promise<Label[]> => {
  const actor = requirePermission(scope, 'issue:triage')
  const row = await issueRow(scope, number)
  const before = (await hydrateIssues(scope.db, [row]))[0]!
  const current = await currentLabels(scope, row.id)
  let next: LabelRow[]
  if (mode === 'remove') {
    const lowered = names.map((name) => name.toLowerCase())
    if (names.length === 1 && !current.some((label) => label.name.toLowerCase() === lowered[0])) throw new CollaborationError(404, 'Label does not exist')
    next = current.filter((label) => !lowered.includes(label.name.toLowerCase()))
  } else {
    const wanted = await labelsByName(scope, names, true)
    next = mode === 'set' ? wanted : [...current, ...wanted.filter((label) => !current.some((existing) => existing.id === label.id))]
  }
  const statements = labelChangeStatements(row.id, actor, current, next, scope.now())
  if (statements.length > 0) {
    await scope.db.batch([...statements, sql('UPDATE issues SET updated_at = ? WHERE id = ?', scope.now(), row.id)])
    await emitIssueChanges(scope, before, await getIssue(scope, number), actor)
  }
  return listIssueLabels(scope, number)
}

export const changeAssignees = async (scope: Scope, number: number, logins: readonly string[], mode: 'add' | 'remove'): Promise<Issue> => {
  const actor = requirePermission(scope, 'issue:triage')
  const row = await issueRow(scope, number)
  const users =
    mode === 'add'
      ? await assignableUsers(scope, logins)
      : (await Promise.all(logins.map((login) => scope.accounts.findAccount(login)))).flatMap((account) => (account?.kind === 'user' ? [{ id: account.id, login: account.login }] : []))
  const before = (await hydrateIssues(scope.db, [row]))[0]!
  const statements = await assigneeChangeStatements(scope, row.id, actor, users, mode, scope.now())
  if (statements.length === 0) return before
  await scope.db.batch([...statements, sql('UPDATE issues SET updated_at = ? WHERE id = ?', scope.now(), row.id)])
  const after = await getIssue(scope, number)
  await emitIssueChanges(scope, before, after, actor)
  return after
}

export const listMilestones = async (
  scope: Scope,
  options: { readonly state?: IssueState | 'all'; readonly sort?: 'due_on' | 'completeness'; readonly direction?: 'asc' | 'desc' } = {},
  page: Page = DEFAULT_PAGE,
): Promise<Paged<Milestone>> => {
  const state = options.state ?? 'open'
  const where = state === 'all' ? 'repository_id = ?' : 'repository_id = ? AND state = ?'
  const params = state === 'all' ? [scope.repository.id] : [scope.repository.id, state]
  const direction = options.direction === 'desc' ? 'DESC' : 'ASC'
  const total = (await first<{ count: number }>(scope.db, sql(`SELECT COUNT(*) AS count FROM milestones WHERE ${where}`, ...params)))?.count ?? 0
  const rows = await scope.db.all<MilestoneRow>(
    sql(`SELECT * FROM milestones WHERE ${where} ORDER BY due_on IS NULL, due_on ${direction}, number ${direction} LIMIT ? OFFSET ?`, ...params, page.perPage, offset(page)),
  )
  return { items: await hydrateMilestones(scope.db, rows), total }
}

const milestoneRow = async (scope: Scope, number: number): Promise<MilestoneRow> => {
  const row = await first<MilestoneRow>(scope.db, sql('SELECT * FROM milestones WHERE repository_id = ? AND number = ?', scope.repository.id, number))
  if (!row) throw notFound()
  return row
}

export const getMilestone = async (scope: Scope, number: number): Promise<Milestone> => (await hydrateMilestones(scope.db, [await milestoneRow(scope, number)]))[0]!

export type MilestoneInput = { readonly title?: unknown; readonly description?: unknown; readonly state?: unknown; readonly dueOn?: unknown }

const milestoneFields = (input: MilestoneInput, fallback?: MilestoneRow) => {
  const title = input.title ?? fallback?.title
  if (typeof title !== 'string' || title.trim() === '' || title.length > 255) throw invalid('title must have 1 to 255 characters')
  const description = input.description === undefined ? (fallback?.description ?? null) : input.description
  if (description !== null && typeof description !== 'string') throw invalid('description must be a string')
  const state = input.state ?? fallback?.state ?? 'open'
  if (state !== 'open' && state !== 'closed') throw invalid('state must be open or closed')
  let dueOn = fallback?.due_on ?? null
  if (input.dueOn !== undefined) {
    if (input.dueOn === null) dueOn = null
    else if (typeof input.dueOn !== 'string' || Number.isNaN(Date.parse(input.dueOn))) throw invalid('due_on must be an ISO 8601 timestamp')
    else dueOn = Date.parse(input.dueOn)
  }
  return { title, description: description as string | null, state: state as IssueState, dueOn }
}

export const createMilestone = async (scope: Scope, input: MilestoneInput): Promise<Milestone> => {
  const creator = requirePermission(scope, 'milestone:manage')
  const fields = milestoneFields(input)
  if (await first(scope.db, sql('SELECT id FROM milestones WHERE repository_id = ? AND title = ?', scope.repository.id, fields.title))) {
    throw new CollaborationError(422, 'Validation Failed', [{ resource: 'Milestone', code: 'already_exists', field: 'title' }])
  }
  const node = nodeId('MI')
  const at = scope.now()
  await scope.db.run(
    sql(
      `INSERT INTO milestones (node_id, repository_id, number, title, description, state, due_on, creator_kind, creator_id, created_at, updated_at, closed_at)
       SELECT ?, ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM milestones WHERE repository_id = ?`,
      node,
      scope.repository.id,
      fields.title,
      fields.description,
      fields.state,
      fields.dueOn,
      creator.kind,
      creator.id,
      at,
      at,
      fields.state === 'closed' ? at : null,
      scope.repository.id,
    ),
  )
  const row = await first<MilestoneRow>(scope.db, sql('SELECT * FROM milestones WHERE node_id = ?', node))
  return (await hydrateMilestones(scope.db, [row!]))[0]!
}

export const updateMilestone = async (scope: Scope, number: number, input: MilestoneInput): Promise<Milestone> => {
  requirePermission(scope, 'milestone:manage')
  const row = await milestoneRow(scope, number)
  const fields = milestoneFields(input, row)
  const at = scope.now()
  await scope.db.run(
    sql(
      'UPDATE milestones SET title = ?, description = ?, state = ?, due_on = ?, updated_at = ?, closed_at = ? WHERE id = ?',
      fields.title,
      fields.description,
      fields.state,
      fields.dueOn,
      at,
      fields.state === 'closed' ? (row.closed_at ?? at) : null,
      row.id,
    ),
  )
  return getMilestone(scope, number)
}

export const deleteMilestone = async (scope: Scope, number: number): Promise<void> => {
  requirePermission(scope, 'milestone:manage')
  const row = await milestoneRow(scope, number)
  await scope.db.batch([sql('UPDATE issues SET milestone_id = NULL WHERE milestone_id = ?', row.id), sql('DELETE FROM milestones WHERE id = ?', row.id)])
}

export const hydrateEvents = async (db: Database, rows: readonly EventRow[]): Promise<IssueEvent[]> => {
  const users = await loadUsers(db, rows.map((row) => ({ kind: row.actor_kind, id: row.actor_id })))
  return rows.map((row) => ({
    id: row.id,
    nodeId: row.node_id,
    issueNumber: row.number,
    actor: users({ kind: row.actor_kind, id: row.actor_id }),
    event: row.event,
    data: JSON.parse(row.data) as Record<string, unknown>,
    createdAt: row.created_at,
  }))
}

export const listEvents = async (scope: Scope, number: number): Promise<IssueEvent[]> => {
  const row = await issueRow(scope, number)
  const rows = await scope.db.all<EventRow>(
    sql('SELECT e.id, e.node_id, i.number, e.actor_kind, e.actor_id, e.event, e.data, e.created_at FROM issue_events e JOIN issues i ON i.id = e.issue_id WHERE e.issue_id = ? ORDER BY e.id', row.id),
  )
  return hydrateEvents(scope.db, rows)
}

export const closeIssuesByReference = async (
  scope: Scope,
  text: readonly (string | null)[],
  actor: EventActor,
  data: Record<string, unknown>,
): Promise<number[]> => {
  const numbers = [...new Set(text.flatMap((entry) => localNumbers(parseClosingReferences(entry), scope.repo)))]
  if (numbers.length === 0) return []
  const rows = await allIn<IssueRow>(
    scope.db,
    (marks) => `SELECT * FROM issues WHERE repository_id = ? AND is_pull = 0 AND state = 'open' AND number IN (${marks})`,
    numbers,
    scope.repository.id,
  )
  const at = scope.now()
  const statements = rows.flatMap((row) => stateChangeStatements(row, actor, 'closed', 'completed', at, data))
  if (statements.length > 0) await scope.db.batch(statements)
  for (const row of rows) await emitActivity(scope, { kind: 'issues', action: 'closed', number: row.number, actor })
  return rows.map((row) => row.number)
}
