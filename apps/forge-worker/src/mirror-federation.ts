import {
  type AccountsStore,
  authorizeSubscription,
  createInstanceVerifier,
  type InstancePrincipal,
  isMirrorOf,
  type JwksSource,
  mintInstanceToken,
  mintMirrorNotification,
  NOTIFICATION_MEDIA_TYPE,
  NOTIFY_PATH_PREFIX,
  parseUpstreamUrl,
  type SigningKey,
  SUBSCRIPTIONS_PATH,
  verifyMirrorNotification,
} from '@git-forge/accounts'
import {
  type AuthorizationSupplier,
  deepCheckMirror,
  type FetchFunction,
  isMirrorDue,
  isValidName,
  type JobQueue,
  type MirrorConfig,
  PermanentJobError,
  type PushOutcome,
  readAll,
  readMirrorConfig,
  readMirrorStatus,
  readRefs,
  refsChecksum,
  type RepositoryName,
  selectUpstreamRefs,
  SizeLimitError,
  type Storage,
  syncMirror,
  type SyncResult,
} from '@git-forge/core'

export type ForgeJob =
  | { readonly kind: 'mirror-sync'; readonly repository: string; readonly remote: string; readonly reason: 'notification' | 'schedule' | 'configure' }
  | { readonly kind: 'mirror-notify'; readonly repository: string; readonly issuer: string; readonly callback: string }
  | { readonly kind: 'mirror-subscribe'; readonly repository: string; readonly remote: string }
  | { readonly kind: 'mirror-deep-check'; readonly repository: string; readonly remote: string }

export type MirrorFederation = {
  readonly storage: Storage
  readonly store: AccountsStore
  readonly issuer: string
  readonly key: SigningKey
  readonly jwks: JwksSource
  readonly jobs: JobQueue<ForgeJob>
  readonly canRead: (principal: InstancePrincipal, repo: RepositoryName) => Promise<boolean>
  readonly fetch?: FetchFunction
  readonly safetySyncHours: number
  readonly deepCheckDays: number
  readonly now?: () => Date
}

export const DEFAULT_SAFETY_SYNC_HOURS = 24

export const DEFAULT_DEEP_CHECK_DAYS = 30

const HOUR = 60 * 60 * 1000

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

export const repositoryOf = (repository: string): RepositoryName => {
  const [owner = '', name = ''] = repository.split('/')
  if (!isValidName(owner) || !isValidName(name)) throw new PermanentJobError(`invalid repository ${repository}`)
  return { owner, name }
}

const nameOf = (repo: RepositoryName): string => `${repo.owner}/${repo.name}`.toLowerCase()

export const notifyCallback = (federation: MirrorFederation, repo: RepositoryName, remote: string): string =>
  `${federation.issuer}${NOTIFY_PATH_PREFIX}${repo.owner}/${repo.name}/${remote}`

const send = (federation: MirrorFederation, request: Request): Promise<Response> => (federation.fetch ?? globalThis.fetch)(request)

export const upstreamAuthorization = (federation: MirrorFederation, config: MirrorConfig): AuthorizationSupplier => {
  const upstream = parseUpstreamUrl(config.url)
  return async () =>
    `Bearer ${await mintInstanceToken({ key: federation.key, issuer: federation.issuer, audience: upstream.issuer, repositories: [upstream.repository] })}`
}

export const enqueueNotifications = async (federation: MirrorFederation, repo: RepositoryName): Promise<number> => {
  const subscriptions = await federation.store.mirrorSubscriptions(nameOf(repo))
  for (const subscription of subscriptions) {
    await federation.jobs.enqueue({ kind: 'mirror-notify', repository: nameOf(repo), issuer: subscription.issuer, callback: subscription.callback })
  }
  return subscriptions.length
}

export const notifyAfterPush =
  (federation: MirrorFederation) =>
  async (repo: RepositoryName, outcome: PushOutcome): Promise<void> => {
    if (!outcome.results.some((result) => result.ok)) return
    try {
      await enqueueNotifications(federation, repo)
    } catch (error) {
      console.log(JSON.stringify({ event: 'mirror-notify-enqueue-failed', repository: nameOf(repo), error: (error as Error).message }))
    }
  }

