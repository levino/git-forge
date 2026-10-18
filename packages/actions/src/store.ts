import { base64UrlEncode, type Database, first, randomBytes, sha256Hex, sql, utf8 } from '@git-forge/accounts'
import type { RunnerPublicKey } from './keys.ts'

export type TokenKind = 'registration' | 'runner' | 'runtime' | 'github'

export type RunnerRow = {
  readonly id: number
  readonly name: string
  readonly client_id: string
  readonly owner: string
  readonly repo: string
  readonly labels: string
  readonly public_key: string
  readonly ephemeral: number
  readonly job_id: string | null
  readonly status: string
  readonly created_at: number
  readonly removed_at: number | null
}

export type Runner = {
  readonly id: number
  readonly name: string
  readonly clientId: string
  readonly owner: string
  readonly repo: string
  readonly labels: readonly string[]
  readonly publicKey: RunnerPublicKey
  readonly ephemeral: boolean
  readonly jobId: string | null
  readonly status: string
  readonly createdAt: number
}

export type JobStatus = 'pending' | 'queued' | 'assigned' | 'in_progress' | 'completed'

export type JobRow = {
  readonly request_id: number
  readonly id: string
  readonly run_id: number
  readonly job_key: string
  readonly display_name: string
  readonly labels: string
  readonly needs: string
  readonly definition: string
  readonly plan_id: string
  readonly timeline_id: string
  readonly status: JobStatus
  readonly conclusion: string | null
  readonly runner_id: number | null
  readonly session_id: string | null
  readonly queued_at: number
  readonly assigned_at: number | null
  readonly started_at: number | null
  readonly completed_at: number | null
  readonly locked_until: number | null
  readonly attempt: number
  readonly expanded: number
  readonly matrix: string | null
  readonly outputs: string | null
  readonly environment: string | null
  readonly approval: 'waiting' | 'approved' | 'rejected' | null
  readonly reviewed_by: string | null
  readonly message_acked_at: number | null
  readonly cancel_requested_at: number | null
  readonly cancel_reason: string | null
  readonly cancel_delivered_at: number | null
  readonly launches: number
  readonly check_run_id: number | null
}

export type RunRow = {
  readonly id: number
  readonly owner: string
  readonly repo: string
  readonly workflow_path: string
  readonly workflow_name: string
  readonly event: string
  readonly ref: string
  readonly sha: string
  readonly actor: string
  readonly created_at: number
  readonly definition: string | null
  readonly attempt: number
  readonly trusted: number
  readonly concurrency_group: string | null
  readonly cancelled_at: number | null
  readonly completed_at: number | null
  readonly conclusion: string | null
}

export type TokenRow = {
  readonly hash: string
  readonly kind: TokenKind
  readonly runner_id: number | null
  readonly job_id: string | null
  readonly owner: string | null
  readonly repo: string | null
  readonly expires_at: number
}

export type SessionRow = {
  readonly id: string
  readonly runner_id: number
  readonly owner_name: string
  readonly created_at: number
  readonly last_seen_at: number
  readonly closed_at: number | null
}

const toRunner = (row: RunnerRow): Runner => ({
  id: row.id,
  name: row.name,
  clientId: row.client_id,
  owner: row.owner,
  repo: row.repo,
  labels: JSON.parse(row.labels) as string[],
  publicKey: JSON.parse(row.public_key) as RunnerPublicKey,
  ephemeral: row.ephemeral === 1,
  jobId: row.job_id,
  status: row.status,
  createdAt: row.created_at,
})

export type NewRunner = {
  readonly name: string
  readonly owner: string
  readonly repo: string
  readonly labels: readonly string[]
  readonly publicKey: RunnerPublicKey
  readonly ephemeral: boolean
  readonly jobId?: string
}

export class RunnerExistsError extends Error {}

