import { type Database, first, sql } from './database.ts'
import type { CheckState } from './protection.ts'

export type CheckRunStatus = 'queued' | 'in_progress' | 'completed'

export type CheckRunConclusion = 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | 'stale'

export type CheckRunRow = {
  readonly id: number
  readonly owner: string
  readonly repo: string
  readonly head_sha: string
  readonly name: string
  readonly app: string
  readonly status: CheckRunStatus
  readonly conclusion: CheckRunConclusion | null
  readonly external_id: string | null
  readonly details_url: string | null
  readonly title: string | null
  readonly summary: string | null
  readonly started_at: number | null
  readonly completed_at: number | null
  readonly created_at: number
  readonly updated_at: number
}

export type NewCheckRun = {
  readonly owner: string
  readonly repo: string
  readonly headSha: string
  readonly name: string
  readonly app: string
  readonly status: CheckRunStatus
  readonly conclusion?: CheckRunConclusion
  readonly externalId?: string
  readonly detailsUrl?: string
  readonly title?: string
  readonly summary?: string
}

export const createCheckRun = async (db: Database, check: NewCheckRun, now: number): Promise<CheckRunRow> => {
  const [row] = await db.all<CheckRunRow>(
    sql(
      'INSERT INTO check_runs (owner, repo, head_sha, name, app, status, conclusion, external_id, details_url, title, summary, started_at, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
      check.owner,
      check.repo,
      check.headSha,
      check.name,
      check.app,
      check.status,
      check.conclusion ?? null,
      check.externalId ?? null,
      check.detailsUrl ?? null,
      check.title ?? null,
      check.summary ?? null,
      check.status === 'queued' ? null : now,
      check.status === 'completed' ? now : null,
      now,
      now,
    ),
  )
  return row!
}

export type CheckRunUpdate = {
  readonly status: CheckRunStatus
  readonly conclusion?: CheckRunConclusion
  readonly title?: string
  readonly summary?: string
}

export const updateCheckRun = async (db: Database, id: number, update: CheckRunUpdate, now: number): Promise<void> => {
  await db.run(
    sql(
      "UPDATE check_runs SET status = ?, conclusion = ?, title = COALESCE(?, title), summary = COALESCE(?, summary), started_at = CASE WHEN ? != 'queued' THEN COALESCE(started_at, ?) ELSE started_at END, completed_at = CASE WHEN ? = 'completed' THEN ? ELSE NULL END, updated_at = ? WHERE id = ?",
      update.status,
      update.conclusion ?? null,
      update.title ?? null,
      update.summary ?? null,
      update.status,
      now,
      update.status,
      now,
      now,
      id,
    ),
  )
}

export const getCheckRun = async (db: Database, id: number): Promise<CheckRunRow | null> => first<CheckRunRow>(db, sql('SELECT * FROM check_runs WHERE id = ?', id))

export const listCheckRuns = async (db: Database, owner: string, repo: string, headSha: string): Promise<CheckRunRow[]> =>
  db.all<CheckRunRow>(sql('SELECT * FROM check_runs WHERE owner = ? AND repo = ? AND head_sha = ? ORDER BY id', owner, repo, headSha))

export const checkStateOf = (check: Pick<CheckRunRow, 'status' | 'conclusion'>): CheckState => {
  if (check.status !== 'completed') return 'pending'
  if (check.conclusion === 'success' || check.conclusion === 'neutral' || check.conclusion === 'skipped') return check.conclusion
  return 'failure'
}

export const commitCheckStates = async (db: Database, owner: string, repo: string, headSha: string): Promise<Record<string, CheckState>> => {
  const latest = new Map<string, CheckRunRow>()
  for (const check of await listCheckRuns(db, owner, repo, headSha)) latest.set(check.name, check)
  return Object.fromEntries([...latest].map(([name, check]) => [name, checkStateOf(check)]))
}
