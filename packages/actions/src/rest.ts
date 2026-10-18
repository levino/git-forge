import type { Database } from '@git-forge/accounts'
import { isValidName, readAll, type Storage } from '@git-forge/core'
import { createJitRunner, type ServiceUrls } from './dispatch.ts'
import { consolePrefix, jobPrefix, logChunkKey } from './service.ts'
import {
  getJob,
  getRun,
  getRunner,
  issueToken,
  type JobRow,
  listLogs,
  listRunJobs,
  listRunners,
  listRuns,
  removeRunner,
  type Runner,
  RunnerExistsError,
  type RunRow,
  verifyToken,
} from './store.ts'

export type RepositoryAuthorize = (request: Request, owner: string, repo: string) => Promise<boolean>

export type GhesApiOptions = {
  readonly db: Database
  readonly storage: Storage
  readonly urls: ServiceUrls
  readonly authorize: RepositoryAuthorize
  readonly now?: () => number
}

export const REGISTRATION_TOKEN_TTL_MS = 60 * 60 * 1000

export const GHES_VERSION = '3.14.0'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-GitHub-Enterprise-Version': GHES_VERSION } })

const error = (status: number, message: string) => json(status, { message, documentation_url: 'https://docs.github.com/enterprise-server@3.14/rest' })

const runnerJson = (runner: Runner) => ({
  id: runner.id,
  name: runner.name,
  os: 'linux',
  status: runner.status === 'online' ? 'online' : 'offline',
  busy: false,
  ephemeral: runner.ephemeral,
  runner_group_id: 1,
  labels: runner.labels.map((name, index) => ({ id: index + 1, name, type: 'custom' })),
})