export const createRunner = async (db: Database, runner: NewRunner, now: number): Promise<Runner> => {
  if (await first(db, sql('SELECT id FROM actions_runners WHERE name = ? AND removed_at IS NULL', runner.name))) throw new RunnerExistsError(runner.name)
  const clientId = crypto.randomUUID()
  await db.run(
    sql(
      'INSERT INTO actions_runners (name, client_id, owner, repo, labels, public_key, ephemeral, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      runner.name,
      clientId,
      runner.owner,
      runner.repo,
      JSON.stringify(runner.labels),
      JSON.stringify(runner.publicKey),
      runner.ephemeral ? 1 : 0,
      runner.jobId ?? null,
      now,
    ),
  )
  const row = await first<RunnerRow>(db, sql('SELECT * FROM actions_runners WHERE client_id = ?', clientId))
  return toRunner(row!)
}

export const getRunnerIncludingRemoved = async (db: Database, id: number): Promise<Runner | null> => {
  const row = await first<RunnerRow>(db, sql('SELECT * FROM actions_runners WHERE id = ?', id))
  return row ? toRunner(row) : null
}

export const getRunner = async (db: Database, id: number): Promise<Runner | null> => {
  const row = await first<RunnerRow>(db, sql('SELECT * FROM actions_runners WHERE id = ? AND removed_at IS NULL', id))
  return row ? toRunner(row) : null
}

export const getRunnerByClientId = async (db: Database, clientId: string): Promise<Runner | null> => {
  const row = await first<RunnerRow>(db, sql('SELECT * FROM actions_runners WHERE client_id = ? AND removed_at IS NULL', clientId))
  return row ? toRunner(row) : null
}

export const listRunners = async (db: Database, owner: string, repo: string, name?: string): Promise<Runner[]> => {
  const rows = await db.all<RunnerRow>(
    name === undefined
      ? sql('SELECT * FROM actions_runners WHERE owner = ? AND repo = ? AND removed_at IS NULL ORDER BY id', owner, repo)
      : sql('SELECT * FROM actions_runners WHERE owner = ? AND repo = ? AND name = ? AND removed_at IS NULL ORDER BY id', owner, repo, name),
  )
  return rows.map(toRunner)
}

export const removeRunner = async (db: Database, id: number, now: number): Promise<boolean> =>
  (await db.batch([
    sql('UPDATE actions_runners SET removed_at = ?, status = ? WHERE id = ? AND removed_at IS NULL', now, 'offline', id),
    sql('UPDATE actions_tokens SET expires_at = ? WHERE runner_id = ? AND expires_at > ?', now, id, now),
  ]))[0]!.changes === 1

export const setRunnerStatus = async (db: Database, id: number, status: 'online' | 'offline'): Promise<void> => {
  await db.run(sql('UPDATE actions_runners SET status = ? WHERE id = ?', status, id))
}

export type TokenGrant = {
  readonly kind: TokenKind
  readonly runnerId?: number
  readonly jobId?: string
  readonly owner?: string
  readonly repo?: string
  readonly scope?: string
  readonly ttlMs: number
}

export const GITHUB_TOKEN_PREFIX = 'gfs_'

export const TOKEN_ISSUER = 'git-forge-actions'

const base64UrlJson = (value: unknown): string => base64UrlEncode(utf8(JSON.stringify(value)))

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

const mintToken = (grant: TokenGrant, now: number): string => {
  if (grant.kind === 'github') return `${GITHUB_TOKEN_PREFIX}${base64UrlEncode(randomBytes(32))}`
  const seconds = Math.floor(now / 1000)
  const payload = {
    iss: TOKEN_ISSUER,
    aud: TOKEN_ISSUER,
    sub: grant.kind,
    jti: crypto.randomUUID(),
    nbf: seconds - 60,
    iat: seconds,
    exp: Math.floor((now + grant.ttlMs) / 1000),
    ...(grant.jobId ? { orchid: grant.jobId } : {}),
    ...(grant.scope ? { scp: grant.scope } : {}),
  }
  return `${base64UrlJson({ typ: 'JWT', alg: 'HS256' })}.${base64UrlJson(payload)}.${base64UrlEncode(randomBytes(32))}`
}

