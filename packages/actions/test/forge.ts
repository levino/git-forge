import { applyMigrations, type Database, MIGRATIONS } from '@git-forge/accounts'
import { openSqliteDatabase } from '@git-forge/accounts-node'
import { handleGitRequest, MemoryStorage, type Storage } from '@git-forge/core'
import {
  type ActionSources,
  advanceRun,
  type CheckRunReport,
  type CheckRunSink,
  type DispatchOptions,
  handleActionsService,
  handleGhesApi,
  handleResultsService,
  type IdTokenKey,
  type JobEventSink,
  type QueuedRun,
  queueRunsForPush,
  type RunnerLauncher,
  type SecretsKey,
  type SecretsProvider,
  verifyToken,
} from '../src/index.ts'

export const ADMIN_TOKEN = 'admin-secret'

export const REVIEWER_TOKEN = 'reviewer-secret'

export type RecordedCheck = CheckRunReport & { readonly id: number; readonly repo: string }

export const memoryChecks = (): CheckRunSink & { readonly runs: RecordedCheck[] } => {
  const runs: RecordedCheck[] = []
  return {
    runs,
    create: async (repo, check) => {
      runs.push({ ...check, id: runs.length + 1, repo: `${repo.owner}/${repo.name}` })
      return runs.length
    },
    update: async (repo, id, check) => {
      runs[id - 1] = { ...check, id, repo: `${repo.owner}/${repo.name}` }
    },
  }
}

export const SERVICE_PATH = '/_services/actions'

export type TestForge = {
  readonly db: Database
  readonly storage: Storage
  readonly runs: QueuedRun[]
  readonly handler: (request: Request) => Promise<Response>
  readonly dispatch: (origin: string) => DispatchOptions
  readonly checks: RecordedCheck[]
}

export type TestForgeOptions = {
  readonly launcher?: RunnerLauncher
  readonly secrets?: SecretsProvider
  readonly messageWaitMs?: number
  readonly pollIntervalMs?: number
  readonly publicUrl?: (request: Request) => string | undefined
  readonly secretsKey?: SecretsKey
  readonly actionSources?: ActionSources
  readonly now?: () => number
  readonly idTokenKeys?: readonly IdTokenKey[]
  readonly results?: boolean
  readonly onJobEvent?: JobEventSink
}

const presented = (request: Request): string | null => {
  const [scheme, value] = (request.headers.get('Authorization') ?? '').trim().split(/\s+/, 2) as [string, string | undefined]
  if (!value) return null
  if (scheme.toLowerCase() === 'bearer' || scheme.toLowerCase() === 'token') return value
  if (scheme.toLowerCase() !== 'basic') return null
  const decoded = atob(value)
  return decoded.slice(decoded.indexOf(':') + 1)
}

export const createTestForge = async (options: TestForgeOptions = {}): Promise<TestForge> => {
  const { db } = openSqliteDatabase()
  await applyMigrations(db, MIGRATIONS)
  const storage = new MemoryStorage()
  const runs: QueuedRun[] = []
  const checks = memoryChecks()
  const urlsFor = (request: Request) => {
    const origin = options.publicUrl?.(request) ?? new URL(request.url).origin
    return { serverUrl: origin, serviceUrl: `${origin}${SERVICE_PATH}` }
  }
  const dispatchFor = (urls: { serverUrl: string; serviceUrl: string }): DispatchOptions => ({
    db,
    storage,
    urls,
    checks,
    ...(options.launcher ? { launcher: options.launcher } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.onJobEvent ? { onJobEvent: options.onJobEvent } : {}),
  })
  const readable = async (incoming: Request, owner: string, name: string): Promise<boolean> => {
    const token = presented(incoming)
    if (token === ADMIN_TOKEN || token === REVIEWER_TOKEN) return true
    const grant = token ? await verifyToken(db, token, 'github', Date.now()) : null
    return grant !== null && grant.owner === owner && grant.repo === name
  }
  const handler = async (request: Request): Promise<Response> => {
    const urls = urlsFor(request)
    const dispatch = dispatchFor(urls)
    if (options.results !== false) {
      const results = await handleResultsService(request, {
        db,
        storage,
        serverUrl: urls.serverUrl,
        ...(options.idTokenKeys ? { idTokenKeys: options.idTokenKeys } : {}),
        repositoryFacts: async (owner, repo) => ({ id: `${owner}/${repo}`, ownerId: owner, visibility: 'private' }),
        ...(options.now ? { now: options.now } : {}),
      })
      if (results) return results
    }
    const service = await handleActionsService(request, {
      db,
      storage,
      basePath: SERVICE_PATH,
      instanceId: '6a0f2b8e-5b5e-4c1a-9d43-0c6f3d8f2a11',
      serverUrl: urls.serverUrl,
      checks,
      ...(options.now ? { now: options.now } : {}),
      ...(options.secrets ? { secrets: options.secrets } : {}),
      ...(options.secretsKey ? { secretsKey: options.secretsKey } : {}),
      ...(options.actionSources ? { actionSources: options.actionSources } : {}),
      ...(options.messageWaitMs !== undefined ? { messageWaitMs: options.messageWaitMs } : {}),
      ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
      onJobCompleted: async (job) => {
        await advanceRun(dispatch, job)
      },
      ...(options.onJobEvent ? { onJobEvent: options.onJobEvent } : {}),
      ...(options.results !== false ? { results: { idTokens: (options.idTokenKeys?.length ?? 0) > 0 } } : {}),
    })
    if (service) return service
    const api = await handleGhesApi(request, {
      db,
      storage,
      urls,
      authorize: async (incoming) => presented(incoming) === ADMIN_TOKEN,
      authorizeRead: readable,
      authorizeWrite: async (incoming) => presented(incoming) === ADMIN_TOKEN,
      authorizeOrganization: async (incoming) => presented(incoming) === ADMIN_TOKEN,
      actor: async (incoming) => (presented(incoming) === ADMIN_TOKEN ? 'admin' : presented(incoming) === REVIEWER_TOKEN ? 'reviewer' : null),
      ...(options.secretsKey ? { secretsKey: options.secretsKey } : {}),
      ...(options.launcher ? { launcher: options.launcher } : {}),
      checks,
      ...(options.now ? { now: options.now } : {}),
    })
    if (api) return api
    const git = await handleGitRequest(request, {
      storage,
      authorize: async (incoming, repo, access) => {
        const token = presented(incoming)
        if (token === ADMIN_TOKEN) return null
        const grant = token ? await verifyToken(db, token, 'github', Date.now()) : null
        if (access === 'read' && grant && grant.owner === repo.owner && grant.repo === repo.name) return null
        return new Response('authentication required\n', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="git-forge"' } })
      },
      onPush: async (repo, outcome) => {
        runs.push(...(await queueRunsForPush(dispatch, { repo, outcome, actor: 'admin' })))
      },
    })
    return git ?? new Response('not found', { status: 404 })
  }
  return { db, storage, runs, handler, checks: checks.runs, dispatch: (origin) => dispatchFor({ serverUrl: origin, serviceUrl: `${origin}${SERVICE_PATH}` }) }
}
