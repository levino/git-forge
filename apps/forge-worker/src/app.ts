import { applyMigrations, type Database } from '@git-forge/accounts'
import {
  ACTIONS_MIGRATIONS,
  advanceRun,
  type DispatchOptions,
  handleActionsService,
  handleGhesApi,
  queueRunsForPush,
  type RunnerLauncher,
  type SecretsProvider,
  verifyToken,
} from '@git-forge/actions'
import {
  type Authorize,
  createRepository,
  handleGitRequest,
  isValidName,
  RepositoryExistsError,
  type Storage,
} from '@git-forge/core'

export type ActionsConfig = {
  readonly db: Database
  readonly instanceId: string
  readonly launcher?: RunnerLauncher
  readonly secrets?: SecretsProvider
  readonly publicUrl?: string
}

export type ForgeConfig = {
  readonly storage: Storage
  readonly adminToken: string | undefined
  readonly publicRead: boolean
  readonly maxPushBytes: number
  readonly actions?: ActionsConfig
}

export const ACTIONS_SERVICE_PATH = '/_services/actions'

export const ACTIONS_MIGRATIONS_TABLE = 'actions_migrations'

const migrated = new WeakMap<Database, Promise<unknown>>()

const ensureMigrated = (db: Database): Promise<unknown> => {
  let pending = migrated.get(db)
  if (!pending) {
    pending = applyMigrations(db, ACTIONS_MIGRATIONS, Date.now(), ACTIONS_MIGRATIONS_TABLE).catch((error: unknown) => {
      migrated.delete(db)
      throw error
    })
    migrated.set(db, pending)
  }
  return pending
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

const digest = async (value: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))

export const tokenMatches = async (presented: string, expected: string | undefined): Promise<boolean> => {
  if (!expected) return false
  const [a, b] = await Promise.all([digest(presented), digest(expected)])
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!
  return difference === 0
}

export const presentedToken = (request: Request): string | null => {
  const header = request.headers.get('Authorization') ?? ''
  const [scheme, value] = header.split(' ', 2) as [string, string | undefined]
  if (!value) return null
  if (scheme.toLowerCase() === 'bearer') return value
  if (scheme.toLowerCase() !== 'basic') return null
  try {
    const decoded = atob(value)
    const colon = decoded.indexOf(':')
    return colon === -1 ? null : decoded.slice(colon + 1)
  } catch {
    return null
  }
}

const unauthorized = () =>
  new Response('authentication required\n', {
    status: 401,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'WWW-Authenticate': 'Basic realm="git-forge", charset="UTF-8"' },
  })

const isAdmin = async (request: Request, config: ForgeConfig): Promise<boolean> => {
  const token = presentedToken(request)
  return token !== null && (await tokenMatches(token, config.adminToken))
}

const jobTokenGrantsRead = async (request: Request, config: ForgeConfig, owner: string, name: string): Promise<boolean> => {
  const token = presentedToken(request)
  if (!config.actions || !token) return false
  await ensureMigrated(config.actions.db)
  const grant = await verifyToken(config.actions.db, token, 'github', Date.now())
  return grant !== null && grant.owner === owner && grant.repo === name
}

const authorizer =
  (config: ForgeConfig): Authorize =>
  async (request, repo, access) =>
    (access === 'read' && config.publicRead) ||
    (await isAdmin(request, config)) ||
    (access === 'read' && (await jobTokenGrantsRead(request, config, repo.owner, repo.name)))
      ? null
      : unauthorized()

const dispatchOptions = (request: Request, config: ForgeConfig, actions: ActionsConfig): DispatchOptions => {
  const serverUrl = actions.publicUrl ?? new URL(request.url).origin
  return {
    db: actions.db,
    storage: config.storage,
    urls: { serverUrl, serviceUrl: `${serverUrl}${ACTIONS_SERVICE_PATH}` },
    ...(actions.launcher ? { launcher: actions.launcher } : {}),
    log: (event) => console.log(JSON.stringify(event)),
  }
}

const actionsRoute = async (request: Request, config: ForgeConfig): Promise<Response | null> => {
  const { actions } = config
  const { pathname } = new URL(request.url)
  if (!actions || !(pathname.startsWith(`${ACTIONS_SERVICE_PATH}/`) || pathname === '/api/v3' || pathname.startsWith('/api/v3/'))) return null
  await ensureMigrated(actions.db)
  const dispatch = dispatchOptions(request, config, actions)
  return (
    (await handleActionsService(request, {
      db: actions.db,
      storage: config.storage,
      basePath: ACTIONS_SERVICE_PATH,
      instanceId: actions.instanceId,
      serverUrl: dispatch.urls.serverUrl,
      ...(actions.secrets ? { secrets: actions.secrets } : {}),
      onJobCompleted: async (job) => {
        await advanceRun(dispatch, job)
      },
    })) ??
    (await handleGhesApi(request, { db: actions.db, storage: config.storage, urls: dispatch.urls, authorize: (incoming) => isAdmin(incoming, config) }))
  )
}

type CreateRepositoryBody = { owner?: unknown; name?: unknown; defaultBranch?: unknown }

const createRepositoryRoute = async (request: Request, config: ForgeConfig): Promise<Response> => {
  if (!config.adminToken) return json(503, { error: 'ADMIN_TOKEN is not configured' })
  if (!(await isAdmin(request, config))) return json(401, { error: 'invalid admin token' }, { 'WWW-Authenticate': 'Bearer' })
  let body: CreateRepositoryBody
  try {
    body = (await request.json()) as CreateRepositoryBody
  } catch {
    return json(400, { error: 'expected a JSON body' })
  }
  const { owner, name } = body
  const defaultBranch = body.defaultBranch ?? 'main'
  if (typeof owner !== 'string' || typeof name !== 'string' || !isValidName(owner) || !isValidName(name)) {
    return json(400, { error: 'owner and name must match [A-Za-z0-9][A-Za-z0-9._-]* and must not end in .git' })
  }
  if (typeof defaultBranch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(defaultBranch) || defaultBranch.includes('..')) {
    return json(400, { error: 'invalid defaultBranch' })
  }
  try {
    await createRepository(config.storage, { owner, name }, defaultBranch)
  } catch (error) {
    if (error instanceof RepositoryExistsError) return json(409, { error: `${owner}/${name} already exists` })
    throw error
  }
  const cloneUrl = new URL(`/${owner}/${name}.git`, request.url).toString()
  return json(201, { owner, name, defaultBranch, cloneUrl })
}

export const handleRequest = async (request: Request, config: ForgeConfig): Promise<Response> => {
  const url = new URL(request.url)
  if (url.pathname === '/api/admin/repos') {
    if (request.method !== 'POST') return json(405, { error: 'method not allowed' }, { Allow: 'POST' })
    return createRepositoryRoute(request, config)
  }
  if (url.pathname === '/' || url.pathname === '/api/health') return json(200, { ok: true, service: 'git-forge' })
  const actions = await actionsRoute(request, config)
  if (actions) return actions
  const git = await handleGitRequest(request, {
    storage: config.storage,
    authorize: authorizer(config),
    maxRequestBytes: config.maxPushBytes,
    ...(config.actions
      ? {
          onPush: async (repo, outcome) => {
            const { actions: actionsConfig } = config
            if (!actionsConfig) return
            await ensureMigrated(actionsConfig.db)
            await queueRunsForPush(dispatchOptions(request, config, actionsConfig), { repo, outcome, actor: 'admin' })
          },
        }
      : {}),
  })
  return git ?? json(404, { error: 'not found' })
}