export const issueToken = async (db: Database, grant: TokenGrant, now: number): Promise<string> => {
  const token = mintToken(grant, now)
  await db.run(
    sql(
      'INSERT INTO actions_tokens (hash, kind, runner_id, job_id, owner, repo, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      await sha256Hex(token),
      grant.kind,
      grant.runnerId ?? null,
      grant.jobId ?? null,
      grant.owner ?? null,
      grant.repo ?? null,
      now + grant.ttlMs,
    ),
  )
  return token
}

export const verifyToken = async (db: Database, token: string, kind: TokenKind, now: number): Promise<TokenRow | null> => {
  if (kind === 'github' ? !token.startsWith(GITHUB_TOKEN_PREFIX) : !JWT_SHAPE.test(token)) return null
  const row = await first<TokenRow>(db, sql('SELECT * FROM actions_tokens WHERE hash = ?', await sha256Hex(token)))
  return row && row.kind === kind && row.expires_at > now ? row : null
}

export const revokeJobTokens = async (db: Database, jobId: string, now: number): Promise<void> => {
  await db.batch([
    sql('UPDATE actions_tokens SET expires_at = ? WHERE job_id = ? AND expires_at > ?', now, jobId, now),
    sql('UPDATE actions_blob_grants SET expires_at = ? WHERE job_id = ? AND expires_at > ?', now, jobId, now),
  ])
}

export const resultsScope = (runId: number, jobId: string): string => `Actions.Results:${runId}:${jobId}`

export const createSession = async (db: Database, runnerId: number, ownerName: string, now: number): Promise<string> => {
  const id = crypto.randomUUID()
  await db.batch([
    sql('INSERT INTO actions_sessions (id, runner_id, owner_name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)', id, runnerId, ownerName, now, now),
    sql('UPDATE actions_runners SET status = ? WHERE id = ?', 'online', runnerId),
  ])
  return id
}

export const getSession = async (db: Database, id: string): Promise<SessionRow | null> =>
  first<SessionRow>(db, sql('SELECT * FROM actions_sessions WHERE id = ? AND closed_at IS NULL', id))

export const touchSession = async (db: Database, id: string, now: number): Promise<void> => {
  await db.run(sql('UPDATE actions_sessions SET last_seen_at = ? WHERE id = ?', now, id))
}

export const closeSession = async (db: Database, id: string, runnerId: number, now: number): Promise<void> => {
  await db.batch([
    sql('UPDATE actions_sessions SET closed_at = ? WHERE id = ? AND runner_id = ? AND closed_at IS NULL', now, id, runnerId),
    sql("UPDATE actions_jobs SET status = 'queued', session_id = NULL, assigned_at = NULL, message_acked_at = NULL WHERE session_id = ? AND runner_id = ? AND status = 'assigned'", id, runnerId),
    sql('UPDATE actions_runners SET status = ? WHERE id = ?', 'offline', runnerId),
  ])
}

export type NewRun = {
  readonly owner: string
  readonly repo: string
  readonly workflow_path: string
  readonly workflow_name: string
  readonly event: string
  readonly ref: string
  readonly sha: string
  readonly actor: string
  readonly definition?: unknown
  readonly trusted?: boolean
  readonly concurrency_group?: string | null
}

export const createRun = async (db: Database, run: NewRun, now: number): Promise<number> => {
  const [row] = await db.all<{ id: number }>(
    sql(
      'INSERT INTO actions_runs (owner, repo, workflow_path, workflow_name, event, ref, sha, actor, created_at, definition, trusted, concurrency_group) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
      run.owner,
      run.repo,
      run.workflow_path,
      run.workflow_name,
      run.event,
      run.ref,
      run.sha,
      run.actor,
      now,
      run.definition === undefined ? null : JSON.stringify(run.definition),
      run.trusted === false ? 0 : 1,
      run.concurrency_group ?? null,
    ),
  )
  return row!.id
}

