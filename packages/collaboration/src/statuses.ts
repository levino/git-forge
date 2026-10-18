import { type CheckState, type Database, first, sql } from '@git-forge/accounts'
import type { ObjectId } from '@git-forge/core'
import { actorColumns, loadUsers, type UserSummary } from './actors.ts'
import { type EventActor, invalid, nodeId, notFound, requirePermission, type Scope } from './context.ts'
import { resolveCommitish } from './git.ts'
import { DEFAULT_PAGE, offset, type Page, type Paged } from './issues.ts'

export const STATUS_STATES = ['error', 'failure', 'pending', 'success'] as const

export type StatusState = (typeof STATUS_STATES)[number]

export type CommitStatus = {
  readonly id: number
  readonly nodeId: string
  readonly sha: ObjectId
  readonly context: string
  readonly state: StatusState
  readonly targetUrl: string | null
  readonly description: string | null
  readonly creator: UserSummary
  readonly createdAt: number
}

export const CHECK_STATUSES = ['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending'] as const

export type CheckStatus = (typeof CHECK_STATUSES)[number]

export const CHECK_CONCLUSIONS = ['action_required', 'cancelled', 'failure', 'neutral', 'success', 'skipped', 'stale', 'timed_out'] as const

export type CheckConclusion = (typeof CHECK_CONCLUSIONS)[number]

export type CheckRun = {
  readonly id: number
  readonly nodeId: string
  readonly headSha: ObjectId
  readonly name: string
  readonly status: CheckStatus
  readonly conclusion: CheckConclusion | null
  readonly externalId: string | null
  readonly detailsUrl: string | null
  readonly output: { readonly title: string | null; readonly summary: string | null; readonly text: string | null }
  readonly creator: UserSummary
  readonly startedAt: number | null
  readonly completedAt: number | null
  readonly createdAt: number
  readonly updatedAt: number
}

type StatusRow = {
  id: number
  node_id: string
  sha: string
  context: string
  state: StatusState
  target_url: string | null
  description: string | null
  creator_kind: string
  creator_id: string | null
  created_at: number
}

type CheckRow = {
  id: number
  node_id: string
  head_sha: string
  name: string
  status: CheckStatus
  conclusion: CheckConclusion | null
  external_id: string | null
  details_url: string | null
  output_title: string | null
  output_summary: string | null
  output_text: string | null
  creator_kind: string
  creator_id: string | null
  started_at: number | null
  completed_at: number | null
  created_at: number
  updated_at: number
}

export type StatusInput = {
  readonly state: unknown
  readonly context?: unknown
  readonly targetUrl?: unknown
  readonly description?: unknown
}

const optionalText = (value: unknown, name: string, max: number): string | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > max) throw invalid(`${name} must be a string of at most ${max} characters`)
  return value
}

const isoTime = (value: unknown, name: string): number | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw invalid(`${name} must be an ISO 8601 timestamp`)
  return Date.parse(value)
}

export const recordCommitStatus = async (db: Database, repositoryId: string, sha: ObjectId, input: StatusInput, creator: EventActor, at: number): Promise<number> => {
  if (!STATUS_STATES.includes(input.state as StatusState)) throw invalid('state must be error, failure, pending or success')
  const context = optionalText(input.context, 'context', 255) ?? 'default'
  if (context.trim() === '') throw invalid('context must not be empty')
  const node = nodeId('SC')
  const [kind, id] = actorColumns(creator)
  await db.run(
    sql(
      'INSERT INTO commit_statuses (node_id, repository_id, sha, context, state, target_url, description, creator_kind, creator_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      node,
      repositoryId,
      sha,
      context,
      input.state as StatusState,
      optionalText(input.targetUrl, 'target_url', 2048),
      optionalText(input.description, 'description', 1024),
      kind,
      id,
      at,
    ),
  )
  return (await first<{ id: number }>(db, sql('SELECT id FROM commit_statuses WHERE node_id = ?', node)))!.id
}

