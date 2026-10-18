import { type CheckRunConclusion, type CheckRunStatus, createCheckRun, type Database, sql, updateCheckRun } from '@git-forge/accounts'
import {
  advertisedRefs,
  cronMatches,
  dispatchTrigger,
  evaluateCondition,
  evaluateTemplate,
  evaluateTemplateString,
  evaluateValue,
  expandMatrix,
  type ExpressionContext,
  type ExpressionValue,
  isTruthy,
  isZero,
  jobLevels,
  type MatrixCombination,
  matrixJobName,
  nextCronTime,
  ObjectDatabase,
  parseCron,
  parseWorkflow,
  type PushOutcome,
  readRefs,
  readWorkflowFiles,
  type RepositoryName,
  resolveCommitish,
  resolveDispatchInputs,
  scheduleCrons,
  type Storage,
  toExpressionString,
  triggeredByPullRequest,
  triggeredByPush,
  type Workflow,
  WorkflowError,
  type WorkflowJob,
  type YamlLike,
  withStatusCheck,
} from '@git-forge/core'
import { type JobDefinition, jobDefinitionOf, jobOutputsOf, type RunDefinition, runContextOf, runDefinitionOf, type RunInputs } from './definitions.ts'
import { encodeJitConfig } from './jit.ts'
import { githubContextValue, type NeedResult, needsContextValue, strategyContextValue, type StrategyContext } from './job-message.ts'
import { generateRunnerKey } from './keys.ts'
import { getEnvironment } from './secrets.ts'
import { authorizationUrl, POOL_ID, POOL_NAME } from './service-constants.ts'
import {
  activeRunsInGroup,
  bindJobToRunner,
  closeSession,
  completeRun,
  createJob,
  createRun,
  createRunner,
  deleteExpiredTokens,
  expandPlaceholder,
  finishPending,
  getJob,
  getRun,
  getRunnerIncludingRemoved,
  type JobRow,
  listCurrentJobs,
  listJobsByStatus,
  listRunJobs,
  listStaleSessions,
  markRunCancelled,
  promoteJob,
  recordLaunch,
  removeRunner,
  requestJobCancel,
  requeueJob,
  revokeJobTokens,
  type Runner,
  type RunRow,
  setCheckRunId,
  startRunAttempt,
  unbindJob,
} from './store.ts'

export type RunnerLaunch = {
  readonly jobId: string
  readonly requestId: number
  readonly runnerName: string
  readonly labels: readonly string[]
  readonly encodedJitConfig: string
}

export interface RunnerLauncher {
  launch(launch: RunnerLaunch): Promise<void>
}

export type ServiceUrls = {
  readonly serverUrl: string
  readonly serviceUrl: string
}

export type JitRunner = {
  readonly runner: Runner
  readonly encodedJitConfig: string
}

export type JitRunnerRequest = {
  readonly name: string
  readonly owner: string
  readonly repo: string
  readonly labels: readonly string[]
  readonly workFolder?: string
  readonly jobId?: string
}

export const createJitRunner = async (db: Database, urls: ServiceUrls, request: JitRunnerRequest, now: number): Promise<JitRunner> => {
  const key = await generateRunnerKey()
  const runner = await createRunner(
    db,
    {
      name: request.name,
      owner: request.owner,
      repo: request.repo,
      labels: request.labels,
      publicKey: key.publicKey,
      ephemeral: true,
      ...(request.jobId ? { jobId: request.jobId } : {}),
    },
    now,
  )
  const encodedJitConfig = encodeJitConfig({
    runner: {
      AgentId: runner.id,
      AgentName: runner.name,
      PoolId: POOL_ID,
      PoolName: POOL_NAME,
      ServerUrl: urls.serviceUrl,
      GitHubUrl: `${urls.serverUrl}/${request.owner}/${request.repo}`,
      WorkFolder: request.workFolder ?? '_work',
      Ephemeral: true,
      DisableUpdate: true,
    },
    credentials: { Scheme: 'OAuth', Data: { clientId: runner.clientId, authorizationUrl: authorizationUrl(urls.serviceUrl), requireFipsCryptography: 'False' } },
    rsaParameters: key.rsaParameters,
  })
  return { runner, encodedJitConfig }
}

export type DispatchOptions = {
  readonly db: Database
  readonly storage: Storage
  readonly urls: ServiceUrls
  readonly launcher?: RunnerLauncher
  readonly now?: () => number
  readonly log?: (event: Record<string, unknown>) => void
}

export const MAX_LAUNCHES = 3

const clock = (options: DispatchOptions): number => (options.now ?? Date.now)()

export const jobHtmlUrl = (serverUrl: string, run: Pick<RunRow, 'owner' | 'repo' | 'id'>, job: Pick<JobRow, 'request_id'>): string =>
  `${serverUrl}/${run.owner}/${run.repo}/actions/runs/${run.id}/job/${job.request_id}`

const checkStatusOf = (job: JobRow): CheckRunStatus => (job.status === 'completed' ? 'completed' : job.status === 'in_progress' ? 'in_progress' : 'queued')