export const completeRun = async (db: Database, id: number, conclusion: string, now: number): Promise<boolean> =>
  (await db.run(sql('UPDATE actions_runs SET completed_at = ?, conclusion = ? WHERE id = ? AND completed_at IS NULL', now, conclusion, id))).changes === 1

export const markRunCancelled = async (db: Database, id: number, now: number): Promise<boolean> =>
  (await db.run(sql('UPDATE actions_runs SET cancelled_at = ? WHERE id = ? AND cancelled_at IS NULL AND completed_at IS NULL', now, id))).changes === 1

export const startRunAttempt = async (db: Database, id: number, attempt: number): Promise<boolean> =>
  (
    await db.run(
      sql('UPDATE actions_runs SET attempt = ?, completed_at = NULL, conclusion = NULL, cancelled_at = NULL WHERE id = ? AND attempt = ? AND completed_at IS NOT NULL', attempt, id, attempt - 1),
    )
  ).changes === 1

export const activeRunsInGroup = async (db: Database, owner: string, repo: string, group: string): Promise<RunRow[]> =>
  db.all<RunRow>(sql('SELECT * FROM actions_runs WHERE owner = ? AND repo = ? AND concurrency_group = ? AND completed_at IS NULL ORDER BY id', owner, repo, group))

export const listRuns = async (db: Database, owner: string, repo: string, limit = 30): Promise<RunRow[]> =>
  db.all<RunRow>(sql('SELECT * FROM actions_runs WHERE owner = ? AND repo = ? ORDER BY id DESC LIMIT ?', owner, repo, limit))

export const getRun = async (db: Database, id: number): Promise<RunRow | null> => first<RunRow>(db, sql('SELECT * FROM actions_runs WHERE id = ?', id))

export type NewJob = {
  readonly runId: number
  readonly jobKey: string
  readonly displayName: string
  readonly labels: readonly string[]
  readonly needs: readonly string[]
  readonly definition: unknown
  readonly attempt?: number
  readonly expanded?: boolean
  readonly status?: JobStatus
  readonly matrix?: unknown
  readonly environment?: string | null
  readonly approval?: 'waiting' | null
}

export const createJob = async (db: Database, job: NewJob, now: number): Promise<JobRow> => {
  const id = crypto.randomUUID()
  await db.run(
    sql(
      'INSERT INTO actions_jobs (id, run_id, job_key, display_name, labels, needs, definition, plan_id, timeline_id, status, queued_at, attempt, expanded, matrix, environment, approval) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      job.runId,
      job.jobKey,
      job.displayName,
      JSON.stringify(job.labels),
      JSON.stringify(job.needs),
      JSON.stringify(job.definition),
      crypto.randomUUID(),
      crypto.randomUUID(),
      job.status ?? (job.needs.length === 0 ? 'queued' : 'pending'),
      now,
      job.attempt ?? 1,
      job.expanded === false ? 0 : 1,
      job.matrix === undefined || job.matrix === null ? null : JSON.stringify(job.matrix),
      job.environment ?? null,
      job.approval ?? null,
    ),
  )
  return (await getJobById(db, id))!
}

export type LegUpdate = {
  readonly displayName: string
  readonly labels: readonly string[]
  readonly definition: unknown
  readonly status: 'pending' | 'queued'
  readonly matrix: unknown
  readonly environment: string | null
  readonly approval: 'waiting' | null
}

export const expandPlaceholder = async (db: Database, requestId: number, leg: LegUpdate): Promise<boolean> =>
  (
    await db.run(
      sql(
        "UPDATE actions_jobs SET display_name = ?, labels = ?, definition = ?, status = ?, matrix = ?, environment = ?, approval = ?, expanded = 1 WHERE request_id = ? AND expanded = 0 AND status = 'pending'",
        leg.displayName,
        JSON.stringify(leg.labels),
        JSON.stringify(leg.definition),
        leg.status,
        leg.matrix === null ? null : JSON.stringify(leg.matrix),
        leg.environment,
        leg.approval,
        requestId,
      ),
    )
  ).changes === 1