const hydrateStatuses = async (db: Database, rows: readonly StatusRow[]): Promise<CommitStatus[]> => {
  const users = await loadUsers(db, rows.map((row) => ({ kind: row.creator_kind, id: row.creator_id })))
  return rows.map((row) => ({
    id: row.id,
    nodeId: row.node_id,
    sha: row.sha,
    context: row.context,
    state: row.state,
    targetUrl: row.target_url,
    description: row.description,
    creator: users({ kind: row.creator_kind, id: row.creator_id }),
    createdAt: row.created_at,
  }))
}

const requireCommit = async (scope: Scope, ref: string): Promise<ObjectId> => {
  const sha = await resolveCommitish(scope, ref)
  if (!sha) throw invalid(`No commit found for SHA: ${ref}`)
  return sha
}

export const createStatus = async (scope: Scope, ref: string, input: StatusInput): Promise<CommitStatus> => {
  const creator = requirePermission(scope, 'status:write')
  const sha = await requireCommit(scope, ref)
  const id = await recordCommitStatus(scope.db, scope.repository.id, sha, input, creator, scope.now())
  const row = await first<StatusRow>(scope.db, sql('SELECT * FROM commit_statuses WHERE id = ?', id))
  return (await hydrateStatuses(scope.db, [row!]))[0]!
}

export const listStatuses = async (scope: Scope, ref: string, page: Page = DEFAULT_PAGE): Promise<Paged<CommitStatus>> => {
  const sha = await resolveCommitish(scope, ref)
  if (!sha) throw notFound()
  const total = (await first<{ count: number }>(scope.db, sql('SELECT COUNT(*) AS count FROM commit_statuses WHERE repository_id = ? AND sha = ?', scope.repository.id, sha)))?.count ?? 0
  const rows = await scope.db.all<StatusRow>(
    sql('SELECT * FROM commit_statuses WHERE repository_id = ? AND sha = ? ORDER BY id DESC LIMIT ? OFFSET ?', scope.repository.id, sha, page.perPage, offset(page)),
  )
  return { items: await hydrateStatuses(scope.db, rows), total }
}

const latestStatuses = (db: Database, repositoryId: string, sha: ObjectId) =>
  db.all<StatusRow>(
    sql(
      `SELECT s.* FROM commit_statuses s WHERE s.repository_id = ? AND s.sha = ?
       AND s.id = (SELECT MAX(t.id) FROM commit_statuses t WHERE t.repository_id = s.repository_id AND t.sha = s.sha AND t.context = s.context) ORDER BY s.context`,
      repositoryId,
      sha,
    ),
  )

export type CombinedStatus = {
  readonly sha: ObjectId
  readonly state: 'failure' | 'pending' | 'success'
  readonly statuses: readonly CommitStatus[]
}

export const combineStates = (states: readonly StatusState[]): CombinedStatus['state'] => {
  if (states.some((state) => state === 'error' || state === 'failure')) return 'failure'
  if (states.length === 0 || states.some((state) => state === 'pending')) return 'pending'
  return 'success'
}

export const combinedStatus = async (scope: Scope, ref: string): Promise<CombinedStatus> => {
  const sha = await resolveCommitish(scope, ref)
  if (!sha) throw notFound()
  const statuses = await hydrateStatuses(scope.db, await latestStatuses(scope.db, scope.repository.id, sha))
  return { sha, state: combineStates(statuses.map((status) => status.state)), statuses }
}

export type CheckRunInput = {
  readonly name?: unknown
  readonly headSha?: unknown
  readonly status?: unknown
  readonly conclusion?: unknown
  readonly externalId?: unknown
  readonly detailsUrl?: unknown
  readonly startedAt?: unknown
  readonly completedAt?: unknown
  readonly output?: unknown
}

