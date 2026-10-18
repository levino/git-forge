import type { Database } from '@git-forge/accounts'
import { readAll, repositoryPrefix, type Storage, type WorkflowEnv, type WorkflowJob } from '@git-forge/core'
import { buildJobMessage, JOB_REQUEST_MESSAGE_TYPE } from './job-message.ts'
import { verifyClientAssertion } from './keys.ts'
import {
  claimJob,
  closeSession,
  completeJob,
  createLog,
  createRunner,
  createSession,
  getJob,
  getJobById,
  getLog,
  getRun,
  getRunner,
  getRunnerByClientId,
  getSession,
  issueToken,
  listRunners,
  type JobRow,
  pendingDelivery,
  recordLogChunk,
  removeRunner,
  renewJob,
  revokeJobTokens,
  type Runner,
  RunnerExistsError,
  touchSession,
  upsertTimelineRecords,
  verifyToken,
} from './store.ts'

export type SecretsProvider = (owner: string, repo: string) => Promise<Readonly<Record<string, string>>>

export type JobDefinition = {
  readonly job: WorkflowJob
  readonly workflowEnv: WorkflowEnv
}

export type ActionsServiceOptions = {
  readonly db: Database
  readonly storage: Storage
  readonly basePath: string
  readonly instanceId: string
  readonly serverUrl?: string
  readonly secrets?: SecretsProvider
  readonly now?: () => number
  readonly messageWaitMs?: number
  readonly pollIntervalMs?: number
  readonly onJobCompleted?: (job: JobRow) => Promise<void>
}

export const POOL_ID = 1

export const authorizationUrl = (serviceUrl: string): string => `${serviceUrl}/_apis/v1/auth/`

export const POOL_NAME = 'Default'

export const RUNNER_TOKEN_TTL_MS = 60 * 60 * 1000

const LOCK_DURATION_MS = 10 * 60 * 1000

const MAX_UNSIZED_UPLOAD_BYTES = 16 * 1024 * 1024

type Definition = { readonly id: string; readonly name: string; readonly path: string }

export const SERVICE_DEFINITIONS: readonly Definition[] = [
  { id: 'a8c47e17-4d56-4a56-92bb-de7ea7dc65be', name: 'AgentPools', path: '/_apis/v1/AgentPools/{poolId}' },
  { id: 'e298ef32-5878-4cab-993c-043836571f42', name: 'Agent', path: '/_apis/v1/Agent/{poolId}/{agentId}' },
  { id: '134e239e-2df3-4794-a6f6-24f1f19ec8dc', name: 'AgentSession', path: '/_apis/v1/AgentSession/{poolId}/{sessionId}' },
  { id: 'c3a054f6-7a8a-49c0-944e-3a8e5d7adfd7', name: 'Message', path: '/_apis/v1/Message/{poolId}/{messageId}' },
  { id: 'fc825784-c92a-4299-9221-998a02d1b54f', name: 'AgentRequest', path: '/_apis/v1/AgentRequest/{poolId}/{requestId}' },
  { id: '27d7f831-88c1-4719-8ca1-6a061dad90eb', name: 'ActionDownloadInfo', path: '/_apis/v1/ActionDownloadInfo/{scopeIdentifier}/{hubName}/{planId}' },
  { id: '858983e4-19bd-4c5e-864c-507b59b58b12', name: 'TimeLineWebConsoleLog', path: '/_apis/v1/TimeLineWebConsoleLog/{scopeIdentifier}/{hubName}/{planId}/{timelineId}/{recordId}' },
  { id: '8893bc5b-35b2-4be7-83cb-99e683551db4', name: 'TimelineRecords', path: '/_apis/v1/Timeline/{scopeIdentifier}/{hubName}/{planId}/{timelineId}' },
  { id: '46f5667d-263a-4684-91b1-dff7fdcf64e2', name: 'Logfiles', path: '/_apis/v1/Logfiles/{scopeIdentifier}/{hubName}/{planId}/{logId}' },
  { id: '557624af-b29e-4c20-8ab0-0399d2204f3f', name: 'FinishJob', path: '/_apis/v1/FinishJob/{scopeIdentifier}/{hubName}/{planId}' },
  { id: '7898f959-9cdf-4096-b29e-7f293031629e', name: 'TimelineAttachments', path: '/_apis/v1/Timeline/{scopeIdentifier}/{hubName}/{planId}/{timelineId}/attachments/{recordId}/{type}/{name}' },
  { id: '83597576-cc2c-453c-bea6-2882ae6a1653', name: 'Timeline', path: '/_apis/v1/Timeline/{scopeIdentifier}/{hubName}/{planId}/timeline/{timelineId}' },
]

