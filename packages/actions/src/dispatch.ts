import type { Database } from '@git-forge/accounts'
import {
  isZero,
  jobLevels,
  ObjectDatabase,
  parseWorkflow,
  type PushOutcome,
  readWorkflowFiles,
  type RepositoryName,
  type Storage,
  triggeredByPush,
  WorkflowError,
} from '@git-forge/core'
import { encodeJitConfig } from './jit.ts'
import { generateRunnerKey } from './keys.ts'
import { authorizationUrl, POOL_ID, POOL_NAME, type JobDefinition } from './service.ts'
import {
  bindJobToRunner,
  createJob,
  createRun,
  createRunner,
  getRun,
  type JobRow,
  listRunJobs,
  promoteJob,
  removeRunner,
  type Runner,
  skipJob,
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

const launchJob = async (options: DispatchOptions, job: JobRow, owner: string, repo: string): Promise<void> => {
  if (!options.launcher) return
  const now = (options.now ?? Date.now)()
  const labels = JSON.parse(job.labels) as string[]
  const { runner, encodedJitConfig } = await createJitRunner(
    options.db,
    options.urls,
    { name: `forge-${job.request_id}-${job.id.slice(0, 8)}`, owner, repo, labels, jobId: job.id },
    now,
  )
  await bindJobToRunner(options.db, job.request_id, runner.id)
  try {
    await options.launcher.launch({ jobId: job.id, requestId: job.request_id, runnerName: runner.name, labels, encodedJitConfig })
  } catch (error) {
    options.log?.({ event: 'runner-launch-failed', jobId: job.id, runner: runner.name, error: String(error) })
    await unbindJob(options.db, job.request_id, runner.id)
    await removeRunner(options.db, runner.id, now)
  }
}

export type QueuedRun = {
  readonly runId: number
  readonly workflowPath: string
  readonly jobs: readonly JobRow[]
}

export type PushEvent = {
  readonly repo: RepositoryName
  readonly outcome: PushOutcome
  readonly actor: string
}

export const queueRunsForPush = async (options: DispatchOptions, event: PushEvent): Promise<QueuedRun[]> => {
  const now = (options.now ?? Date.now)()
  const odb = new ObjectDatabase(options.storage, event.repo)
  const queued: QueuedRun[] = []
  for (const result of event.outcome.results) {
    if (!result.ok || isZero(result.newId) || !(result.name.startsWith('refs/heads/') || result.name.startsWith('refs/tags/'))) continue
    for (const file of await readWorkflowFiles(odb, result.newId)) {
      let workflow
      try {
        workflow = parseWorkflow(file.source)
      } catch (error) {
        if (!(error instanceof WorkflowError)) throw error
        options.log?.({ event: 'workflow-invalid', path: file.path, problems: error.problems })
        continue
      }
      if (!triggeredByPush(workflow, result.name)) continue
      const runId = await createRun(
        options.db,
        {
          owner: event.repo.owner,
          repo: event.repo.name,
          workflow_path: file.path,
          workflow_name: workflow.name ?? file.path,
          event: 'push',
          ref: result.name,
          sha: result.newId,
          actor: event.actor,
        },
        now,
      )
      const jobs: JobRow[] = []
      for (const job of jobLevels(workflow.jobs).flat()) {
        const definition: JobDefinition = { job, workflowEnv: workflow.env }
        jobs.push(await createJob(options.db, { runId, jobKey: job.id, displayName: job.name, labels: job.runsOn, needs: job.needs, definition }, now))
      }
      for (const job of jobs) if (job.status === 'queued') await launchJob(options, job, event.repo.owner, event.repo.name)
      queued.push({ runId, workflowPath: file.path, jobs })
    }
  }
  return queued
}

export const advanceRun = async (options: DispatchOptions, completed: JobRow): Promise<JobRow[]> => {
  const now = (options.now ?? Date.now)()
  const run = await getRun(options.db, completed.run_id)
  if (!run) return []
  const started: JobRow[] = []
  let changed = true
  while (changed) {
    changed = false
    const jobs = await listRunJobs(options.db, completed.run_id)
    const byKey = new Map(jobs.map((job) => [job.job_key, job]))
    for (const job of jobs) {
      if (job.status !== 'pending') continue
      const needs = (JSON.parse(job.needs) as string[]).map((key) => byKey.get(key))
      if (needs.some((need) => need?.status === 'completed' && need.conclusion !== 'success')) {
        if (await skipJob(options.db, job.request_id, now)) changed = true
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