export const finishPending = async (db: Database, requestId: number, conclusion: string, reason: string | null, now: number): Promise<boolean> =>
  (
    await db.run(
      sql(
        "UPDATE actions_jobs SET status = 'completed', conclusion = ?, cancel_reason = COALESCE(?, cancel_reason), completed_at = ?, expanded = 1 WHERE request_id = ? AND status IN ('pending', 'queued') AND session_id IS NULL",
        conclusion,
        reason,
        now,
        requestId,
      ),
    )
  ).changes === 1

export const requestJobCancel = async (db: Database, requestId: number, reason: string, now: number): Promise<boolean> =>
  (
    await db.run(
      sql(
        "UPDATE actions_jobs SET cancel_requested_at = ?, cancel_reason = ? WHERE request_id = ? AND status IN ('assigned', 'in_progress') AND cancel_requested_at IS NULL",
        now,
        reason,
        requestId,
      ),
    )
  ).changes === 1

export const pendingCancellation = async (db: Database, sessionId: string): Promise<JobRow | null> =>
  first<JobRow>(
    db,
    sql(
      "SELECT * FROM actions_jobs WHERE session_id = ? AND status IN ('assigned', 'in_progress') AND cancel_requested_at IS NOT NULL AND cancel_delivered_at IS NULL ORDER BY request_id LIMIT 1",
      sessionId,
    ),
  )

export const markCancelDelivered = async (db: Database, requestId: number, now: number): Promise<boolean> =>
  (await db.run(sql('UPDATE actions_jobs SET cancel_delivered_at = ? WHERE request_id = ? AND cancel_delivered_at IS NULL', now, requestId))).changes === 1

export const acknowledgeMessage = async (db: Database, requestId: number, sessionId: string, now: number): Promise<void> => {
  await db.run(sql('UPDATE actions_jobs SET message_acked_at = COALESCE(message_acked_at, ?) WHERE request_id = ? AND session_id = ?', now, requestId, sessionId))
}

export const setJobOutputs = async (db: Database, requestId: number, outputs: Readonly<Record<string, string>>): Promise<void> => {
  await db.run(sql('UPDATE actions_jobs SET outputs = ? WHERE request_id = ?', JSON.stringify(outputs), requestId))
}

export const setJobApproval = async (db: Database, requestId: number, approval: 'approved' | 'rejected', reviewer: string): Promise<boolean> =>
  (
    await db.run(
      sql("UPDATE actions_jobs SET approval = ?, reviewed_by = ? WHERE request_id = ? AND approval = 'waiting' AND status = 'pending'", approval, reviewer, requestId),
    )
  ).changes === 1

export const setCheckRunId = async (db: Database, requestId: number, checkRunId: number): Promise<void> => {
  await db.run(sql('UPDATE actions_jobs SET check_run_id = ? WHERE request_id = ?', checkRunId, requestId))
}

export const recordLaunch = async (db: Database, requestId: number): Promise<void> => {
  await db.run(sql('UPDATE actions_jobs SET launches = launches + 1 WHERE request_id = ?', requestId))
}

export const requeueJob = async (db: Database, requestId: number): Promise<boolean> =>
  (
    await db.run(
      sql(
        "UPDATE actions_jobs SET status = 'queued', runner_id = NULL, session_id = NULL, assigned_at = NULL, message_acked_at = NULL WHERE request_id = ? AND status IN ('queued', 'assigned')",
        requestId,
      ),
    )
  ).changes === 1

export const listCurrentJobs = async (db: Database, runId: number): Promise<JobRow[]> =>
  db.all<JobRow>(
    sql(
      'SELECT * FROM actions_jobs AS j WHERE run_id = ? AND attempt = (SELECT MAX(attempt) FROM actions_jobs WHERE run_id = j.run_id AND job_key = j.job_key) ORDER BY request_id',
      runId,
    ),
  )