const CHECK_CONCLUSIONS: ReadonlySet<string> = new Set(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale'])

const checkConclusionOf = (job: JobRow): CheckRunConclusion | undefined => {
  if (job.status !== 'completed') return undefined
  if (job.conclusion === 'cancelled' && job.cancel_reason === 'timeout') return 'timed_out'
  return CHECK_CONCLUSIONS.has(job.conclusion ?? '') ? (job.conclusion as CheckRunConclusion) : 'failure'
}

export const recordCheck = async (db: Database, serverUrl: string, run: RunRow, job: JobRow, now: number): Promise<void> => {
  if (job.expanded === 0 && job.status !== 'completed') return
  const status = checkStatusOf(job)
  const conclusion = checkConclusionOf(job)
  const definition = jobDefinitionOf(job)
  const title = definition.error ?? (job.approval === 'waiting' ? `Waiting for review: ${job.environment} needs approval` : undefined)
  if (job.check_run_id === null) {
    const check = await createCheckRun(
      db,
      {
        owner: run.owner,
        repo: run.repo,
        headSha: run.sha,
        name: job.display_name,
        app: 'actions',
        status,
        ...(conclusion ? { conclusion } : {}),
        externalId: job.id,
        detailsUrl: jobHtmlUrl(serverUrl, run, job),
        ...(title ? { title } : {}),
      },
      now,
    )
    await setCheckRunId(db, job.request_id, check.id)
  } else await updateCheckRun(db, job.check_run_id, { status, ...(conclusion ? { conclusion } : {}), ...(title ? { title } : {}) }, now)
}

const recordChecks = async (options: DispatchOptions, run: RunRow, requestIds: Iterable<number>): Promise<void> => {
  for (const requestId of new Set(requestIds)) {
    const job = await getJob(options.db, requestId)
    if (job) await recordCheck(options.db, options.urls.serverUrl, run, job, clock(options))
  }
}

const launchJob = async (options: DispatchOptions, job: JobRow, owner: string, repo: string): Promise<void> => {
  if (!options.launcher) return
  const now = clock(options)
  const labels = JSON.parse(job.labels) as string[]
  const { runner, encodedJitConfig } = await createJitRunner(
    options.db,
    options.urls,
    { name: `forge-${job.request_id}-${job.launches + 1}-${job.id.slice(0, 8)}`, owner, repo, labels, jobId: job.id },
    now,
  )
  await bindJobToRunner(options.db, job.request_id, runner.id)
  await recordLaunch(options.db, job.request_id)
  try {
    await options.launcher.launch({ jobId: job.id, requestId: job.request_id, runnerName: runner.name, labels, encodedJitConfig })
  } catch (error) {
    options.log?.({ event: 'runner-launch-failed', jobId: job.id, runner: runner.name, error: String(error) })
    await unbindJob(options.db, job.request_id, runner.id)
    await removeRunner(options.db, runner.id, now)
  }
}

const releaseRunner = async (options: DispatchOptions, job: JobRow): Promise<void> => {
  if (job.runner_id === null) return
  const runner = await getRunnerIncludingRemoved(options.db, job.runner_id)
  if (runner?.ephemeral && runner.jobId === job.id) await removeRunner(options.db, runner.id, clock(options))
}

export type QueuedRun = {
  readonly runId: number
  readonly workflowPath: string
  readonly jobs: readonly JobRow[]
}

export type WorkflowRunRequest = {
  readonly repo: RepositoryName
  readonly workflowPath: string
  readonly workflow: Workflow
  readonly event: string
  readonly ref: string
  readonly sha: string
  readonly actor: string
  readonly payload: Readonly<Record<string, ExpressionValue>>
  readonly inputs?: RunInputs
  readonly trusted?: boolean
}

const baseContexts = (options: DispatchOptions, run: RunRow, definition: RunDefinition | null, jobKey: string): Record<string, ExpressionValue> => ({
  github: githubContextValue(runContextOf(run, definition), options.urls.serverUrl, jobKey),
  inputs: definition?.inputs ?? {},
  vars: {},
  env: definition?.workflow.env ?? {},
})

export const createWorkflowRun = async (options: DispatchOptions, request: WorkflowRunRequest): Promise<QueuedRun> => {
  const { db } = options
  const now = clock(options)
  const definition: RunDefinition = { workflow: request.workflow, inputs: request.inputs ?? {}, payload: request.payload }
  const provisional: RunRow = {
    id: 0,
    owner: request.repo.owner,
    repo: request.repo.name,
    workflow_path: request.workflowPath,
    workflow_name: request.workflow.name ?? request.workflowPath,
    event: request.event,
    ref: request.ref,
    sha: request.sha,
    actor: request.actor,
    created_at: now,
    definition: null,
    attempt: 1,
    trusted: request.trusted === false ? 0 : 1,
    concurrency_group: null,
    cancelled_at: null,
    completed_at: null,
    conclusion: null,
  }
  let group: string | null = null
  let cancelInProgress = false
  const { concurrency } = request.workflow
  if (concurrency) {
    const context: ExpressionContext = { contexts: baseContexts(options, provisional, definition, '') }
    try {
      group = evaluateTemplateString(concurrency.group, context)
      cancelInProgress = isTruthy(evaluateValue(concurrency.cancelInProgress as YamlLike, context))
    } catch (error) {
      options.log?.({ event: 'concurrency-invalid', path: request.workflowPath, error: String(error) })
      group = concurrency.group
    }
  }
  const runId = await createRun(
    db,
    {
      owner: request.repo.owner,
      repo: request.repo.name,
      workflow_path: request.workflowPath,
      workflow_name: provisional.workflow_name,
      event: request.event,
      ref: request.ref,
      sha: request.sha,
      actor: request.actor,
      definition,
      trusted: request.trusted !== false,
      concurrency_group: group,
    },
    now,
  )
  for (const job of jobLevels(request.workflow.jobs).flat()) {
    const placeholder: JobDefinition = { job, workflowEnv: request.workflow.env, workflowDefaults: request.workflow.defaults }
    await createJob(db, { runId, jobKey: job.id, displayName: job.name, labels: job.runsOn, needs: job.needs, definition: placeholder, expanded: false, status: 'pending' }, now)
  }
  if (group !== null) {
    for (const other of await activeRunsInGroup(db, request.repo.owner, request.repo.name, group)) {
      if (other.id === runId) continue
      const started = (await listCurrentJobs(db, other.id)).some((job) => job.status !== 'pending' || job.expanded === 1)
      if (cancelInProgress || !started) await cancelRun(options, other.id, 'concurrency')
    }
  }
  await advance(options, runId)
  return { runId, workflowPath: request.workflowPath, jobs: await listCurrentJobs(db, runId) }
}

type Group = {
  readonly key: string
  readonly rows: readonly JobRow[]
  readonly placeholder: JobRow | undefined
  readonly complete: boolean
  readonly result: NeedResult
}

const continuesOnError = (job: JobRow): boolean => jobDefinitionOf(job).continueOnError === true

const groupResult = (rows: readonly JobRow[]): string => {
  if (rows.some((row) => row.conclusion !== null && !['success', 'skipped', 'cancelled'].includes(row.conclusion) && !continuesOnError(row))) return 'failure'
  if (rows.some((row) => row.conclusion === 'cancelled' && !continuesOnError(row))) return 'cancelled'
  if (rows.length > 0 && rows.every((row) => row.conclusion === 'skipped')) return 'skipped'
  return 'success'
}

const groupsOf = (rows: readonly JobRow[]): Map<string, Group> => {
  const byKey = new Map<string, JobRow[]>()
  for (const row of rows) byKey.set(row.job_key, [...(byKey.get(row.job_key) ?? []), row])
  return new Map(
    [...byKey].map(([key, members]) => {
      const complete = members.every((row) => row.status === 'completed')
      const outputs = Object.assign({}, ...members.map(jobOutputsOf)) as Record<string, string>
      return [key, { key, rows: members, placeholder: members.find((row) => row.expanded === 0), complete, result: { result: complete ? groupResult(members) : '', outputs } }]
    }),
  )
}

const toLabels = (value: ExpressionValue): string[] => {
  if (value === null) return []
  if (Array.isArray(value)) return value.flatMap((item: ExpressionValue) => toLabels(item))
  if (typeof value === 'object') return toLabels((value as Record<string, ExpressionValue>)['labels'] ?? null)
  const text = toExpressionString(value).trim()
  return text === '' ? [] : [text]
}

type Leg = {
  readonly displayName: string
  readonly labels: readonly string[]
  readonly environment: string | null
  readonly definition: JobDefinition
  readonly matrix: MatrixCombination | null
}

const planLegs = (job: WorkflowJob, workflow: Workflow, contexts: Record<string, ExpressionValue>, needs: Readonly<Record<string, NeedResult>>): Leg[] => {
  const context: ExpressionContext = { contexts }
  let combinations: (MatrixCombination | null)[] = [null]
  let failFast = true
  let maxParallel = Number.POSITIVE_INFINITY
  if (job.strategy) {
    combinations = expandMatrix(evaluateValue(job.strategy.matrix as YamlLike, context))
    failFast = isTruthy(evaluateValue(job.strategy.failFast as YamlLike, context))
    if (job.strategy.maxParallel !== undefined) {
      const value = Number(evaluateValue(job.strategy.maxParallel as YamlLike, context))
      if (!Number.isInteger(value) || value < 1) throw new Error('strategy.max-parallel must be a positive integer')
      maxParallel = value
    }
  }
  return combinations.map((combination, index) => {
    const strategy: StrategyContext | null = job.strategy ? { failFast, maxParallel: Number.isFinite(maxParallel) ? maxParallel : combinations.length, jobIndex: index, jobTotal: combinations.length } : null
    const legContext: ExpressionContext = { contexts: { ...contexts, matrix: combination ?? {}, strategy: strategy ? strategyContextValue(strategy) : {} } }
    const evaluatedName = evaluateTemplateString(job.name, legContext)
    const displayName = combination && !/\bmatrix\b/.test(job.name) ? matrixJobName(evaluatedName, combination) : evaluatedName
    const labels = job.runsOn.flatMap((label) => toLabels(evaluateTemplate(label, legContext)))
    if (labels.length === 0) throw new Error('runs-on evaluates to no labels')
    const environment = job.environment ? evaluateTemplateString(job.environment.name, legContext) : null
    const continueOnError = typeof job.continueOnError === 'boolean' ? job.continueOnError : isTruthy(evaluateTemplate(job.continueOnError, legContext))
    return {
      displayName,
      labels,
      environment: environment === '' ? null : environment,
      matrix: combination,
      definition: { job: { ...job, name: displayName }, workflowEnv: workflow.env, workflowDefaults: workflow.defaults, matrix: combination, strategy, needs, continueOnError },
    }
  })
}

const failPlaceholder = async (options: DispatchOptions, run: RunRow, placeholder: JobRow, error: string): Promise<void> => {
  const { db } = options
  const definition = { ...jobDefinitionOf(placeholder), error }
  await db.run(sql('UPDATE actions_jobs SET definition = ? WHERE request_id = ?', JSON.stringify(definition), placeholder.request_id))
  if (await finishPending(db, placeholder.request_id, 'failure', null, clock(options))) await recordChecks(options, run, [placeholder.request_id])
  options.log?.({ event: 'job-invalid', runId: run.id, job: placeholder.job_key, error })
}

const expandJob = async (options: DispatchOptions, run: RunRow, definition: RunDefinition, placeholder: JobRow, job: WorkflowJob, needs: Record<string, NeedResult>): Promise<void> => {
  const { db } = options
  const now = clock(options)
  const cancelled = run.cancelled_at !== null
  const results = Object.values(needs).map((need) => need.result)
  const contexts = { ...baseContexts(options, run, definition, job.id), needs: needsContextValue(needs) }
  const status = {
    success: () => !cancelled && results.every((result) => result === 'success'),
    failure: () => results.some((result) => result === 'failure'),
    cancelled: () => cancelled,
    always: () => true,
  }
  let proceed: boolean
  let legs: Leg[]
  try {
    proceed = evaluateCondition(withStatusCheck(job.if), { contexts, status })
    legs = proceed ? planLegs(job, definition.workflow, contexts, needs) : []
  } catch (error) {
    await failPlaceholder(options, run, placeholder, `${job.id}: ${(error as Error).message}`)
    return
  }
  if (!proceed) {
    if (await finishPending(db, placeholder.request_id, cancelled ? 'cancelled' : 'skipped', null, now)) await recordChecks(options, run, [placeholder.request_id])
    return
  }
  const maxParallel = legs[0]?.definition.strategy?.maxParallel ?? Number.POSITIVE_INFINITY
  const created: JobRow[] = []
  for (const [index, leg] of legs.entries()) {
    const environment = leg.environment ? await getEnvironment(db, run.owner, run.repo, leg.environment) : null
    const approval = environment && environment.reviewers.length > 0 ? 'waiting' : null
    const status = approval === null && index < maxParallel ? 'queued' : 'pending'
    const values = { displayName: leg.displayName, labels: leg.labels, definition: leg.definition, status, matrix: leg.matrix, environment: environment?.name ?? leg.environment, approval } as const
    if (index === 0) {
      if (!(await expandPlaceholder(db, placeholder.request_id, values))) return
      created.push((await getJob(db, placeholder.request_id))!)
    } else {
      created.push(
        await createJob(
          db,
          {
            runId: run.id,
            jobKey: placeholder.job_key,
            needs: job.needs,
            attempt: placeholder.attempt,
            expanded: true,
            ...values,
          },
          now,
        ),
      )
    }
  }
  for (const leg of created) {
    if (leg.status === 'queued') await launchJob(options, leg, run.owner, run.repo)
  }
  await recordChecks(
    options,
    run,
    created.map((leg) => leg.request_id),
  )
}

const cancelJobs = async (options: DispatchOptions, run: RunRow, jobs: readonly JobRow[], reason: string): Promise<boolean> => {
  let changed = false
  const now = clock(options)
  for (const job of jobs) {
    if (job.status === 'completed') continue
    if ((job.status === 'pending' || job.status === 'queued') && (await finishPending(options.db, job.request_id, 'cancelled', reason, now))) {
      await revokeJobTokens(options.db, job.id, now)
      await releaseRunner(options, job)
      await recordChecks(options, run, [job.request_id])
      changed = true
    } else if (await requestJobCancel(options.db, job.request_id, reason, now)) changed = true
  }
  return changed
}

const legacyAdvance = async (options: DispatchOptions, run: RunRow): Promise<JobRow[]> => {
  const now = clock(options)
  const started: JobRow[] = []
  let changed = true
  while (changed) {
    changed = false
    const jobs = await listRunJobs(options.db, run.id)
    const byKey = new Map(jobs.map((job) => [job.job_key, job]))
    for (const job of jobs) {
      if (job.status !== 'pending') continue
      const needs = (JSON.parse(job.needs) as string[]).map((key) => byKey.get(key))
      if (needs.some((need) => need?.status === 'completed' && need.conclusion !== 'success')) {
        if (await finishPending(options.db, job.request_id, 'skipped', null, now)) changed = true
      } else if (needs.every((need) => need?.status === 'completed') && (await promoteJob(options.db, job.request_id))) {
        const promoted = { ...job, status: 'queued' as const }
        await launchJob(options, promoted, run.owner, run.repo)
        started.push(promoted)
        changed = true
      }
    }
  }
  return started
}

const runConclusion = (run: RunRow, groups: Iterable<Group>): string => {
  const results = [...groups].map((group) => group.result.result)
  if (results.includes('failure')) return 'failure'
  if (run.cancelled_at !== null || results.includes('cancelled')) return 'cancelled'
  return 'success'
}

export const advance = async (options: DispatchOptions, runId: number): Promise<JobRow[]> => {
  const { db } = options
  const initial = await getRun(db, runId)
  if (!initial) return []
  const definition = runDefinitionOf(initial)
  if (!definition) return legacyAdvance(options, initial)
  const started: JobRow[] = []
  for (let round = 0; round < 100; round++) {
    const run = (await getRun(db, runId))!
    const groups = groupsOf(await listCurrentJobs(db, runId))
    let changed = false
    for (const group of groups.values()) {
      if (group.placeholder) continue
      const strategy = jobDefinitionOf(group.rows[0]!).strategy
      if (strategy?.failFast && group.rows.some((row) => row.status === 'completed' && row.conclusion === 'failure' && !continuesOnError(row))) {
        if (await cancelJobs(options, run, group.rows, 'fail-fast')) changed = true
      }
    }
    const blocked = run.cancelled_at === null && run.concurrency_group !== null && (await activeRunsInGroup(db, run.owner, run.repo, run.concurrency_group)).some((other) => other.id < run.id)
    if (!blocked) {
      for (const group of groups.values()) {
        const placeholder = group.placeholder
        if (!placeholder || placeholder.status !== 'pending') continue
        const job = definition.workflow.jobs.find((candidate) => candidate.id === group.key) ?? jobDefinitionOf(placeholder).job
        const needs = job.needs.map((key) => groups.get(key))
        if (needs.some((need) => !need?.complete)) continue
        await expandJob(options, run, definition, placeholder, job, Object.fromEntries(needs.map((need) => [need!.key, need!.result])))
        changed = true
      }
    }
    for (const group of groups.values()) {
      if (group.placeholder) continue
      for (const row of group.rows) {
        if (row.status === 'pending' && row.approval === 'rejected' && (await finishPending(db, row.request_id, 'failure', 'rejected', clock(options)))) {
          await recordChecks(options, run, [row.request_id])
          changed = true
        }
      }
      const strategy = jobDefinitionOf(group.rows[0]!).strategy
      const limit = strategy?.maxParallel ?? Number.POSITIVE_INFINITY
      let active = group.rows.filter((row) => row.status === 'queued' || row.status === 'assigned' || row.status === 'in_progress').length
      for (const row of group.rows) {
        if (active >= limit) break
        if (row.status !== 'pending' || row.expanded !== 1 || (row.approval !== null && row.approval !== 'approved')) continue
        if (run.cancelled_at !== null) continue
        if (await promoteJob(db, row.request_id)) {
          const promoted = (await getJob(db, row.request_id))!
          await launchJob(options, promoted, run.owner, run.repo)
          await recordChecks(options, run, [row.request_id])
          started.push(promoted)
          active++
          changed = true
        }
      }
    }
    if (!changed) break
  }
  const run = (await getRun(db, runId))!
  const groups = groupsOf(await listCurrentJobs(db, runId))
  if (run.completed_at === null && [...groups.values()].every((group) => group.complete)) {
    if ((await completeRun(db, runId, runConclusion(run, groups.values()), clock(options))) && run.concurrency_group !== null) {
      const next = (await activeRunsInGroup(db, run.owner, run.repo, run.concurrency_group))[0]
      if (next) await advance(options, next.id)
    }
  }
  return started
}

export const advanceRun = async (options: DispatchOptions, completed: JobRow): Promise<JobRow[]> => {
  const run = await getRun(options.db, completed.run_id)
  if (!run) return []
  const job = await getJob(options.db, completed.request_id)
  if (job) await recordCheck(options.db, options.urls.serverUrl, run, job, clock(options))
  return advance(options, completed.run_id)
}

export const cancelRun = async (options: DispatchOptions, runId: number, reason = 'user'): Promise<boolean> => {
  const run = await getRun(options.db, runId)
  if (!run || run.completed_at !== null) return false
  await markRunCancelled(options.db, runId, clock(options))
  const cancelled = (await getRun(options.db, runId))!
  const jobs = (await listCurrentJobs(options.db, runId)).filter((job) => job.expanded === 1)
  await cancelJobs(options, cancelled, jobs, reason)
  await advance(options, runId)
  return true
}

export class RerunError extends Error {}

export type RerunMode = { readonly kind: 'all' } | { readonly kind: 'failed' } | { readonly kind: 'job'; readonly requestId: number }

export const rerunRun = async (options: DispatchOptions, runId: number, mode: RerunMode): Promise<number> => {
  const { db } = options
  const run = await getRun(db, runId)
  if (!run) throw new RerunError('run not found')
  const definition = runDefinitionOf(run)
  if (!definition) throw new RerunError('this run was created before re-runs were supported')
  if (run.completed_at === null) throw new RerunError('the run is still in progress')
  const groups = groupsOf(await listCurrentJobs(db, runId))
  let selected: string[]
  if (mode.kind === 'all') selected = definition.workflow.jobs.map((job) => job.id)
  else if (mode.kind === 'failed') selected = [...groups.values()].filter((group) => group.result.result === 'failure' || group.result.result === 'cancelled').map((group) => group.key)
  else {
    const job = await getJob(db, mode.requestId)
    if (!job || job.run_id !== runId) throw new RerunError('job not found')
    selected = [job.job_key]
  }
  if (selected.length === 0) throw new RerunError('there are no failed jobs to re-run')
  const chosen = new Set(selected)
  let grew = true
  while (grew) {
    grew = false
    for (const job of definition.workflow.jobs) {
      if (!chosen.has(job.id) && job.needs.some((need) => chosen.has(need))) {
        chosen.add(job.id)
        grew = true
      }
    }
  }
  const attempt = run.attempt + 1
  if (!(await startRunAttempt(db, runId, attempt))) throw new RerunError('the run changed, try again')
  const now = clock(options)
  for (const job of jobLevels(definition.workflow.jobs).flat()) {
    if (!chosen.has(job.id)) continue
    const placeholder: JobDefinition = { job, workflowEnv: definition.workflow.env, workflowDefaults: definition.workflow.defaults }
    await createJob(db, { runId, jobKey: job.id, displayName: job.name, labels: job.runsOn, needs: job.needs, definition: placeholder, expanded: false, status: 'pending', attempt }, now)
  }
  await advance(options, runId)
  return attempt
}

export class ApprovalError extends Error {}

export const reviewDeployment = async (options: DispatchOptions, requestId: number, reviewer: string, approve: boolean): Promise<JobRow> => {
  const { db } = options
  const job = await getJob(db, requestId)
  if (!job || job.approval !== 'waiting' || job.status !== 'pending' || !job.environment) throw new ApprovalError('the job is not waiting for a review')
  const run = await getRun(db, job.run_id)
  const environment = run ? await getEnvironment(db, run.owner, run.repo, job.environment) : null
  if (!run || !environment || !environment.reviewers.some((candidate) => candidate.login.toLowerCase() === reviewer.toLowerCase())) {
    throw new ApprovalError(`${reviewer} is not a required reviewer of ${job.environment}`)
  }
  await db.run(sql("UPDATE actions_jobs SET approval = ?, reviewed_by = ? WHERE request_id = ? AND approval = 'waiting'", approve ? 'approved' : 'rejected', reviewer, requestId))
  await advance(options, job.run_id)
  return (await getJob(db, requestId))!
}

export const pendingDeployments = async (db: Database, runId: number): Promise<JobRow[]> =>
  (await listCurrentJobs(db, runId)).filter((job) => job.approval === 'waiting' && job.status === 'pending')

export type PushEvent = {
  readonly repo: RepositoryName
  readonly outcome: PushOutcome
  readonly actor: string
}

const parseFile = (options: DispatchOptions, path: string, source: string): Workflow | null => {
  try {
    return parseWorkflow(source)
  } catch (error) {
    if (!(error instanceof WorkflowError)) throw error
    options.log?.({ event: 'workflow-invalid', path, problems: error.problems })
    return null
  }
}

const repositoryPayload = (options: DispatchOptions, repo: RepositoryName, defaultBranch?: string): Record<string, ExpressionValue> => ({
  full_name: `${repo.owner}/${repo.name}`,
  name: repo.name,
  owner: { login: repo.owner, name: repo.owner },
  html_url: `${options.urls.serverUrl}/${repo.owner}/${repo.name}`,
  clone_url: `${options.urls.serverUrl}/${repo.owner}/${repo.name}.git`,
  ...(defaultBranch ? { default_branch: defaultBranch } : {}),
})

const defaultBranchOf = async (storage: Storage, repo: RepositoryName): Promise<{ readonly ref: string; readonly sha: string | null } | null> => {
  const stored = await readRefs(storage, repo)
  if (!stored) return null
  const refs = advertisedRefs(stored.state)
  return { ref: refs.head, sha: refs.refs[refs.head] ?? null }
}

export const queueRunsForPush = async (options: DispatchOptions, event: PushEvent): Promise<QueuedRun[]> => {
  const odb = new ObjectDatabase(options.storage, event.repo)
  const queued: QueuedRun[] = []
  const defaultBranch = await defaultBranchOf(options.storage, event.repo)
  for (const result of event.outcome.results) {
    if (!result.ok || isZero(result.newId) || !(result.name.startsWith('refs/heads/') || result.name.startsWith('refs/tags/'))) continue
    if (defaultBranch && result.name === defaultBranch.ref) await syncSchedules(options, event.repo, result.newId)
    for (const file of await readWorkflowFiles(odb, result.newId)) {
      const workflow = parseFile(options, file.path, file.source)
      if (!workflow || !triggeredByPush(workflow, result.name)) continue
      queued.push(
        await createWorkflowRun(options, {
          repo: event.repo,
          workflowPath: file.path,
          workflow,
          event: 'push',
          ref: result.name,
          sha: result.newId,
          actor: event.actor,
          payload: {
            ref: result.name,
            before: result.oldId,
            after: result.newId,
            created: isZero(result.oldId),
            deleted: false,
            forced: false,
            pusher: { name: event.actor },
            sender: { login: event.actor },
            repository: repositoryPayload(options, event.repo, defaultBranch?.ref.replace(/^refs\/heads\//, '')),
          },
        }),
      )
    }
  }
  return queued
}

export class DispatchError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export type WorkflowDispatchRequest = {
  readonly repo: RepositoryName
  readonly workflowId: string
  readonly ref: string
  readonly inputs: Readonly<Record<string, unknown>>
  readonly actor: string
}

const qualifiedRef = async (storage: Storage, repo: RepositoryName, ref: string): Promise<string> => {
  if (ref.startsWith('refs/')) return ref
  const stored = await readRefs(storage, repo)
  const refs = stored ? advertisedRefs(stored.state).refs : {}
  if (refs[`refs/heads/${ref}`]) return `refs/heads/${ref}`
  if (refs[`refs/tags/${ref}`]) return `refs/tags/${ref}`
  return ref
}

export const dispatchWorkflow = async (options: DispatchOptions, request: WorkflowDispatchRequest): Promise<QueuedRun> => {
  const sha = await resolveCommitish(options.storage, request.repo, request.ref)
  if (!sha) throw new DispatchError(422, `No ref found for: ${request.ref}`)
  const ref = await qualifiedRef(options.storage, request.repo, request.ref)
  const files = await readWorkflowFiles(new ObjectDatabase(options.storage, request.repo), sha)
  const file = files.find((candidate) => candidate.path === request.workflowId || candidate.path.endsWith(`/${request.workflowId}`))
  if (!file) throw new DispatchError(404, `workflow ${request.workflowId} not found at ${request.ref}`)
  let workflow: Workflow
  try {
    workflow = parseWorkflow(file.source)
  } catch (error) {
    if (error instanceof WorkflowError) throw new DispatchError(422, `invalid workflow: ${error.message}`)
    throw error
  }
  const trigger = dispatchTrigger(workflow)
  if (!trigger) throw new DispatchError(422, "Workflow does not have 'workflow_dispatch' trigger")
  let inputs: RunInputs
  try {
    inputs = resolveDispatchInputs(trigger.inputs ?? {}, request.inputs)
  } catch (error) {
    throw new DispatchError(422, (error as Error).message)
  }
  return createWorkflowRun(options, {
    repo: request.repo,
    workflowPath: file.path,
    workflow,
    event: 'workflow_dispatch',
    ref,
    sha,
    actor: request.actor,
    inputs,
    payload: { inputs: inputs as Record<string, ExpressionValue>, ref, workflow: file.path, sender: { login: request.actor }, repository: repositoryPayload(options, request.repo) },
  })
}

export type PullRequestEvent = {
  readonly repo: RepositoryName
  readonly number: number
  readonly action: string
  readonly actor: string
  readonly title?: string
  readonly base: { readonly ref: string; readonly sha: string }
  readonly head: { readonly ref: string; readonly sha: string; readonly repo: RepositoryName }
  readonly mergeSha?: string
  readonly trusted: boolean
}

export const queueRunsForPullRequest = async (options: DispatchOptions, event: PullRequestEvent): Promise<QueuedRun[]> => {
  const sha = event.mergeSha ?? event.head.sha
  const ref = event.mergeSha ? `refs/pull/${event.number}/merge` : `refs/pull/${event.number}/head`
  const baseBranch = event.base.ref.replace(/^refs\/heads\//, '')
  const queued: QueuedRun[] = []
  for (const file of await readWorkflowFiles(new ObjectDatabase(options.storage, event.repo), sha)) {
    const workflow = parseFile(options, file.path, file.source)
    if (!workflow || !triggeredByPullRequest(workflow, baseBranch, event.action)) continue
    const side = (branch: string, commit: string, repo: RepositoryName) => ({ ref: branch.replace(/^refs\/heads\//, ''), sha: commit, repo: repositoryPayload(options, repo) })
    queued.push(
      await createWorkflowRun(options, {
        repo: event.repo,
        workflowPath: file.path,
        workflow,
        event: 'pull_request',
        ref,
        sha,
        actor: event.actor,
        trusted: event.trusted,
        payload: {
          action: event.action,
          number: event.number,
          pull_request: {
            number: event.number,
            title: event.title ?? '',
            head: side(event.head.ref, event.head.sha, event.head.repo),
            base: side(baseBranch, event.base.sha, event.repo),
          },
          sender: { login: event.actor },
          repository: repositoryPayload(options, event.repo),
        },
      }),
    )
  }
  return queued
}

type ScheduleRow = {
  readonly owner: string
  readonly repo: string
  readonly workflow_path: string
  readonly cron: string
  readonly next_run_at: number
}

export const syncSchedules = async (options: DispatchOptions, repo: RepositoryName, sha: string): Promise<number> => {
  const { db } = options
  const now = clock(options)
  const wanted = new Map<string, { path: string; cron: string }>()
  for (const file of await readWorkflowFiles(new ObjectDatabase(options.storage, repo), sha)) {
    const workflow = parseFile(options, file.path, file.source)
    if (!workflow) continue
    for (const cron of scheduleCrons(workflow)) wanted.set(`${file.path}\n${cron}`, { path: file.path, cron })
  }
  const existing = await db.all<ScheduleRow>(sql('SELECT * FROM actions_schedules WHERE owner = ? AND repo = ?', repo.owner, repo.name))
  const statements = existing
    .filter((row) => !wanted.has(`${row.workflow_path}\n${row.cron}`))
    .map((row) => sql('DELETE FROM actions_schedules WHERE owner = ? AND repo = ? AND workflow_path = ? AND cron = ?', row.owner, row.repo, row.workflow_path, row.cron))
  for (const { path, cron } of wanted.values()) {
    if (existing.some((row) => row.workflow_path === path && row.cron === cron)) continue
    const next = nextCronTime(parseCron(cron), now)
    if (next !== null) statements.push(sql('INSERT INTO actions_schedules (owner, repo, workflow_path, cron, next_run_at) VALUES (?, ?, ?, ?, ?)', repo.owner, repo.name, path, cron, next))
  }
  if (statements.length > 0) await db.batch(statements)
  return wanted.size
}

export const runDueSchedules = async (options: DispatchOptions): Promise<QueuedRun[]> => {
  const { db } = options
  const now = clock(options)
  const queued: QueuedRun[] = []
  for (const row of await db.all<ScheduleRow>(sql('SELECT * FROM actions_schedules WHERE next_run_at <= ? ORDER BY next_run_at LIMIT 50', now))) {
    const schedule = parseCron(row.cron)
    const next = nextCronTime(schedule, now) ?? Number.MAX_SAFE_INTEGER
    const claimed = await db.run(
      sql('UPDATE actions_schedules SET next_run_at = ? WHERE owner = ? AND repo = ? AND workflow_path = ? AND cron = ? AND next_run_at = ?', next, row.owner, row.repo, row.workflow_path, row.cron, row.next_run_at),
    )
    if (claimed.changes !== 1 || !cronMatches(schedule, row.next_run_at)) continue
    const repo = { owner: row.owner, name: row.repo }
    const branch = await defaultBranchOf(options.storage, repo)
    if (!branch?.sha) continue
    const file = (await readWorkflowFiles(new ObjectDatabase(options.storage, repo), branch.sha)).find((candidate) => candidate.path === row.workflow_path)
    const workflow = file ? parseFile(options, file.path, file.source) : null
    if (!workflow || !scheduleCrons(workflow).includes(row.cron)) continue
    queued.push(
      await createWorkflowRun(options, {
        repo,
        workflowPath: row.workflow_path,
        workflow,
        event: 'schedule',
        ref: branch.ref,
        sha: branch.sha,
        actor: 'schedule',
        payload: { schedule: row.cron, repository: repositoryPayload(options, repo, branch.ref.replace(/^refs\/heads\//, '')) },
      }),
    )
  }
  return queued
}

export const REAPER = {
  lockGraceMs: 5 * 60 * 1000,
  deliveryTimeoutMs: 10 * 60 * 1000,
  launchTimeoutMs: 10 * 60 * 1000,
  relaunchDelayMs: 60 * 1000,
  cancelGraceMs: 5 * 60 * 1000,
  sessionTimeoutMs: 10 * 60 * 1000,
  tokenRetentionMs: 24 * 60 * 60 * 1000,
}

export type ReapReport = {
  readonly abandoned: number
  readonly requeued: number
  readonly timedOut: number
  readonly forceCancelled: number
  readonly sessionsClosed: number
  readonly tokensDeleted: number
}

const abandon = async (options: DispatchOptions, job: JobRow, conclusion: string, reason: string): Promise<boolean> => {
  const now = clock(options)
  const { changes } = await options.db.run(
    sql("UPDATE actions_jobs SET status = 'completed', conclusion = ?, cancel_reason = COALESCE(cancel_reason, ?), completed_at = ? WHERE request_id = ? AND status != 'completed'", conclusion, reason, now, job.request_id),
  )
  if (changes !== 1) return false
  await revokeJobTokens(options.db, job.id, now)
  await releaseRunner(options, job)
  await advanceRun(options, job)
  return true
}

const relaunch = async (options: DispatchOptions, job: JobRow): Promise<boolean> => {
  await releaseRunner(options, job)
  if (!(await requeueJob(options.db, job.request_id))) return false
  if (job.launches >= MAX_LAUNCHES || !options.launcher) {
    if (options.launcher) return abandon(options, (await getJob(options.db, job.request_id))!, 'failure', 'runner-lost')
    return true
  }
  const run = await getRun(options.db, job.run_id)
  if (run) await launchJob(options, (await getJob(options.db, job.request_id))!, run.owner, run.repo)
  return true
}

export const reapActions = async (options: DispatchOptions): Promise<ReapReport> => {
  const { db } = options
  const now = clock(options)
  let abandoned = 0
  let requeued = 0
  let timedOut = 0
  let forceCancelled = 0
  let sessionsClosed = 0
  for (const session of await listStaleSessions(db, now - REAPER.sessionTimeoutMs)) {
    await closeSession(db, session.id, session.runner_id, now)
    sessionsClosed++
  }
  for (const job of await listJobsByStatus(db, ['queued', 'assigned', 'in_progress'])) {
    if (job.cancel_requested_at !== null && job.cancel_requested_at < now - REAPER.cancelGraceMs) {
      if (await abandon(options, job, 'cancelled', job.cancel_reason ?? 'user')) forceCancelled++
      continue
    }
    if (job.status === 'in_progress') {
      const timeoutMinutes = jobDefinitionOf(job).job.timeoutMinutes
      if (job.cancel_requested_at === null && job.started_at !== null && job.started_at + timeoutMinutes * 60_000 < now) {
        if (await requestJobCancel(db, job.request_id, 'timeout', now)) timedOut++
      } else if (job.locked_until !== null && job.locked_until < now - REAPER.lockGraceMs) {
        if (await abandon(options, job, 'failure', 'runner-lost')) abandoned++
      }
      continue
    }
    if (job.status === 'assigned') {
      if (job.assigned_at !== null && job.assigned_at < now - REAPER.deliveryTimeoutMs && (await relaunch(options, job))) requeued++
      continue
    }
    if (!options.launcher || job.cancel_requested_at !== null) continue
    if (job.runner_id === null) {
      if (job.launches < MAX_LAUNCHES && job.queued_at < now - REAPER.relaunchDelayMs) {
        const run = await getRun(db, job.run_id)
        if (run) {
          await launchJob(options, job, run.owner, run.repo)
          requeued++
        }
      }
      continue
    }
    const runner = await getRunnerIncludingRemoved(db, job.runner_id)
    if (runner?.ephemeral && runner.jobId === job.id && runner.status !== 'online' && runner.createdAt < now - REAPER.launchTimeoutMs && (await relaunch(options, job))) requeued++
  }
  const tokensDeleted = await deleteExpiredTokens(db, now - REAPER.tokenRetentionMs)
  return { abandoned, requeued, timedOut, forceCancelled, sessionsClosed, tokensDeleted }
}

export type ActionsTick = {
  readonly scheduled: readonly QueuedRun[]
  readonly reaped: ReapReport
}

export const actionsTick = async (options: DispatchOptions): Promise<ActionsTick> => ({ scheduled: await runDueSchedules(options), reaped: await reapActions(options) })
