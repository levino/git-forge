import type { Database } from '@git-forge/accounts'
import { commitTarball, gzipStream, isValidName, ObjectDatabase, readAll, resolveCommitish, type Storage } from '@git-forge/core'
import { jobDefinitionOf } from './definitions.ts'
import {
  ApprovalError,
  cancelRun,
  type CheckRunSink,
  createJitRunner,
  DispatchError,
  type DispatchOptions,
  dispatchWorkflow,
  pendingDeployments,
  RerunError,
  rerunRun,
  reviewDeployment,
  type RunnerLauncher,
  type ServiceUrls,
} from './dispatch.ts'
import {
  deleteEnvironment,
  deleteSecret,
  ENVIRONMENT_NAME,
  type Environment,
  type EnvironmentReviewer,
  getEnvironment,
  getSecretInfo,
  listEnvironments,
  listSecrets,
  putEnvironment,
  putSecret,
  SecretNameError,
  type SecretInfo,
  type SecretScope,
  type SecretsKey,
} from './secrets.ts'
import { consolePrefix, jobPrefix, logChunkKey } from './service.ts'
import {
  getJob,
  getRun,
  getRunner,
  issueToken,
  type JobRow,
  listCurrentJobs,
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
  readonly authorizeRead?: RepositoryAuthorize
  readonly authorizeWrite?: RepositoryAuthorize
  readonly actor?: (request: Request) => Promise<string | null>
  readonly secretsKey?: SecretsKey
  readonly launcher?: RunnerLauncher
  readonly checks?: CheckRunSink
  readonly log?: (event: Record<string, unknown>) => void
  readonly now?: () => number
}

export const REGISTRATION_TOKEN_TTL_MS = 60 * 60 * 1000

export const GHES_VERSION = '3.14.0'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-GitHub-Enterprise-Version': GHES_VERSION } })

const error = (status: number, message: string) => json(status, { message, documentation_url: 'https://docs.github.com/enterprise-server@3.14/rest' })

const noContent = (status = 204) => new Response(null, { status })

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString())

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

const runStatus = (run: RunRow, jobs: readonly JobRow[]): string => {
  if (run.completed_at !== null) return 'completed'
  if (jobs.some((job) => job.status === 'in_progress' || job.status === 'assigned')) return 'in_progress'
  if (jobs.some((job) => job.approval === 'waiting' && job.status === 'pending')) return 'waiting'
  return 'queued'
}

const legacyConclusion = (jobs: readonly JobRow[]): string | null => {
  if (!jobs.every((job) => job.status === 'completed')) return null
  const failed = jobs.find((job) => job.conclusion !== 'success' && job.conclusion !== 'skipped')
  return failed ? failed.conclusion : 'success'
}