const checkFields = (input: CheckRunInput, fallback: CheckRow | null, at: number) => {
  const name = input.name ?? fallback?.name
  if (typeof name !== 'string' || name.trim() === '' || name.length > 255) throw invalid('name must have 1 to 255 characters')
  let conclusion = input.conclusion === undefined ? (fallback?.conclusion ?? null) : input.conclusion
  if (conclusion !== null && !CHECK_CONCLUSIONS.includes(conclusion as CheckConclusion)) throw invalid(`conclusion must be one of ${CHECK_CONCLUSIONS.join(', ')}`)
  let status = input.status ?? (input.conclusion !== undefined && input.conclusion !== null ? 'completed' : (fallback?.status ?? 'queued'))
  if (!CHECK_STATUSES.includes(status as CheckStatus)) throw invalid(`status must be one of ${CHECK_STATUSES.join(', ')}`)
  if (status === 'completed' && conclusion === null) throw invalid('conclusion is required when status is completed')
  if (conclusion !== null) status = 'completed'
  if (status !== 'completed') conclusion = null
  const output = input.output === undefined || input.output === null ? null : input.output
  if (output !== null && (typeof output !== 'object' || Array.isArray(output))) throw invalid('output must be an object')
  const outputRecord = (output ?? {}) as Record<string, unknown>
  const started = isoTime(input.startedAt, 'started_at') ?? fallback?.started_at ?? (status === 'in_progress' || status === 'completed' ? at : null)
  const completed = isoTime(input.completedAt, 'completed_at') ?? (status === 'completed' ? (fallback?.completed_at ?? at) : null)
  return {
    name,
    status: status as CheckStatus,
    conclusion: conclusion as CheckConclusion | null,
    externalId: input.externalId === undefined ? (fallback?.external_id ?? null) : optionalText(input.externalId, 'external_id', 255),
    detailsUrl: input.detailsUrl === undefined ? (fallback?.details_url ?? null) : optionalText(input.detailsUrl, 'details_url', 2048),
    title: output ? optionalText(outputRecord.title, 'output.title', 1024) : (fallback?.output_title ?? null),
    summary: output ? optionalText(outputRecord.summary, 'output.summary', 65_535) : (fallback?.output_summary ?? null),
    text: output ? optionalText(outputRecord.text, 'output.text', 65_535) : (fallback?.output_text ?? null),
    startedAt: started,
    completedAt: completed,
  }
}

export const recordCheckRun = async (db: Database, repositoryId: string, sha: ObjectId, input: CheckRunInput, creator: EventActor, at: number): Promise<number> => {
  const fields = checkFields(input, null, at)
  const node = nodeId('CR')
  const [kind, id] = actorColumns(creator)
  await db.run(
    sql(
      `INSERT INTO check_runs (node_id, repository_id, head_sha, name, status, conclusion, external_id, details_url, output_title, output_summary, output_text,
         creator_kind, creator_id, started_at, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      node,
      repositoryId,
      sha,
      fields.name,
      fields.status,
      fields.conclusion,
      fields.externalId,
      fields.detailsUrl,
      fields.title,
      fields.summary,
      fields.text,
      kind,
      id,
      fields.startedAt,
      fields.completedAt,
      at,
      at,
    ),
  )
  return (await first<{ id: number }>(db, sql('SELECT id FROM check_runs WHERE node_id = ?', node)))!.id
}

export const updateCheckRunRecord = async (db: Database, repositoryId: string, id: number, input: CheckRunInput, at: number): Promise<boolean> => {
  const row = await first<CheckRow>(db, sql('SELECT * FROM check_runs WHERE id = ? AND repository_id = ?', id, repositoryId))
  if (!row) return false
  const fields = checkFields(input, row, at)
  await db.run(
    sql(
      `UPDATE check_runs SET name = ?, status = ?, conclusion = ?, external_id = ?, details_url = ?, output_title = ?, output_summary = ?, output_text = ?,
         started_at = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
      fields.name,
      fields.status,
      fields.conclusion,
      fields.externalId,
      fields.detailsUrl,
      fields.title,
      fields.summary,
      fields.text,
      fields.startedAt,
      fields.completedAt,
      at,
      id,
    ),
  )
  return true
}