const FULLY_QUALIFIED = 3

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } })

const vssError = (status: number, typeName: string, message: string, headers: Record<string, string> = {}) =>
  json(status, { $id: '1', innerException: null, message, typeName, typeKey: typeName.split('.').pop(), errorCode: 0, eventId: 3000 }, headers)

const unauthorized = () => vssError(401, 'Microsoft.VisualStudio.Services.Common.VssUnauthorizedException', 'authentication required', { 'WWW-Authenticate': 'Bearer' })

const notFound = (what = 'resource') => vssError(404, 'GitHub.Services.WebApi.VssResourceNotFoundException', `${what} not found`)

const empty = (status = 200) => new Response(null, { status })

const iso = (ms: number): string => new Date(ms).toISOString()

const TASK_RESULTS = ['succeeded', 'succeededWithIssues', 'failed', 'canceled', 'skipped', 'abandoned'] as const

export type TaskResult = (typeof TASK_RESULTS)[number]

export const parseTaskResult = (value: unknown): TaskResult | null => {
  if (typeof value === 'number') return TASK_RESULTS[value] ?? null
  if (typeof value !== 'string') return null
  return TASK_RESULTS.find((result) => result.toLowerCase() === value.toLowerCase()) ?? null
}

export const conclusionOf = (result: TaskResult): string => {
  if (result === 'succeeded' || result === 'succeededWithIssues') return 'success'
  if (result === 'canceled') return 'cancelled'
  if (result === 'skipped') return 'skipped'
  return 'failure'
}

export const taskResultOf = (conclusion: string | null): TaskResult => {
  if (conclusion === 'success') return 'succeeded'
  if (conclusion === 'cancelled') return 'canceled'
  if (conclusion === 'skipped') return 'skipped'
  return 'failed'
}

const bearer = (request: Request): string | null => {
  const header = request.headers.get('Authorization') ?? ''
  const [scheme, value] = header.split(' ', 2) as [string, string | undefined]
  return value && scheme.toLowerCase() === 'bearer' ? value.trim() : null
}