export const listJobsByStatus = async (db: Database, statuses: readonly JobStatus[], limit = 200): Promise<JobRow[]> =>
  db.all<JobRow>(sql(`SELECT * FROM actions_jobs WHERE status IN (${statuses.map(() => '?').join(', ')}) ORDER BY request_id LIMIT ?`, ...statuses, limit))

export const listStaleSessions = async (db: Database, before: number): Promise<SessionRow[]> =>
  db.all<SessionRow>(sql('SELECT * FROM actions_sessions WHERE closed_at IS NULL AND last_seen_at < ? LIMIT 200', before))

export const deleteExpiredTokens = async (db: Database, before: number): Promise<number> => {
  const [tokens, grants] = await db.batch([sql('DELETE FROM actions_tokens WHERE expires_at < ?', before), sql('DELETE FROM actions_blob_grants WHERE expires_at < ?', before)])
  return tokens!.changes + grants!.changes
}

export const getJob = async (db: Database, requestId: number): Promise<JobRow | null> => first<JobRow>(db, sql('SELECT * FROM actions_jobs WHERE request_id = ?', requestId))

export const getJobById = async (db: Database, id: string): Promise<JobRow | null> => first<JobRow>(db, sql('SELECT * FROM actions_jobs WHERE id = ?', id))

export const getJobByPlan = async (db: Database, planId: string): Promise<JobRow | null> => first<JobRow>(db, sql('SELECT * FROM actions_jobs WHERE plan_id = ?', planId))

export const listRunJobs = async (db: Database, runId: number): Promise<JobRow[]> => db.all<JobRow>(sql('SELECT * FROM actions_jobs WHERE run_id = ? ORDER BY request_id', runId))

export const bindJobToRunner = async (db: Database, requestId: number, runnerId: number): Promise<void> => {
  await db.run(sql("UPDATE actions_jobs SET runner_id = ? WHERE request_id = ? AND status = 'queued'", runnerId, requestId))
}

export const unbindJob = async (db: Database, requestId: number, runnerId: number): Promise<void> => {
  await db.run(sql("UPDATE actions_jobs SET runner_id = NULL WHERE request_id = ? AND runner_id = ? AND status = 'queued'", requestId, runnerId))
}

const labelsMatch = (required: readonly string[], offered: readonly string[]): boolean => {
  const available = new Set(offered.map((label) => label.toLowerCase()))
  return required.every((label) => available.has(label.toLowerCase()))
}

export const pendingDelivery = async (db: Database, sessionId: string): Promise<JobRow | null> =>
  first<JobRow>(db, sql("SELECT * FROM actions_jobs WHERE session_id = ? AND status = 'assigned' AND message_acked_at IS NULL ORDER BY request_id LIMIT 1", sessionId))

export const claimJob = async (db: Database, runner: Runner, sessionId: string, now: number): Promise<JobRow | null> => {
  const candidates = await db.all<JobRow>(
    runner.jobId
      ? sql("SELECT * FROM actions_jobs WHERE status = 'queued' AND id = ? AND (runner_id IS NULL OR runner_id = ?)", runner.jobId, runner.id)
      : sql("SELECT * FROM actions_jobs WHERE status = 'queued' AND (runner_id IS NULL OR runner_id = ?) ORDER BY runner_id IS NULL, request_id LIMIT 50", runner.id),
  )
  for (const candidate of candidates) {
    if (candidate.runner_id === null && !labelsMatch(JSON.parse(candidate.labels) as string[], runner.labels)) continue
    const { changes } = await db.run(
      sql(
        "UPDATE actions_jobs SET status = 'assigned', runner_id = ?, session_id = ?, assigned_at = ? WHERE request_id = ? AND status = 'queued' AND (runner_id IS NULL OR runner_id = ?)",
        runner.id,
        sessionId,
        now,
        candidate.request_id,
        runner.id,
      ),
    )
    if (changes === 1) return getJob(db, candidate.request_id)
  }
  return null
}