const runJson = (run: RunRow, jobs: readonly JobRow[], urls: ServiceUrls) => {
  const legacy = run.definition === null ? legacyConclusion(jobs) : null
  return {
    id: run.id,
    name: run.workflow_name,
    path: run.workflow_path,
    event: run.event,
    head_branch: run.ref.replace(/^refs\/(heads|tags)\//, ''),
    head_sha: run.sha,
    status: legacy !== null ? 'completed' : runStatus(run, jobs),
    conclusion: run.conclusion ?? legacy,
    run_number: run.id,
    run_attempt: run.attempt,
    actor: { login: run.actor },
    created_at: new Date(run.created_at).toISOString(),
    updated_at: iso(run.completed_at ?? run.created_at),
    html_url: `${urls.serverUrl}/${run.owner}/${run.repo}/actions/runs/${run.id}`,
    jobs_url: `${urls.serverUrl}/api/v3/repos/${run.owner}/${run.repo}/actions/runs/${run.id}/jobs`,
    cancel_url: `${urls.serverUrl}/api/v3/repos/${run.owner}/${run.repo}/actions/runs/${run.id}/cancel`,
    rerun_url: `${urls.serverUrl}/api/v3/repos/${run.owner}/${run.repo}/actions/runs/${run.id}/rerun`,
  }
}

const jobStatus = (job: JobRow): string => {
  if (job.status === 'pending') return job.approval === 'waiting' ? 'waiting' : job.expanded === 0 ? 'pending' : 'queued'
  if (job.status === 'assigned') return 'queued'
  return job.status
}

const jobJson = (job: JobRow, run: RunRow | null, urls: ServiceUrls) => {
  const definition = jobDefinitionOf(job)
  return {
    id: job.request_id,
    run_id: job.run_id,
    run_attempt: job.attempt,
    head_sha: run?.sha ?? null,
    name: job.display_name,
    workflow_name: run?.workflow_name ?? null,
    status: jobStatus(job),
    conclusion: job.conclusion,
    labels: JSON.parse(job.labels) as string[],
    runner_id: job.runner_id,
    created_at: iso(job.queued_at),
    started_at: iso(job.started_at),
    completed_at: iso(job.completed_at),
    ...(run ? { html_url: `${urls.serverUrl}/${run.owner}/${run.repo}/actions/runs/${run.id}/job/${job.request_id}` } : {}),
    ...(job.check_run_id !== null && run ? { check_run_url: `${urls.serverUrl}/api/v3/repos/${run.owner}/${run.repo}/check-runs/${job.check_run_id}` } : {}),
    ...(job.environment ? { environment: job.environment } : {}),
    ...(job.cancel_reason ? { cancel_reason: job.cancel_reason } : {}),
    ...(definition.error ? { error: definition.error } : {}),
    ...(definition.matrix ? { matrix: definition.matrix } : {}),
    outputs: job.outputs ? (JSON.parse(job.outputs) as Record<string, string>) : {},
  }
}

const secretJson = (secret: SecretInfo) => ({ name: secret.name, created_at: new Date(secret.createdAt).toISOString(), updated_at: new Date(secret.updatedAt).toISOString() })

const environmentJson = (environment: Environment, urls: ServiceUrls) => ({
  id: environment.id,
  name: environment.name,
  url: `${urls.serverUrl}/api/v3/repos/${environment.owner}/${environment.repo}/environments/${encodeURIComponent(environment.name)}`,
  created_at: new Date(environment.createdAt).toISOString(),
  updated_at: new Date(environment.updatedAt).toISOString(),
  protection_rules:
    environment.reviewers.length === 0
      ? []
      : [{ id: environment.id, type: 'required_reviewers', reviewers: environment.reviewers.map((reviewer) => ({ type: reviewer.type, reviewer: { login: reviewer.login } })) }],
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

const dispatchOptionsOf = (options: GhesApiOptions): DispatchOptions => ({
  db: options.db,
  storage: options.storage,
  urls: options.urls,
  ...(options.launcher ? { launcher: options.launcher } : {}),
  ...(options.checks ? { checks: options.checks } : {}),
  ...(options.now ? { now: options.now } : {}),
  ...(options.log ? { log: options.log } : {}),
})

type RepoRequest = {
  readonly options: GhesApiOptions
  readonly request: Request
  readonly url: URL
  readonly owner: string
  readonly repo: string
  readonly now: number
}

const tarball = async (context: RepoRequest, ref: string): Promise<Response> => {
  const repo = { owner: context.owner, name: context.repo }
  const sha = await resolveCommitish(context.options.storage, repo, decodeURIComponent(ref))
  if (!sha) return error(404, 'Not Found')
  const prefix = `${context.owner}-${context.repo}-${sha.slice(0, 7)}`
  const body = gzipStream(commitTarball(new ObjectDatabase(context.options.storage, repo), sha, { prefix }))
  return new Response(body, {
    headers: {
      'Content-Type': 'application/x-gzip',
      'Content-Disposition': `attachment; filename=${prefix}.tar.gz`,
      'Cache-Control': 'private, max-age=86400, immutable',
      ETag: `"${sha}"`,
    },
  })
}

const secretRoutes = async (context: RepoRequest, scope: SecretScope, rest: readonly string[]): Promise<Response> => {
  const { options, request, now } = context
  const method = request.method
  if (rest.length === 0 && method === 'GET') {
    const secrets = await listSecrets(options.db, scope)
    return json(200, { total_count: secrets.length, secrets: secrets.map(secretJson) })
  }
  if (rest.length === 1 && rest[0] === 'public-key') {
    return error(501, 'this forge stores secrets encrypted with its own instance key; send the plain value as "value" over HTTPS instead of a sealed box')
  }
  if (rest.length !== 1) return error(404, 'Not Found')
  const name = decodeURIComponent(rest[0]!)
  if (method === 'GET') {
    const secret = await getSecretInfo(options.db, scope, name)
    return secret ? json(200, secretJson(secret)) : error(404, 'Not Found')
  }
  if (method === 'DELETE') return (await deleteSecret(options.db, scope, name)) ? noContent() : error(404, 'Not Found')
  if (method !== 'PUT') return error(404, 'Not Found')
  if (!options.secretsKey) return error(503, 'secrets are not configured on this instance (ACTIONS_SECRETS_KEY is missing)')
  const body = await readBody(request)
  const value = body?.['value']
  if (typeof value !== 'string') {
    return error(422, body?.['encrypted_value'] !== undefined ? 'sealed boxes are not supported; send the plain value as "value"' : 'value must be a string')
  }
  try {
    const outcome = await putSecret(options.db, options.secretsKey, scope, name, value, now)
    return noContent(outcome === 'created' ? 201 : 204)
  } catch (caught) {
    if (caught instanceof SecretNameError) return error(422, caught.message)
    throw caught
  }
}

const parseReviewers = (value: unknown): EnvironmentReviewer[] | null => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return null
  const reviewers: EnvironmentReviewer[] = []
  for (const entry of value) {
    const candidate = entry as { type?: unknown; login?: unknown; id?: unknown }
    const login = typeof candidate?.login === 'string' ? candidate.login : typeof candidate?.id === 'string' ? candidate.id : null
    if ((candidate?.type !== undefined && candidate.type !== 'User') || login === null || !isValidName(login)) return null
    reviewers.push({ type: 'User', login })
  }
  return reviewers
}

const environmentRoutes = async (context: RepoRequest, rest: readonly string[]): Promise<Response> => {
  const { options, request, owner, repo, now } = context
  const method = request.method
  if (rest.length === 0 && method === 'GET') {
    const environments = await listEnvironments(options.db, owner, repo)
    return json(200, { total_count: environments.length, environments: environments.map((environment) => environmentJson(environment, options.urls)) })
  }
  const name = decodeURIComponent(rest[0] ?? '')
  if (!ENVIRONMENT_NAME.test(name)) return error(422, 'invalid environment name')
  if (rest.length === 1) {
    if (method === 'GET') {
      const environment = await getEnvironment(options.db, owner, repo, name)
      return environment ? json(200, environmentJson(environment, options.urls)) : error(404, 'Not Found')
    }
    if (method === 'DELETE') return (await deleteEnvironment(options.db, owner, repo, name)) ? noContent() : error(404, 'Not Found')
    if (method === 'PUT') {
      const body = (await readBody(request)) ?? {}
      const reviewers = parseReviewers(body['reviewers'])
      if (!reviewers) return error(422, 'reviewers must be a list of { type: "User", login }')
      const existing = await getEnvironment(options.db, owner, repo, name)
      return json(200, environmentJson(await putEnvironment(options.db, owner, repo, existing?.name ?? name, reviewers, now), options.urls))
    }
  }
  if (rest[1] === 'secrets') {
    const environment = await getEnvironment(options.db, owner, repo, name)
    if (!environment) return error(404, 'Not Found')
    return secretRoutes(context, { owner, repo, environment: environment.name }, rest.slice(2))
  }
  return error(404, 'Not Found')
}

const pendingDeploymentRoutes = async (context: RepoRequest, run: RunRow): Promise<Response> => {
  const { options, request } = context
  const waiting = await pendingDeployments(options.db, run.id)
  const environments = new Map<string, Environment>()
  for (const job of waiting) {
    const environment = job.environment ? await getEnvironment(options.db, run.owner, run.repo, job.environment) : null
    if (environment) environments.set(environment.name, environment)
  }
  if (request.method === 'GET') {
    const login = (await options.actor?.(request)) ?? null
    return json(
      200,
      [...environments.values()].map((environment) => ({
        environment: { id: environment.id, name: environment.name },
        wait_timer: 0,
        current_user_can_approve: login !== null && environment.reviewers.some((reviewer) => reviewer.login.toLowerCase() === login.toLowerCase()),
        reviewers: environment.reviewers.map((reviewer) => ({ type: reviewer.type, reviewer: { login: reviewer.login } })),
      })),
    )
  }
  if (request.method !== 'POST') return error(404, 'Not Found')
  const login = (await options.actor?.(request)) ?? null
  if (!login) return error(403, 'reviewing deployments needs a user')
  const body = await readBody(request)
  const state = body?.['state']
  const ids = body?.['environment_ids']
  if ((state !== 'approved' && state !== 'rejected') || !Array.isArray(ids)) return error(422, 'expected environment_ids and state "approved" or "rejected"')
  const selected = [...environments.values()].filter((environment) => ids.includes(environment.id))
  if (selected.length === 0) return error(422, 'none of the environments is waiting for a review in this run')
  const reviewed: JobRow[] = []
  try {
    for (const job of waiting) {
      if (selected.some((environment) => environment.name === job.environment)) reviewed.push(await reviewDeployment(dispatchOptionsOf(options), job.request_id, login, state === 'approved'))
    }
  } catch (caught) {
    if (caught instanceof ApprovalError) return error(422, caught.message)
    throw caught
  }
  return json(
    200,
    reviewed.map((job) => ({ id: job.request_id, environment: job.environment, state: job.approval, reviewed_by: job.reviewed_by })),
  )
}

const runRoutes = async (context: RepoRequest, rest: readonly string[]): Promise<Response> => {
  const { options, request, owner, repo } = context
  const method = request.method
  const read = options.authorizeRead ?? options.authorize
  const write = options.authorizeWrite ?? options.authorize
  if (rest.length === 0) {
    if (method !== 'GET' || !(await read(request, owner, repo))) return error(404, 'Not Found')
    const runs = await listRuns(options.db, owner, repo)
    const withJobs = await Promise.all(runs.map(async (run) => runJson(run, await listCurrentJobs(options.db, run.id), options.urls)))
    return json(200, { total_count: runs.length, workflow_runs: withJobs })
  }
  const run = /^\d+$/.test(rest[0] ?? '') ? await getRun(options.db, Number(rest[0])) : null
  if (!run || run.owner !== owner || run.repo !== repo || !(await read(request, owner, repo))) return error(404, 'Not Found')
  const action = rest[1]
  if (rest.length === 1 && method === 'GET') return json(200, runJson(run, await listCurrentJobs(options.db, run.id), options.urls))
  if (rest.length === 2 && action === 'jobs' && method === 'GET') {
    const jobs = context.url.searchParams.get('filter') === 'all' ? await listRunJobs(options.db, run.id) : await listCurrentJobs(options.db, run.id)
    return json(200, { total_count: jobs.length, jobs: jobs.map((job) => jobJson(job, run, options.urls)) })
  }
  if (rest.length === 2 && action === 'pending_deployments') return pendingDeploymentRoutes(context, run)
  if (rest.length !== 2 || method !== 'POST') return error(404, 'Not Found')
  if (!(await write(request, owner, repo))) return error(403, 'write access is required')
  if (action === 'cancel' || action === 'force-cancel') {
    if (!(await cancelRun(dispatchOptionsOf(options), run.id))) return error(409, 'Cannot cancel a workflow run that is completed.')
    return json(202, {})
  }
  if (action === 'rerun' || action === 'rerun-failed-jobs') {
    try {
      await rerunRun(dispatchOptionsOf(options), run.id, { kind: action === 'rerun' ? 'all' : 'failed' })
    } catch (caught) {
      if (caught instanceof RerunError) return error(403, caught.message)
      throw caught
    }
    return json(201, {})
  }
  return error(404, 'Not Found')
}

const actionsRoutes = async (context: RepoRequest, collection: string | undefined, rest: readonly string[]): Promise<Response> => {
  const { options, request, url, owner, repo, now } = context
  const method = request.method
  if (collection === 'runs') return runRoutes(context, rest)
  if (collection === 'jobs' && rest.length >= 1 && /^\d+$/.test(rest[0]!)) {
    const read = options.authorizeRead ?? options.authorize
    const job = await getJob(options.db, Number(rest[0]))
    const run = job ? await getRun(options.db, job.run_id) : null
    if (!job || !run || run.owner !== owner || run.repo !== repo || !(await read(request, owner, repo))) return error(404, 'Not Found')
    if (rest.length === 1 && method === 'GET') return json(200, jobJson(job, run, options.urls))
    if (rest.length === 2 && rest[1] === 'logs' && method === 'GET') return jobLogs(options, run, job)
    if (rest.length === 2 && rest[1] === 'rerun' && method === 'POST') {
      if (!(await (options.authorizeWrite ?? options.authorize)(request, owner, repo))) return error(403, 'write access is required')
      try {
        await rerunRun(dispatchOptionsOf(options), run.id, { kind: 'job', requestId: job.request_id })
      } catch (caught) {
        if (caught instanceof RerunError) return error(403, caught.message)
        throw caught
      }
      return json(201, {})
    }
    return error(404, 'Not Found')
  }
  if (collection === 'workflows' && rest.length === 2 && rest[1] === 'dispatches' && method === 'POST') {
    if (!(await (options.authorizeWrite ?? options.authorize)(request, owner, repo))) return error(404, 'Not Found')
    const body = await readBody(request)
    const ref = body?.['ref']
    const inputs = body?.['inputs'] ?? {}
    if (typeof ref !== 'string' || typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) return error(422, 'expected { ref, inputs }')
    try {
      await dispatchWorkflow(dispatchOptionsOf(options), {
        repo: { owner, name: repo },
        workflowId: decodeURIComponent(rest[0]!),
        ref,
        inputs: inputs as Record<string, unknown>,
        actor: (await options.actor?.(request)) ?? 'unknown',
      })
    } catch (caught) {
      if (caught instanceof DispatchError) return error(caught.status, caught.message)
      throw caught
    }
    return noContent()
  }
  if (!(await options.authorize(request, owner, repo))) return error(404, 'Not Found')
  if (collection === 'secrets') return secretRoutes(context, { owner, repo, environment: '' }, rest.map(decodeURIComponent))
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
        return noContent()
      }
    }
  }
  return error(404, 'Not Found')
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
  if (scope !== 'repos' || !owner || !repo || !isValidName(owner) || !isValidName(repo)) return error(404, 'Not Found')
  const context: RepoRequest = { options, request, url, owner, repo, now }
  const read = options.authorizeRead ?? options.authorize
  if ((area === 'tarball' || area === 'zipball') && collection && rest.length === 0 && (method === 'GET' || method === 'HEAD')) {
    if (!(await read(request, owner, repo))) return error(404, 'Not Found')
    return area === 'tarball' ? tarball(context, collection) : error(501, 'zipballs are not supported; use the tarball')
  }
  if (area === 'environments') {
    if (!(await options.authorize(request, owner, repo))) return error(404, 'Not Found')
    return environmentRoutes(context, [collection, ...rest].filter((segment): segment is string => segment !== undefined))
  }
  if (area !== 'actions') return error(404, 'Not Found')
  return actionsRoutes(context, collection, rest)
}