const deliverNotification = async (federation: MirrorFederation, job: Extract<ForgeJob, { kind: 'mirror-notify' }>): Promise<void> => {
  const subscriptions = await federation.store.mirrorSubscriptions(job.repository)
  if (!subscriptions.some((subscription) => subscription.issuer === job.issuer && subscription.callback === job.callback)) return
  const refs = await readRefs(federation.storage, repositoryOf(job.repository))
  if (!refs) throw new PermanentJobError(`repository ${job.repository} not found`)
  const token = await mintMirrorNotification({
    key: federation.key,
    issuer: federation.issuer,
    audience: job.issuer,
    repository: job.repository,
    refs: refs.state.refs,
  })
  const response = await send(federation, new Request(job.callback, { method: 'POST', headers: { 'Content-Type': NOTIFICATION_MEDIA_TYPE }, body: token }))
  await response.body?.cancel()
  if (response.ok) return
  const message = `notification to ${job.callback} failed with HTTP ${response.status}`
  if (response.status === 404 || response.status === 410) throw new PermanentJobError(message)
  throw new Error(message)
}

export const runMirrorSync = async (federation: MirrorFederation, repo: RepositoryName, remote: string): Promise<SyncResult> => {
  const config = await readMirrorConfig(federation.storage, repo, remote)
  if (!config) throw new PermanentJobError(`mirror ${remote} of ${nameOf(repo)} not configured`)
  const result = await syncMirror({
    storage: federation.storage,
    repo,
    remote,
    strategy: 'copy',
    getAuthorization: upstreamAuthorization(federation, config),
    ...(federation.fetch ? { fetch: federation.fetch } : {}),
    ...(federation.now ? { now: federation.now } : {}),
  })
  if (result.status === 'ok' && result.updates.length > 0) await enqueueNotifications(federation, repo)
  return result
}

