import { applyMigrations, type Database, MIGRATIONS } from '@git-forge/accounts'
import { openSqliteDatabase } from '@git-forge/accounts-node'
import { handleGitRequest, MemoryStorage, type Storage } from '@git-forge/core'
import {
  type ActionSources,
  advanceRun,
  type DispatchOptions,
  handleActionsService,
  handleGhesApi,
  type QueuedRun,
  queueRunsForPush,
  type RunnerLauncher,
  type SecretsKey,
  type SecretsProvider,
  verifyToken,
} from '../src/index.ts'

export const ADMIN_TOKEN = 'admin-secret'

export const REVIEWER_TOKEN = 'reviewer-secret'

export const SERVICE_PATH = '/_services/actions'

export type TestForge = {
  readonly db: Database
  readonly storage: Storage
  readonly runs: QueuedRun[]
  readonly handler: (request: Request) => Promise<Response>
  readonly dispatch: (origin: string) => DispatchOptions
}

export type TestForgeOptions = {
  readonly launcher?: RunnerLauncher
  readonly secrets?: SecretsProvider
  readonly messageWaitMs?: number
  readonly pollIntervalMs?: number
  readonly publicUrl?: () => string
  readonly secretsKey?: SecretsKey
  readonly actionSources?: ActionSources
  readonly now?: () => number
}

const presented = (request: Request): string | null => {
  const header = request.headers.get('Authorization') ?? ''
  if (header.startsWith('Bearer ')) return header.slice(7)
  if (!header.startsWith('Basic ')) return null
  const decoded = atob(header.slice(6))
  return decoded.slice(decoded.indexOf(':') + 1)
}

export const createTestForge = async (options: TestForgeOptions = {}): Promise<TestForge> => {
  const { db } = openSqliteDatabase()
  await applyMigrations(db, MIGRATIONS)
  const storage = new MemoryStorage()
  const runs: QueuedRun[] = []
  const urlsFor = (request: Request) => {
    const origin = options.publicUrl?.() ?? new URL(request.url).origin
    return { serverUrl: origin, serviceUrl: `${origin}${SERVICE_PATH}` }
  }
  const dispatchFor = (urls: { serverUrl: string; serviceUrl: string }): DispatchOptions => ({
    db,
    storage,
    urls,
    ...(options.launcher ? { launcher: options.launcher } : {}),
    ...(options.now ? { now: options.now } : {}),
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
    const service = await handleActionsService(request, {
      db,
      storage,
      basePath: SERVICE_PATH,
      instanceId: '6a0f2b8e-5b5e-4c1a-9d43-0c6f3d8f2a11',
      serverUrl: urls.serverUrl,
      ...(options.now ? { now: options.now } : {}),
      ...(options.secrets ? { secrets: options.secrets } : {}),
      ...(options.secretsKey ? { secretsKey: options.secretsKey } : {}),
      ...(options.actionSources ? { actionSources: options.actionSources } : {}),
      ...(options.messageWaitMs !== undefined ? { messageWaitMs: options.messageWaitMs } : {}),
      ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
      onJobCompleted: async (job) => {
        await advanceRun(dispatch, job)
      },
    })
    if (service) return service
    const api = await handleGhesApi(request, {
      db,
      storage,
      urls,
      authorize: async (incoming) => presented(incoming) === ADMIN_TOKEN,
      authorizeRead: readable,
      authorizeWrite: async (incoming) => presented(incoming) === ADMIN_TOKEN,
      actor: async (incoming) => (presented(incoming) === ADMIN_TOKEN ? 'admin' : presented(incoming) === REVIEWER_TOKEN ? 'reviewer' : null),
      ...(options.secretsKey ? { secretsKey: options.secretsKey } : {}),
      ...(options.launcher ? { launcher: options.launcher } : {}),
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
  return { db, storage, runs, handler, dispatch: (origin) => dispatchFor({ serverUrl: origin, serviceUrl: `${origin}${SERVICE_PATH}` }) }
}