export const renewJob = async (db: Database, requestId: number, runnerId: number, lockedUntil: number, now: number): Promise<JobRow | null> => {
  await db.run(
    sql(
      "UPDATE actions_jobs SET status = CASE WHEN status = 'assigned' THEN 'in_progress' ELSE status END, started_at = COALESCE(started_at, ?), locked_until = ? WHERE request_id = ? AND runner_id = ? AND status IN ('assigned', 'in_progress')",
      now,
      lockedUntil,
      requestId,
      runnerId,
    ),
  )
  const job = await getJob(db, requestId)
  return job && job.runner_id === runnerId ? job : null
}

export const completeJob = async (db: Database, requestId: number, conclusion: string, now: number): Promise<boolean> =>
  (
    await db.run(
      sql("UPDATE actions_jobs SET status = 'completed', conclusion = ?, completed_at = ? WHERE request_id = ? AND status != 'completed'", conclusion, now, requestId),
    )
  ).changes === 1

type TimelineRecord = Record<string, unknown> & { readonly id: string }

export const upsertTimelineRecords = async (db: Database, timelineId: string, records: readonly TimelineRecord[]): Promise<TimelineRecord[]> => {
  const merged: TimelineRecord[] = []
  for (const record of records) {
    const existing = await first<{ record: string }>(db, sql('SELECT record FROM actions_timeline_records WHERE timeline_id = ? AND record_id = ?', timelineId, record.id))
    const previous = existing ? (JSON.parse(existing.record) as TimelineRecord) : { id: record.id }
    const next: TimelineRecord = { ...previous, ...Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null && value !== undefined)), id: record.id }
    await db.run(
      sql(
        'INSERT INTO actions_timeline_records (timeline_id, record_id, record) VALUES (?, ?, ?) ON CONFLICT (timeline_id, record_id) DO UPDATE SET record = excluded.record',
        timelineId,
        record.id,
        JSON.stringify(next),
      ),
    )
    merged.push(next)
  }
  return merged
}

export const listTimelineRecords = async (db: Database, timelineId: string): Promise<TimelineRecord[]> =>
  (await db.all<{ record: string }>(sql('SELECT record FROM actions_timeline_records WHERE timeline_id = ? ORDER BY rowid', timelineId))).map(
    (row) => JSON.parse(row.record) as TimelineRecord,
  )

export type LogRow = {
  readonly id: number
  readonly job_id: string
  readonly path: string
  readonly chunks: number
  readonly created_at: number
}

export const createLog = async (db: Database, jobId: string, path: string, now: number): Promise<LogRow> => {
  const [row] = await db.all<LogRow>(sql('INSERT INTO actions_logs (job_id, path, created_at) VALUES (?, ?, ?) RETURNING *', jobId, path, now))
  return row!
}

export const getLog = async (db: Database, id: number): Promise<LogRow | null> => first<LogRow>(db, sql('SELECT * FROM actions_logs WHERE id = ?', id))

export const listLogs = async (db: Database, jobId: string): Promise<LogRow[]> => db.all<LogRow>(sql('SELECT * FROM actions_logs WHERE job_id = ? ORDER BY id', jobId))

export const recordLogChunk = async (db: Database, id: number, chunk: number): Promise<void> => {
  await db.run(sql('UPDATE actions_logs SET chunks = MAX(chunks, ?) WHERE id = ?', chunk + 1, id))
}

export const promoteJob = async (db: Database, requestId: number): Promise<boolean> =>
  (await db.run(sql("UPDATE actions_jobs SET status = 'queued' WHERE request_id = ? AND status = 'pending'", requestId))).changes === 1

export const skipJob = async (db: Database, requestId: number, now: number): Promise<boolean> =>
  (await db.run(sql("UPDATE actions_jobs SET status = 'completed', conclusion = 'skipped', completed_at = ? WHERE request_id = ? AND status = 'pending'", now, requestId)))
    .changes === 1