const subscribeUpstream = async (federation: MirrorFederation, repo: RepositoryName, remote: string): Promise<void> => {
  const config = await readMirrorConfig(federation.storage, repo, remote)
  if (!config || config.detachedAt) return
  const upstream = parseUpstreamUrl(config.url)
  const token = await mintInstanceToken({ key: federation.key, issuer: federation.issuer, audience: upstream.issuer, repositories: [upstream.repository] })
  const response = await send(
    federation,
    new Request(`${upstream.issuer}${SUBSCRIPTIONS_PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repository: upstream.repository, callback: notifyCallback(federation, repo, remote) }),
    }),
  )
  const detail = (await response.text()).slice(0, 200)
  if (!response.ok) throw new Error(`subscribing at ${upstream.issuer} failed with HTTP ${response.status}: ${detail}`)
}

export const runJob = async (federation: MirrorFederation, job: ForgeJob): Promise<void> => {
  switch (job.kind) {
    case 'mirror-notify':
      return deliverNotification(federation, job)
    case 'mirror-subscribe':
      return subscribeUpstream(federation, repositoryOf(job.repository), job.remote)
    case 'mirror-deep-check': {
      const check = await deepCheckMirror(federation.storage, repositoryOf(job.repository), job.remote, federation.now?.() ?? new Date())
      if (!check.ok) console.log(JSON.stringify({ event: 'mirror-deep-check', repository: job.repository, remote: job.remote, problems: check.problems }))
      return
    }
    case 'mirror-sync': {
      const result = await runMirrorSync(federation, repositoryOf(job.repository), job.remote)
      if (result.status === 'failed') throw new Error(result.error ?? 'mirror sync failed')
    }
  }
}

export const configureMirrorFederation = async (federation: MirrorFederation, repo: RepositoryName, config: MirrorConfig): Promise<void> => {
  parseUpstreamUrl(config.url)
  await federation.store.registerLocalMirror(nameOf(repo), config.remote)
  await federation.jobs.enqueue({ kind: 'mirror-subscribe', repository: nameOf(repo), remote: config.remote })
  await federation.jobs.enqueue({ kind: 'mirror-sync', repository: nameOf(repo), remote: config.remote, reason: 'configure' })
}

export type ScheduledWork = { readonly syncs: number; readonly deepChecks: number }

export const scheduleSafetyNet = async (federation: MirrorFederation, now: Date): Promise<ScheduledWork> => {
  let syncs = 0
  let deepChecks = 0
  for (const { repository, remote } of await federation.store.localMirrors()) {
    const repo = repositoryOf(repository)
    const config = await readMirrorConfig(federation.storage, repo, remote)
    if (!config) continue
    const status = await readMirrorStatus(federation.storage, repo, remote)
    if (isMirrorDue(config, status, now, Math.max(0, federation.safetySyncHours * HOUR - HOUR / 2))) {
      await federation.jobs.enqueue({ kind: 'mirror-subscribe', repository, remote })
      await federation.jobs.enqueue({ kind: 'mirror-sync', repository, remote, reason: 'schedule' })
      syncs++
    }
    const lastCheck = status?.lastDeepCheck ? Date.parse(status.lastDeepCheck.at) : 0
    if (federation.deepCheckDays > 0 && !config.detachedAt && now.getTime() - lastCheck >= federation.deepCheckDays * 24 * HOUR) {
      await federation.jobs.enqueue({ kind: 'mirror-deep-check', repository, remote })
      deepChecks++
    }
  }
  return { syncs, deepChecks }
}

const bearer = (request: Request): string | null => /^\s*Bearer\s+(\S+)\s*$/i.exec(request.headers.get('Authorization') ?? '')?.[1] ?? null

const readText = async (request: Request, limit: number): Promise<string | null> => {
  if (!request.body) return ''
  try {
    return new TextDecoder().decode(await readAll(request.body, limit))
  } catch (error) {
    if (error instanceof SizeLimitError) return null
    throw error
  }
}

const handleSubscription = async (federation: MirrorFederation, request: Request): Promise<Response> => {
  if (request.method !== 'POST' && request.method !== 'DELETE') return json(405, { error: 'method not allowed' })
  const token = bearer(request)
  const verify = createInstanceVerifier({ audience: federation.issuer, trust: federation.store.lookupTrustedIssuer, jwks: federation.jwks })
  const principal = token ? await verify(token) : null
  if (!principal) return json(401, { error: 'a valid instance token of a trusted instance is required' })
  const text = await readText(request, 16 * 1024)
  if (text === null) return json(413, { error: 'request body too large' })
  let body: { repository?: unknown; callback?: unknown }
  try {
    body = JSON.parse(text) as typeof body
  } catch {
    return json(400, { error: 'expected a JSON object' })
  }
  if (typeof body.repository !== 'string' || typeof body.callback !== 'string') return json(400, { error: 'repository and callback are required' })
  const problem = authorizeSubscription(principal, body.repository, body.callback)
  if (problem) return json(403, { error: problem })
  const repo = repositoryOf(body.repository)
  if (!(await readRefs(federation.storage, repo)) || !(await federation.canRead(principal, repo))) return json(404, { error: 'repository not found' })
  const subscription = { issuer: principal.issuer, repository: body.repository, callback: body.callback }
  if (request.method === 'DELETE') {
    return (await federation.store.unsubscribeMirror(subscription, { kind: 'instance', id: principal.issuer }))
      ? new Response(null, { status: 204 })
      : json(404, { error: 'no such subscription' })
  }
  await federation.store.subscribeMirror(subscription, { kind: 'instance', id: principal.issuer })
  return json(201, { ...subscription, repository: body.repository.toLowerCase() })
}

const NOTIFY_ROUTE = /^\/([^/]+)\/([^/]+)\/([^/]+)$/

const handleNotification = async (federation: MirrorFederation, request: Request, path: string): Promise<Response> => {
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' })
  const match = NOTIFY_ROUTE.exec(path)
  const [, owner = '', name = '', remote = ''] = match ?? []
  if (!match || !isValidName(owner) || !isValidName(name) || !isValidName(remote)) return json(404, { error: 'not found' })
  const token = (await readText(request, 256 * 1024))?.trim()
  if (!token) return json(400, { error: 'expected a signed notification' })
  const verified = await verifyMirrorNotification(token, { audience: federation.issuer, trust: federation.store.lookupTrustedIssuer, jwks: federation.jwks })
  if (!verified.ok) return json(401, { error: `notification rejected: ${verified.reason}` })
  const { notification } = verified
  const repo = { owner, name }
  const config = await readMirrorConfig(federation.storage, repo, remote)
  if (!config) return json(404, { error: 'mirror not configured' })
  if (!isMirrorOf(config.url, notification.issuer, notification.repository)) return json(403, { error: 'this mirror does not follow the notifying repository' })
  if (config.detachedAt || config.mode !== 'auto') return json(200, { status: 'ignored', reason: config.detachedAt ? 'detached' : 'manual' })
  if (notification.refs) {
    const announced = selectUpstreamRefs(
      Object.entries(notification.refs).map(([ref, id]) => ({ name: ref, id })),
      config.namespace,
    )
    const status = await readMirrorStatus(federation.storage, repo, remote)
    if (status?.lastRun?.ok && status.upstreamChecksum === refsChecksum(announced.refs)) return json(200, { status: 'up-to-date' })
  }
  await federation.jobs.enqueue({ kind: 'mirror-sync', repository: nameOf(repo), remote, reason: 'notification' })
  return json(202, { status: 'queued' })
}

export const handleFederationRequest = async (federation: MirrorFederation, request: Request): Promise<Response | null> => {
  const { pathname } = new URL(request.url)
  const base = new URL(federation.issuer).pathname.replace(/\/+$/, '')
  if (!pathname.startsWith(base)) return null
  const path = pathname.slice(base.length)
  if (path === SUBSCRIPTIONS_PATH) return handleSubscription(federation, request)
  if (path.startsWith(NOTIFY_PATH_PREFIX)) return handleNotification(federation, request, path.slice(NOTIFY_PATH_PREFIX.length - 1))
  return null
}