const readJson = async <T>(request: Request): Promise<T | null> => {
  try {
    return (await request.json()) as T
  } catch {
    return null
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const route = (segments: readonly string[], pattern: string): Record<string, string> | null => {
  const parts = pattern.split('/')
  if (segments.length !== parts.length) return null
  const params: Record<string, string> = {}
  for (const [index, part] of parts.entries()) {
    const segment = segments[index]!
    if (part.startsWith('{')) params[part.slice(1, -1)] = segment
    else if (part.toLowerCase() !== segment.toLowerCase()) return null
  }
  return params
}

type Context = {
  readonly options: ActionsServiceOptions
  readonly request: Request
  readonly url: URL
  readonly now: number
  readonly serviceUrl: string
  readonly serverUrl: string
}

const authenticateRunner = async (context: Context): Promise<Runner | null> => {
  const token = bearer(context.request)
  if (!token) return null
  const row = await verifyToken(context.options.db, token, 'runner', context.now)
  return row?.runner_id ? getRunner(context.options.db, row.runner_id) : null
}

type AuthenticatedJob = { readonly job: JobRow; readonly prefix: string }

const authenticateJob = async (context: Context, planId: string): Promise<AuthenticatedJob | null> => {
  const token = bearer(context.request)
  if (!token) return null
  const row = await verifyToken(context.options.db, token, 'runtime', context.now)
  if (!row?.job_id || !row.owner || !row.repo) return null
  const job = await getJobById(context.options.db, row.job_id)
  return job && job.plan_id.toLowerCase() === planId.toLowerCase() ? { job, prefix: jobPrefix(row.owner, row.repo, job.id) } : null
}

const connectionData = (context: Context) =>
  json(200, {
    instanceId: context.options.instanceId,
    deploymentId: context.options.instanceId,
    deploymentType: 'onPremises',
    locationServiceData: {
      serviceOwner: '00000000-0000-0000-0000-000000000000',
      defaultAccessMappingMoniker: 'PublicAccessMapping',
      lastChangeId: 1,
      lastChangeId64: 1,
      clientCacheFresh: false,
      serviceDefinitions: SERVICE_DEFINITIONS.map((definition) => ({
        serviceType: definition.name,
        identifier: definition.id,
        displayName: definition.name,
        relativeToSetting: FULLY_QUALIFIED,
        relativePath: definition.path,
        description: definition.name,
        serviceOwner: '00000000-0000-0000-0000-000000000000',
        resourceVersion: 6,
        minVersion: '1.0',
        maxVersion: '12.0',
        releasedVersion: '0.0',
      })),
    },
  })

const resourceLocations = () =>
  json(200, {
    count: SERVICE_DEFINITIONS.length,
    value: SERVICE_DEFINITIONS.map((definition) => ({
      id: definition.id,
      area: definition.name,
      resourceName: definition.name,
      routeTemplate: definition.path,
      resourceVersion: 6,
      minVersion: '1.0',
      maxVersion: '12.0',
      releasedVersion: '0.0',
    })),
  })

const tokenEndpoint = async (context: Context): Promise<Response> => {
  const form = new URLSearchParams(await context.request.text())
  const assertion = form.get('client_assertion')
  if (form.get('grant_type') !== 'client_credentials' || form.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' || !assertion) {
    return json(400, { error: 'invalid_request' })
  }
  const payload = assertion.split('.')[1]
  let clientId: unknown
  try {
    clientId = JSON.parse(atob((payload ?? '').replace(/-/g, '+').replace(/_/g, '/'))).sub
  } catch {
    return json(400, { error: 'invalid_client' })
  }
  const runner = typeof clientId === 'string' ? await getRunnerByClientId(context.options.db, clientId) : null
  const audience = authorizationUrl(context.serviceUrl)
  if (!runner || !(await verifyClientAssertion(assertion, runner.publicKey, { clientId: runner.clientId, audience, now: context.now }))) {
    return json(401, { error: 'invalid_client' })
  }
  const token = await issueToken(context.options.db, { kind: 'runner', runnerId: runner.id, ttlMs: RUNNER_TOKEN_TTL_MS }, context.now)
  return json(200, { access_token: token, token_type: 'Bearer', expires_in: RUNNER_TOKEN_TTL_MS / 1000, scope: '/' })
}

const base64UrlToBase64 = (value: string): string => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  return base64 + '='.repeat((4 - (base64.length % 4)) % 4)
}

const agentJson = (runner: Runner) => ({
  id: runner.id,
  name: runner.name,
  version: '2.0.0',
  enabled: true,
  status: runner.status === 'online' ? 'online' : 'offline',
  ephemeral: runner.ephemeral,
  labels: runner.labels.map((name, index) => ({ id: index + 1, name, type: 'system' })),
  authorization: { clientId: runner.clientId, publicKey: { exponent: base64UrlToBase64(runner.publicKey.e), modulus: base64UrlToBase64(runner.publicKey.n) } },
  createdOn: iso(runner.createdAt),
  provisioningState: 'Provisioned',
})

const createSessionRoute = async (context: Context, runner: Runner): Promise<Response> => {
  const body = await readJson<{ ownerName?: string; agent?: { id?: number } }>(context.request)
  if (!body) return vssError(400, 'System.ArgumentException', 'expected a TaskAgentSession')
  if (body.agent?.id !== undefined && Number(body.agent.id) !== runner.id) return vssError(403, 'GitHub.DistributedTask.WebApi.AccessDeniedException', 'session agent does not match the token')
  const id = await createSession(context.options.db, runner.id, String(body.ownerName ?? 'RUNNER'), context.now)
  return json(200, { sessionId: id, ownerName: body.ownerName ?? 'RUNNER', agent: agentJson(runner), useFipsEncryption: false })
}

const jobRequestJson = (job: JobRow, runner: Runner | null) => ({
  requestId: job.request_id,
  planType: 'actions',
  planId: job.plan_id,
  scopeId: job.plan_id,
  jobId: job.id,
  jobName: job.display_name,
  queueTime: iso(job.queued_at),
  ...(job.assigned_at ? { assignTime: iso(job.assigned_at) } : {}),
  ...(job.started_at ? { receiveTime: iso(job.started_at) } : {}),
  ...(job.completed_at ? { finishTime: iso(job.completed_at) } : {}),
  ...(job.locked_until ? { lockedUntil: iso(job.locked_until) } : {}),
  ...(job.status === 'completed' ? { result: taskResultOf(job.conclusion) } : {}),
  ...(runner ? { reservedAgent: { id: runner.id, name: runner.name } } : {}),
})

const deliver = async (context: Context, job: JobRow, runner: Runner): Promise<Response> => {
  const { db } = context.options
  const run = await getRun(db, job.run_id)
  if (!run) throw new Error(`job ${job.id} has no run ${job.run_id}`)
  const definition = JSON.parse(job.definition) as JobDefinition
  const ttlMs = (definition.job.timeoutMinutes + 60) * 60 * 1000
  const [runtimeToken, githubToken, secrets] = await Promise.all([
    issueToken(db, { kind: 'runtime', jobId: job.id, runnerId: runner.id, owner: run.owner, repo: run.repo, ttlMs }, context.now),
    issueToken(db, { kind: 'github', jobId: job.id, owner: run.owner, repo: run.repo, ttlMs }, context.now),
    context.options.secrets?.(run.owner, run.repo) ?? Promise.resolve({}),
  ])
  const message = buildJobMessage({
    requestId: job.request_id,
    jobId: job.id,
    planId: job.plan_id,
    timelineId: job.timeline_id,
    stepIds: definition.job.steps.map(() => crypto.randomUUID()),
    job: definition.job,
    run: {
      id: run.id,
      owner: run.owner,
      repo: run.repo,
      workflowName: run.workflow_name,
      workflowPath: run.workflow_path,
      workflowEnv: definition.workflowEnv,
      event: run.event,
      ref: run.ref,
      sha: run.sha,
      actor: run.actor,
    },
    serverUrl: context.serverUrl,
    serviceUrl: context.serviceUrl,
    runtimeToken,
    githubToken,
    secrets,
  })
  return json(200, { messageId: job.request_id, messageType: JOB_REQUEST_MESSAGE_TYPE, body: JSON.stringify(message) })
}

const getMessageRoute = async (context: Context, runner: Runner): Promise<Response> => {
  const { db } = context.options
  const sessionId = context.url.searchParams.get('sessionId') ?? ''
  const session = await getSession(db, sessionId)
  if (!session || session.runner_id !== runner.id) {
    return vssError(404, 'GitHub.DistributedTask.WebApi.TaskAgentSessionExpiredException', 'the session has expired')
  }
  const now = context.options.now ?? Date.now
  const deadline = now() + (context.options.messageWaitMs ?? 50_000)
  await touchSession(db, sessionId, now())
  for (;;) {
    const job = (await pendingDelivery(db, sessionId)) ?? (await claimJob(db, runner, sessionId, now()))
    if (job) return deliver({ ...context, now: now() }, job, runner)
    if (now() >= deadline) return empty(204)
    await sleep(Math.min(context.options.pollIntervalMs ?? 1000, Math.max(0, deadline - now())))
  }
}

const agentRequestRoute = async (context: Context, runner: Runner, requestId: number): Promise<Response> => {
  const { db } = context.options
  const job = await getJob(db, requestId)
  if (!job || job.runner_id !== runner.id) return vssError(404, 'GitHub.DistributedTask.WebApi.TaskAgentJobNotFoundException', `job request ${requestId} not found`)
  if (context.request.method === 'GET') return json(200, jobRequestJson(job, runner))
  if (context.request.method === 'DELETE') return empty(204)
  const body = await readJson<{ finishTime?: string; result?: unknown }>(context.request)
  if (body?.finishTime) {
    const result = parseTaskResult(body.result) ?? 'abandoned'
    await finish(context, job, result)
    return json(200, jobRequestJson((await getJob(db, requestId))!, runner))
  }
  const renewed = await renewJob(db, requestId, runner.id, context.now + LOCK_DURATION_MS, context.now)
  if (!renewed) return vssError(409, 'GitHub.DistributedTask.WebApi.TaskAgentJobTokenExpiredException', 'job request is no longer owned by this runner')
  return json(200, jobRequestJson(renewed, runner))
}

const finish = async (context: Context, job: JobRow, result: TaskResult): Promise<void> => {
  const { db } = context.options
  if (await completeJob(db, job.request_id, conclusionOf(result), context.now)) {
    await revokeJobTokens(db, job.id, context.now)
    const completed = await getJob(db, job.request_id)
    if (completed && context.options.onJobCompleted) await context.options.onJobCompleted(completed)
  }
}

const storeBody = async (context: Context, key: string): Promise<boolean> => {
  const { request, options } = context
  const length = Number(request.headers.get('Content-Length'))
  if (request.body && Number.isSafeInteger(length) && length >= 0 && !request.headers.get('Content-Encoding')) {
    return (await options.storage.put(key, request.body, length, { ifNoneMatch: '*' })).ok
  }
  const bytes = request.body ? await readAll(request.body, MAX_UNSIZED_UPLOAD_BYTES) : new Uint8Array(0)
  return (await options.storage.put(key, bytes, bytes.length, { ifNoneMatch: '*' })).ok
}

export const jobPrefix = (owner: string, repo: string, jobId: string): string => `${repositoryPrefix({ owner, name: repo })}actions/jobs/${jobId}/`

export const logChunkKey = (prefix: string, logId: number, chunk: number): string => `${prefix}logs/${logId}/${String(chunk).padStart(8, '0')}`

export const consolePrefix = (prefix: string): string => `${prefix}console/`

export const consoleKey = (prefix: string, recordId: string, startLine: number): string =>
  `${consolePrefix(prefix)}${recordId.toLowerCase()}/${String(startLine).padStart(10, '0')}`

const appendLog = async (context: Context, { job, prefix }: AuthenticatedJob, logId: number): Promise<Response> => {
  const { db } = context.options
  const log = await getLog(db, logId)
  if (!log || log.job_id !== job.id) return notFound('log')
  for (let chunk = log.chunks; chunk < log.chunks + 100; chunk++) {
    if ((await context.options.storage.head(logChunkKey(prefix, logId, chunk))) !== null) continue
    if (await storeBody(context, logChunkKey(prefix, logId, chunk))) {
      await recordLogChunk(db, logId, chunk)
      return json(200, { id: logId, path: log.path, createdOn: iso(log.created_at), lastChangedOn: iso(context.now) })
    }
    return vssError(409, 'System.InvalidOperationException', 'concurrent log upload, retry')
  }
  return vssError(409, 'System.InvalidOperationException', 'too many concurrent log uploads')
}

const appendConsole = async (context: Context, { prefix }: AuthenticatedJob, recordId: string): Promise<Response> => {
  const body = await readJson<{ value?: unknown; startLine?: number }>(context.request)
  const lines = Array.isArray(body?.value) ? body.value.filter((line): line is string => typeof line === 'string') : []
  const text = new TextEncoder().encode(`${lines.join('\n')}\n`)
  for (let attempt = 0; attempt < 5; attempt++) {
    const start = (typeof body?.startLine === 'number' ? body.startLine : context.now) + attempt * 1_000_000_000
    if ((await context.options.storage.put(consoleKey(prefix, recordId, start), text, text.length, { ifNoneMatch: '*' })).ok) return empty(200)
  }
  return vssError(409, 'System.InvalidOperationException', 'console lines already stored')
}

const jobRoutes = async (context: Context, segments: readonly string[]): Promise<Response | null> => {
  const { db } = context.options
  const method = context.request.method
  const area = segments[2]?.toLowerCase()
  if (!['timeline', 'logfiles', 'timelinewebconsolelog', 'finishjob', 'actiondownloadinfo'].includes(area ?? '')) return null
  const planId = segments[5]
  if (!planId) return notFound()
  const authenticated = await authenticateJob(context, planId)
  if (!authenticated) return unauthorized()
  const { job, prefix } = authenticated
  const tail = segments.slice(6)
  if (area === 'timeline') {
    if (tail.length === 1 && method === 'PATCH') {
      const body = await readJson<{ value?: unknown }>(context.request)
      const records = Array.isArray(body?.value) ? body.value.filter((record): record is { id: string } => typeof (record as { id?: unknown })?.id === 'string') : []
      const merged = await upsertTimelineRecords(db, tail[0]!.toLowerCase(), records)
      return json(200, { count: merged.length, value: merged })
    }
    if (tail[0]?.toLowerCase() === 'timeline') return json(200, { id: tail[1] ?? job.timeline_id, changeId: 1 })
    if (tail.length === 5 && tail[1]?.toLowerCase() === 'attachments' && method === 'PUT') {
      const [timelineId, , recordId, type, name] = tail as [string, string, string, string, string]
      if (!/^[A-Za-z0-9._-]+$/.test(type) || !/^[A-Za-z0-9._-]+$/.test(name)) return vssError(400, 'System.ArgumentException', 'invalid attachment name')
      await storeBody(context, `${prefix}attachments/${recordId.toLowerCase()}/${type}/${name}`)
      return json(200, { timelineId, recordId, type, name })
    }
  }
  if (area === 'logfiles' && method === 'POST') {
    if (tail.length === 0) {
      const body = await readJson<{ path?: string }>(context.request)
      const log = await createLog(db, job.id, String(body?.path ?? 'log'), context.now)
      return json(200, { id: log.id, path: log.path, lineCount: 0, createdOn: iso(log.created_at), lastChangedOn: iso(log.created_at) })
    }
    if (tail.length === 1 && /^\d+$/.test(tail[0]!)) return appendLog(context, authenticated, Number(tail[0]))
  }
  if (area === 'timelinewebconsolelog' && method === 'POST' && tail.length === 2) return appendConsole(context, authenticated, tail[1]!)
  if (area === 'finishjob' && method === 'POST') {
    const event = await readJson<{ name?: string; result?: unknown }>(context.request)
    if (event?.name === 'JobCompleted') await finish(context, job, parseTaskResult(event.result) ?? 'failed')
    return empty(200)
  }
  if (area === 'actiondownloadinfo') {
    return vssError(501, 'GitHub.DistributedTask.WebApi.FailedToResolveActionDownloadInfoException', 'this forge cannot resolve "uses:" actions yet; use run steps')
  }
  return notFound()
}

const base64ToBase64Url = (value: string): string => value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const POOLS = { count: 1, value: [{ id: POOL_ID, name: POOL_NAME, isHosted: false, poolType: 'automation' }] }

type TaskAgentBody = {
  readonly name?: unknown
  readonly ephemeral?: unknown
  readonly labels?: readonly { readonly name?: unknown }[]
  readonly authorization?: { readonly publicKey?: { readonly exponent?: unknown; readonly modulus?: unknown } }
}

const registrationRoutes = async (context: Context, area: string, tail: readonly string[]): Promise<Response | null> => {
  const token = bearer(context.request)
  if (!token) return null
  const grant = await verifyToken(context.options.db, token, 'registration', context.now)
  if (!grant?.owner || !grant.repo) return null
  if (area === 'agentpools') return json(200, POOLS)
  if (tail[0] !== String(POOL_ID)) return notFound('pool')
  const method = context.request.method
  if (method === 'GET' && tail.length === 1) {
    const name = context.url.searchParams.get('agentName') ?? undefined
    const runners = await listRunners(context.options.db, grant.owner, grant.repo, name)
    return json(200, { count: runners.length, value: runners.map(agentJson) })
  }
  if (method !== 'POST' || tail.length !== 1) return vssError(405, 'System.NotSupportedException', 'only adding runners is supported with a registration token')
  const body = await readJson<TaskAgentBody>(context.request)
  const key = body?.authorization?.publicKey
  if (typeof body?.name !== 'string' || typeof key?.exponent !== 'string' || typeof key.modulus !== 'string') {
    return vssError(400, 'System.ArgumentException', 'expected a TaskAgent with name and public key')
  }
  const labels = (body.labels ?? []).flatMap((label) => (typeof label.name === 'string' ? [label.name] : []))
  try {
    const runner = await createRunner(
      context.options.db,
      {
        name: body.name,
        owner: grant.owner,
        repo: grant.repo,
        labels,
        publicKey: { n: base64ToBase64Url(key.modulus), e: base64ToBase64Url(key.exponent) },
        ephemeral: body.ephemeral === true,
      },
      context.now,
    )
    return json(200, { ...agentJson(runner), authorization: { ...agentJson(runner).authorization, authorizationUrl: authorizationUrl(context.serviceUrl) } })
  } catch (error) {
    if (error instanceof RunnerExistsError) return vssError(409, 'GitHub.DistributedTask.WebApi.TaskAgentExistsException', `a runner named ${body.name} already exists`)
    throw error
  }
}

const runnerRoutes = async (context: Context, segments: readonly string[]): Promise<Response | null> => {
  const method = context.request.method
  const area = segments[2]?.toLowerCase()
  if (!['agentpools', 'agent', 'agentsession', 'message', 'agentrequest'].includes(area ?? '')) return null
  const tail = segments.slice(3)
  if (area === 'agentpools' || area === 'agent') {
    const registration = await registrationRoutes(context, area, tail)
    if (registration) return registration
  }
  const runner = await authenticateRunner(context)
  if (!runner) return unauthorized()
  if (area === 'agentpools') return json(200, POOLS)
  if (tail[0] !== String(POOL_ID)) return notFound('pool')
  if (area === 'agent') {
    if (tail.length === 1) return json(200, { count: 1, value: [agentJson(runner)] })
    if (tail[1] !== String(runner.id)) return notFound('agent')
    if (method === 'GET' || method === 'PUT' || method === 'PATCH') return json(200, agentJson(runner))
    return vssError(405, 'System.NotSupportedException', 'runners are removed through the REST API')
  }
  if (area === 'agentsession') {
    if (method === 'POST' && tail.length === 1) return createSessionRoute(context, runner)
    if (method === 'DELETE' && tail.length === 2) {
      await closeSession(context.options.db, tail[1]!, runner.id, context.now)
      if (runner.ephemeral && runner.jobId && (await getJobById(context.options.db, runner.jobId))?.status === 'completed') {
        await removeRunner(context.options.db, runner.id, context.now)
      }
      return empty(204)
    }
  }
  if (area === 'message') {
    if (method === 'GET' && tail.length === 1) return getMessageRoute(context, runner)
    if (method === 'DELETE' && tail.length === 2) return empty(204)
  }
  if (area === 'agentrequest' && tail.length === 2 && /^\d+$/.test(tail[1]!)) return agentRequestRoute(context, runner, Number(tail[1]))
  return notFound()
}

export const handleActionsService = async (request: Request, options: ActionsServiceOptions): Promise<Response | null> => {
  const url = new URL(request.url)
  const base = options.basePath.replace(/\/$/, '')
  if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return null
  const segments = url.pathname.slice(base.length).split('/').filter((segment) => segment !== '')
  if (segments[0]?.toLowerCase() !== '_apis') return notFound()
  const context: Context = {
    options,
    request,
    url,
    now: (options.now ?? Date.now)(),
    serviceUrl: `${options.serverUrl ?? url.origin}${base}`,
    serverUrl: options.serverUrl ?? url.origin,
  }
  if (segments.length === 1 && request.method === 'OPTIONS') return resourceLocations()
  if (route(segments, '_apis/connectionData') && request.method === 'GET') return connectionData(context)
  if (route(segments, '_apis/v1/auth') && request.method === 'POST') return tokenEndpoint(context)
  if (segments[1]?.toLowerCase() !== 'v1') return notFound()
  return (await runnerRoutes(context, segments)) ?? (await jobRoutes(context, segments)) ?? notFound()
}