const hydrateChecks = async (db: Database, rows: readonly CheckRow[]): Promise<CheckRun[]> => {
  const users = await loadUsers(db, rows.map((row) => ({ kind: row.creator_kind, id: row.creator_id })))
  return rows.map((row) => ({
    id: row.id,
    nodeId: row.node_id,
    headSha: row.head_sha,
    name: row.name,
    status: row.status,
    conclusion: row.conclusion,
    externalId: row.external_id,
    detailsUrl: row.details_url,
    output: { title: row.output_title, summary: row.output_summary, text: row.output_text },
    creator: users({ kind: row.creator_kind, id: row.creator_id }),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

export const getCheckRun = async (scope: Scope, id: number): Promise<CheckRun> => {
  const row = await first<CheckRow>(scope.db, sql('SELECT * FROM check_runs WHERE id = ? AND repository_id = ?', id, scope.repository.id))
  if (!row) throw notFound()
  return (await hydrateChecks(scope.db, [row]))[0]!
}

export const createCheckRun = async (scope: Scope, input: CheckRunInput): Promise<CheckRun> => {
  const creator = requirePermission(scope, 'status:write')
  if (typeof input.headSha !== 'string') throw invalid('head_sha is required')
  const sha = await requireCommit(scope, input.headSha)
  return getCheckRun(scope, await recordCheckRun(scope.db, scope.repository.id, sha, input, creator, scope.now()))
}

export const updateCheckRun = async (scope: Scope, id: number, input: CheckRunInput): Promise<CheckRun> => {
  requirePermission(scope, 'status:write')
  if (!(await updateCheckRunRecord(scope.db, scope.repository.id, id, input, scope.now()))) throw notFound()
  return getCheckRun(scope, id)
}

export const listCheckRuns = async (
  scope: Scope,
  ref: string,
  filters: { readonly name?: string; readonly status?: string; readonly latest?: boolean } = {},
  page: Page = DEFAULT_PAGE,
): Promise<Paged<CheckRun>> => {
  const sha = await resolveCommitish(scope, ref)
  if (!sha) throw notFound()
  const where = ['c.repository_id = ?', 'c.head_sha = ?']
  const params: (string | number)[] = [scope.repository.id, sha]
  if (filters.name !== undefined) {
    where.push('c.name = ?')
    params.push(filters.name)
  }
  if (filters.status !== undefined) {
    where.push('c.status = ?')
    params.push(filters.status)
  }
  if (filters.latest !== false) where.push('c.id = (SELECT MAX(d.id) FROM check_runs d WHERE d.repository_id = c.repository_id AND d.head_sha = c.head_sha AND d.name = c.name)')
  const clause = where.join(' AND ')
  const total = (await first<{ count: number }>(scope.db, sql(`SELECT COUNT(*) AS count FROM check_runs c WHERE ${clause}`, ...params)))?.count ?? 0
  const rows = await scope.db.all<CheckRow>(sql(`SELECT c.* FROM check_runs c WHERE ${clause} ORDER BY c.id DESC LIMIT ? OFFSET ?`, ...params, page.perPage, offset(page)))
  return { items: await hydrateChecks(scope.db, rows), total }
}

const STATUS_CHECK_STATE: Readonly<Record<StatusState, CheckState>> = { error: 'error', failure: 'failure', pending: 'pending', success: 'success' }

const CONCLUSION_STATE: Readonly<Record<CheckConclusion, CheckState>> = {
  action_required: 'failure',
  cancelled: 'failure',
  failure: 'failure',
  neutral: 'neutral',
  success: 'success',
  skipped: 'skipped',
  stale: 'failure',
  timed_out: 'failure',
}

const SEVERITY: readonly CheckState[] = ['success', 'neutral', 'skipped', 'pending', 'failure', 'error']

export const checkStates = async (db: Database, repositoryId: string, sha: ObjectId): Promise<Record<string, CheckState>> => {
  const states: Record<string, CheckState> = {}
  const put = (name: string, state: CheckState) => {
    const existing = states[name]
    if (existing === undefined || SEVERITY.indexOf(state) > SEVERITY.indexOf(existing)) states[name] = state
  }
  for (const row of await latestStatuses(db, repositoryId, sha)) put(row.context, STATUS_CHECK_STATE[row.state])
  const checks = await db.all<CheckRow>(
    sql(
      'SELECT c.* FROM check_runs c WHERE c.repository_id = ? AND c.head_sha = ? AND c.id = (SELECT MAX(d.id) FROM check_runs d WHERE d.repository_id = c.repository_id AND d.head_sha = c.head_sha AND d.name = c.name)',
      repositoryId,
      sha,
    ),
  )
  for (const row of checks) put(row.name, row.status === 'completed' && row.conclusion ? CONCLUSION_STATE[row.conclusion] : 'pending')
  return states
}