const runJson = (run: RunRow, jobs: readonly JobRow[], urls: ServiceUrls) => {
  const done = jobs.every((job) => job.status === 'completed')
  const failed = jobs.find((job) => job.status === 'completed' && job.conclusion !== 'success' && job.conclusion !== 'skipped')
  return {
    id: run.id,
    name: run.workflow_name,
    path: run.workflow_path,
    event: run.event,
    head_branch: run.ref.replace(/^refs\/(heads|tags)\//, ''),
    head_sha: run.sha,
    status: done ? 'completed' : jobs.some((job) => job.status === 'in_progress' || job.status === 'assigned') ? 'in_progress' : 'queued',
    conclusion: done ? (failed ? failed.conclusion : 'success') : null,
    run_number: run.id,
    run_attempt: 1,
    created_at: new Date(run.created_at).toISOString(),
    html_url: `${urls.serverUrl}/${run.owner}/${run.repo}/actions/runs/${run.id}`,
  }
}

const jobJson = (job: JobRow) => ({
  id: job.request_id,
  run_id: job.run_id,
  name: job.display_name,
  status: job.status === 'assigned' ? 'queued' : job.status === 'pending' ? 'waiting' : job.status,
  conclusion: job.conclusion,
  labels: JSON.parse(job.labels) as string[],
  runner_id: job.runner_id,
  started_at: job.started_at ? new Date(job.started_at).toISOString() : null,
  completed_at: job.completed_at ? new Date(job.completed_at).toISOString() : null,
})

const readBody = async (request: Request): Promise<Record<string, unknown> | null> => {
  try {
    const value: unknown = await request.json()
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const RUNNER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const generateJitConfig = async (options: GhesApiOptions, request: Request, owner: string, repo: string, now: number): Promise<Response> => {
  const body = await readBody(request)
  const name = body?.['name']
  const labels = body?.['labels']
  const workFolder = body?.['work_folder']
  if (typeof name !== 'string' || !RUNNER_NAME.test(name)) return error(422, 'name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}')
  if (!Array.isArray(labels) || labels.length === 0 || !labels.every((label) => typeof label === 'string' && label.length > 0 && label.length <= 256)) {
    return error(422, 'labels must be a non-empty array of strings')
  }
  if (workFolder !== undefined && (typeof workFolder !== 'string' || workFolder.includes('..'))) return error(422, 'invalid work_folder')
  try {
    const { runner, encodedJitConfig } = await createJitRunner(
      options.db,
      options.urls,
      { name, owner, repo, labels: labels as string[], ...(typeof workFolder === 'string' ? { workFolder } : {}) },
      now,
    )
    return json(201, { runner: runnerJson(runner), encoded_jit_config: encodedJitConfig })
  } catch (caught) {
    if (caught instanceof RunnerExistsError) return error(409, `a runner named ${name} already exists`)
    throw caught
  }
}

const jobLogs = async (options: GhesApiOptions, run: RunRow, job: JobRow): Promise<Response> => {
  const prefix = jobPrefix(run.owner, run.repo, job.id)
  const parts: Uint8Array[] = []
  for (const log of await listLogs(options.db, job.id)) {
    for (let chunk = 0; chunk < log.chunks; chunk++) {
      const stored = await options.storage.get(logChunkKey(prefix, log.id, chunk))
      if (stored) parts.push(await readAll(stored.body))
    }
  }
  if (parts.length === 0) {
    for await (const info of options.storage.list(consolePrefix(prefix))) {
      const stored = await options.storage.get(info.key)
      if (stored) parts.push(await readAll(stored.body))
    }
  }
  return new Response(new Blob(parts as Uint8Array<ArrayBuffer>[]), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

const runnerRegistration = async (options: GhesApiOptions, request: Request, now: number): Promise<Response> => {
  const header = request.headers.get('Authorization') ?? ''
  const token = header.startsWith('RemoteAuth ') ? header.slice('RemoteAuth '.length).trim() : ''
  const row = token ? await verifyToken(options.db, token, 'registration', now) : null
  if (!row) return error(401, 'invalid registration token')
  return json(200, { url: options.urls.serviceUrl, token, token_schema: 'OAuthAccessToken', use_v2_flow: false })
}

export const handleGhesApi = async (request: Request, options: GhesApiOptions): Promise<Response | null> => {
  const url = new URL(request.url)
  if (url.pathname !== '/api/v3' && !url.pathname.startsWith('/api/v3/')) return null
  const now = (options.now ?? Date.now)()
  const segments = url.pathname.slice('/api/v3'.length).split('/').filter((segment) => segment !== '')
  const method = request.method
  if (segments.length === 0 || (segments.length === 1 && segments[0] === 'meta')) return json(200, { installed_version: GHES_VERSION, verifiable_password_authentication: false })
  if (segments.join('/') === 'actions/runner-registration' && method === 'POST') return runnerRegistration(options, request, now)
  const [scope, owner, repo, area, collection, ...rest] = segments
  if (scope !== 'repos' || !owner || !repo || area !== 'actions' || !isValidName(owner) || !isValidName(repo)) return error(404, 'Not Found')
  if (!(await options.authorize(request, owner, repo))) return error(404, 'Not Found')
  if (collection === 'runners') {
    if (rest.length === 0 && method === 'GET') {
      const runners = await listRunners(options.db, owner, repo, url.searchParams.get('name') ?? undefined)
      return json(200, { total_count: runners.length, runners: runners.map(runnerJson) })
    }
    if (rest.length === 1 && rest[0] === 'generate-jitconfig' && method === 'POST') return generateJitConfig(options, request, owner, repo, now)
    if (rest.length === 1 && (rest[0] === 'registration-token' || rest[0] === 'remove-token') && method === 'POST') {
      const token = await issueToken(options.db, { kind: 'registration', owner, repo, ttlMs: REGISTRATION_TOKEN_TTL_MS }, now)
      return json(201, { token, expires_at: new Date(now + REGISTRATION_TOKEN_TTL_MS).toISOString() })
    }
    if (rest.length === 1 && /^\d+$/.test(rest[0]!)) {
      const runner = await getRunner(options.db, Number(rest[0]))
      if (!runner || runner.owner !== owner || runner.repo !== repo) return error(404, 'Not Found')
      if (method === 'GET') return json(200, runnerJson(runner))
      if (method === 'DELETE') {
        await removeRunner(options.db, runner.id, now)
        return new Response(null, { status: 204 })
      }
    }
    return error(404, 'Not Found')
  }
  if (collection === 'runs' && method === 'GET') {
    if (rest.length === 0) {
      const runs = await listRuns(options.db, owner, repo)
      const withJobs = await Promise.all(runs.map(async (run) => runJson(run, await listRunJobs(options.db, run.id), options.urls)))
      return json(200, { total_count: runs.length, workflow_runs: withJobs })
    }
    const run = /^\d+$/.test(rest[0] ?? '') ? await getRun(options.db, Number(rest[0])) : null
    if (!run || run.owner !== owner || run.repo !== repo) return error(404, 'Not Found')
    const jobs = await listRunJobs(options.db, run.id)
    if (rest.length === 1) return json(200, runJson(run, jobs, options.urls))
    if (rest.length === 2 && rest[1] === 'jobs') return json(200, { total_count: jobs.length, jobs: jobs.map(jobJson) })
    return error(404, 'Not Found')
  }
  if (collection === 'jobs' && method === 'GET' && rest.length >= 1 && /^\d+$/.test(rest[0]!)) {
    const job = await getJob(options.db, Number(rest[0]))
    const run = job ? await getRun(options.db, job.run_id) : null
    if (!job || !run || run.owner !== owner || run.repo !== repo) return error(404, 'Not Found')
    if (rest.length === 1) return json(200, jobJson(job))
    if (rest.length === 2 && rest[1] === 'logs') return jobLogs(options, run, job)
  }
  return error(404, 'Not Found')
}
