import { checkRepositoryAccess, type Principal, type RepositoryDirectory, type UserPrincipal } from '@git-forge/accounts'
import { isEmailAddress, isValidName } from '@git-forge/core'
import { apiUrl, isWebhookEventName } from './events.ts'
import type { Notifications } from './hub.ts'
import { EMAIL_MODES, type DeliveryRow, type EmailMode, type HookInput, type HookRow, type HookScope, type NotificationSettings, type RepositoryRow, type ThreadRow } from './store.ts'
import { hookConfig, hookEvents, hookObject, validateWebhookUrl } from './webhooks.ts'

export type NotificationsHttpOptions = {
  readonly notifications: Notifications
  readonly directory: RepositoryDirectory
  readonly authenticate: (request: Request) => Promise<Principal | null>
  readonly isInstanceAdmin: (userId: string) => Promise<boolean>
  readonly baseUrl: (request: Request) => string
  readonly allowInsecureWebhooks?: boolean
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message)
  }
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } })

export const empty = (status: number): Response => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } })

export const readJson = async (request: Request, limit = 256 * 1024): Promise<Record<string, unknown>> => {
  const text = await request.text()
  if (text.length > limit) throw new ApiError(413, 'request body too large')
  if (text.trim() === '') return {}
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {}
  throw new ApiError(400, 'Problems parsing JSON')
}

export const pagination = (url: URL, defaultSize = 30) => {
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? defaultSize) || defaultSize))
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1)
  return { perPage, page, offset: (page - 1) * perPage }
}

export const linkHeader = (url: URL, page: number, hasNext: boolean): Record<string, string> => {
  const links: string[] = []
  const at = (number: number) => {
    const next = new URL(url)
    next.searchParams.set('page', String(number))
    return next.toString()
  }
  if (hasNext) links.push(`<${at(page + 1)}>; rel="next"`)
  if (page > 1) links.push(`<${at(page - 1)}>; rel="prev"`, `<${at(1)}>; rel="first"`)
  return links.length > 0 ? { Link: links.join(', ') } : {}
}

const timestamp = (value: unknown, key: string): number | undefined => {
  if (value === undefined || value === null) return undefined
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN
  if (Number.isNaN(parsed)) throw new ApiError(422, `${key} must be an ISO 8601 timestamp`)
  return parsed
}

const bool = (value: unknown, key: string): boolean | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 'false') return value === 'true'
  throw new ApiError(422, `${key} must be a boolean`)
}

const iso = (value: number | null): string | null => (value === null ? null : new Date(value).toISOString())

const SEGMENT = '([^/]+)'

export const handleNotificationsRequest = async (request: Request, options: NotificationsHttpOptions): Promise<Response | null> => {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, '')
  if (!path.startsWith('/api/v3/')) return null
  const route = matchRoute(request.method, path.slice('/api/v3'.length))
  if (!route) return null
  try {
    return await route(request, url, options)
  } catch (error) {
    if (error instanceof ApiError) return json(error.status, { message: error.message, documentation_url: 'https://docs.github.com/rest' }, error.headers)
    throw error
  }
}

type Handler = (request: Request, url: URL, options: NotificationsHttpOptions, params: string[]) => Promise<Response>

type Route = { readonly pattern: RegExp; readonly methods: Readonly<Record<string, Handler>> }

const requireUser = async (request: Request, options: NotificationsHttpOptions): Promise<UserPrincipal> => {
  const principal = await options.authenticate(request)
  if (!principal) throw new ApiError(401, 'Bad credentials', { 'WWW-Authenticate': 'Bearer' })
  if (principal.kind === 'anonymous') throw new ApiError(401, 'Requires authentication', { 'WWW-Authenticate': 'Bearer' })
  if (principal.kind !== 'user') throw new ApiError(403, 'This endpoint needs a user token')
  return principal
}

const canManage = (principal: UserPrincipal): boolean => principal.limits === null || principal.limits.ceiling === 'admin'

const readableRepository = async (request: Request, options: NotificationsHttpOptions, params: string[]): Promise<{ user: UserPrincipal; repository: RepositoryRow }> => {
  const user = await requireUser(request, options)
  const [owner = '', name = ''] = params
  if (!isValidName(owner) || !isValidName(name)) throw new ApiError(404, 'Not Found')
  const check = await checkRepositoryAccess(options.directory, user, { owner, name }, 'read')
  const repository = check.decision === 'allow' ? await options.notifications.store.repositoryByName(owner, name) : null
  if (!repository) throw new ApiError(404, 'Not Found')
  return { user, repository }
}

type HookTarget = { readonly scope: HookScope; readonly scopePath: string; readonly user: UserPrincipal }

const hookTarget = async (request: Request, options: NotificationsHttpOptions, params: string[], kind: 'repository' | 'organization'): Promise<HookTarget> => {
  const user = await requireUser(request, options)
  const instanceAdmin = canManage(user) && (await options.isInstanceAdmin(user.id))
  if (kind === 'repository') {
    const [owner = '', name = ''] = params
    if (!isValidName(owner) || !isValidName(name)) throw new ApiError(404, 'Not Found')
    const check = await checkRepositoryAccess(options.directory, user, { owner, name }, 'admin')
    const repository = await options.notifications.store.repositoryByName(owner, name)
    if (!repository || (check.decision !== 'allow' && !instanceAdmin)) {
      throw new ApiError(check.decision === 'forbidden' ? 403 : 404, check.decision === 'forbidden' ? 'Must have admin rights to Repository.' : 'Not Found')
    }
    return { scope: { kind: 'repository', id: repository.id }, scopePath: `/repos/${repository.owner_login}/${repository.name}`, user }
  }
  const [login = ''] = params
  const rows = await options.notifications.store.db.all<{ id: string; login: string }>({
    sql: "SELECT id, login FROM accounts WHERE kind = 'organization' AND login = ?",
    params: [login],
  })
  const organization = rows[0]
  if (!organization) throw new ApiError(404, 'Not Found')
  const owner = canManage(user) && (await options.notifications.store.organizationRole(organization.id, user.id)) === 'owner'
  if (!owner && !instanceAdmin) throw new ApiError(404, 'Not Found')
  return { scope: { kind: 'organization', id: organization.id }, scopePath: `/orgs/${organization.login}`, user }
}

const threadJson = (baseUrl: string, thread: ThreadRow) => {
  const full = `${thread.owner_login}/${thread.repository_name}`
  return {
    id: String(thread.id),
    unread: thread.unread === 1,
    reason: thread.reason,
    updated_at: iso(thread.updated_at),
    last_read_at: iso(thread.last_read_at),
    subject: { title: thread.subject_title, url: thread.subject_url, latest_comment_url: thread.latest_comment_url, type: thread.subject_type, html_url: thread.html_url },
    repository: {
      id: thread.repository_id,
      name: thread.repository_name,
      full_name: full,
      owner: { login: thread.owner_login },
      html_url: `${baseUrl}/${full}`,
      url: apiUrl(baseUrl, `/repos/${full}`),
    },
    url: apiUrl(baseUrl, `/notifications/threads/${thread.id}`),
    subscription_url: apiUrl(baseUrl, `/notifications/threads/${thread.id}/subscription`),
  }
}

const listThreads = async (request: Request, url: URL, options: NotificationsHttpOptions, user: UserPrincipal, repository?: RepositoryRow): Promise<Response> => {
  const { perPage, page, offset } = pagination(url, 50)
  const since = timestamp(url.searchParams.get('since') ?? undefined, 'since')
  const before = timestamp(url.searchParams.get('before') ?? undefined, 'before')
  const rows = await options.notifications.store.threads(user.id, {
    all: bool(url.searchParams.get('all') ?? undefined, 'all') ?? false,
    participating: bool(url.searchParams.get('participating') ?? undefined, 'participating') ?? false,
    ...(repository ? { repositoryId: repository.id } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(before !== undefined ? { before } : {}),
    limit: perPage + 1,
    offset,
  })
  const visible: ThreadRow[] = []
  const access = new Map<string, boolean>()
  for (const row of rows.slice(0, perPage)) {
    if (!access.has(row.repository_id)) {
      access.set(row.repository_id, (await checkRepositoryAccess(options.directory, user, { owner: row.owner_login, name: row.repository_name }, 'read')).decision === 'allow')
    }
    if (access.get(row.repository_id)) visible.push(row)
  }
  const baseUrl = options.baseUrl(request)
  return json(200, visible.map((row) => threadJson(baseUrl, row)), linkHeader(url, page, rows.length > perPage))
}

const markRead = async (request: Request, options: NotificationsHttpOptions, user: UserPrincipal, repository?: RepositoryRow): Promise<Response> => {
  const body = await readJson(request)
  const lastReadAt = timestamp(body.last_read_at, 'last_read_at') ?? Date.now()
  if (bool(body.read, 'read') === false) return empty(205)
  await options.notifications.store.markAllRead(user.id, lastReadAt, repository?.id)
  return json(202, { message: 'Notifications marked as read.' })
}

const threadOf = async (request: Request, options: NotificationsHttpOptions, params: string[]) => {
  const user = await requireUser(request, options)
  const id = Number(params[0])
  const thread = Number.isSafeInteger(id) ? await options.notifications.store.thread(user.id, id) : null
  if (!thread) throw new ApiError(404, 'Not Found')
  return { user, thread }
}

const watchJson = (baseUrl: string, repository: RepositoryRow, watch: { level: string; createdAt: number } | null) => ({
  subscribed: watch?.level === 'all' || watch?.level === 'releases',
  ignored: watch?.level === 'ignore',
  level: watch?.level ?? 'participating',
  reason: null,
  created_at: iso(watch?.createdAt ?? null),
  url: apiUrl(baseUrl, `/repos/${repository.owner_login}/${repository.name}/subscription`),
  repository_url: apiUrl(baseUrl, `/repos/${repository.owner_login}/${repository.name}`),
})

const settingsJson = (settings: NotificationSettings) => ({
  email: settings.emailMode,
  email_participating: settings.emailParticipating,
  email_watching: settings.emailWatching,
  own_activity: settings.ownActivity,
  email_address: settings.emailAddress,
})

export const parseHookInput = (body: Record<string, unknown>, existing: HookRow | null, options: { readonly allowInsecureWebhooks?: boolean }): HookInput => {
  const config = body.config === undefined ? {} : body.config
  if (typeof config !== 'object' || config === null || Array.isArray(config)) throw new ApiError(422, 'config must be an object')
  const values = config as Record<string, unknown>
  const urlValue = values.url ?? existing?.url
  if (typeof urlValue !== 'string') throw new ApiError(422, 'config.url is required')
  const invalid = validateWebhookUrl(urlValue, { allowInsecure: options.allowInsecureWebhooks ?? false })
  if (invalid) throw new ApiError(422, `config.url: ${invalid}`)
  const contentType = values.content_type ?? existing?.content_type ?? 'form'
  if (contentType !== 'json' && contentType !== 'form') throw new ApiError(422, 'config.content_type must be json or form')
  const secret = values.secret === undefined ? (existing ? undefined : null) : values.secret === null || values.secret === '' ? null : values.secret
  if (secret !== null && secret !== undefined && typeof secret !== 'string') throw new ApiError(422, 'config.secret must be a string')
  const insecure = values.insecure_ssl ?? (existing ? String(existing.insecure_ssl) : '0')
  if (insecure !== '0' && insecure !== '1' && insecure !== 0 && insecure !== 1) throw new ApiError(422, 'config.insecure_ssl must be "0" or "1"')
  const requested: unknown = body.events ?? (existing ? hookEvents(existing) : ['push'])
  if (!Array.isArray(requested) || requested.length === 0) throw new ApiError(422, 'events must be a non-empty list')
  let events: unknown[] = requested
  if (Array.isArray(body.add_events)) events = [...events, ...body.add_events]
  if (Array.isArray(body.remove_events)) events = events.filter((name) => !(body.remove_events as unknown[]).includes(name))
  for (const name of events) if (name !== '*' && !isWebhookEventName(name)) throw new ApiError(422, `unknown event ${String(name)}`)
  const active = bool(body.active, 'active') ?? (existing ? existing.active === 1 : true)
  return { url: urlValue, contentType, secret, insecureSsl: String(insecure) === '1', events: [...new Set(events as string[])], active }
}

const installationOf = (row: DeliveryRow): number | null => {
  try {
    return (JSON.parse(row.payload) as { installation?: { id?: number } }).installation?.id ?? null
  } catch {
    return null
  }
}

const deliveryStatus = (row: DeliveryRow): string => {
  if (row.status === 'pending') return row.attempts === 0 ? 'pending' : `retrying: ${row.error ?? 'failed'}`
  if (row.status === 'delivered') return 'OK'
  return row.status_code ? `Invalid HTTP Response: ${row.status_code}` : (row.error ?? 'failed')
}

export const deliveryJson = (row: DeliveryRow) => ({
  id: row.id,
  guid: row.guid,
  delivered_at: iso(row.delivered_at ?? row.created_at),
  redelivery: row.redelivery === 1,
  duration: row.duration_ms === null ? 0 : row.duration_ms / 1000,
  status: deliveryStatus(row),
  status_code: row.status_code ?? 0,
  event: row.event,
  action: row.action,
  installation_id: installationOf(row),
  repository_id: row.repository_id,
  attempts: row.attempts,
  state: row.status,
})

const hookOf = async (target: HookTarget, options: NotificationsHttpOptions, id: string | undefined): Promise<HookRow> => {
  const number = Number(id)
  const hook = Number.isSafeInteger(number) ? await options.notifications.store.hook(target.scope, number) : null
  if (!hook) throw new ApiError(404, 'Not Found')
  return hook
}

const hookRoutes = (kind: 'repository' | 'organization', prefix: string): Route[] => {
  const target = (request: Request, options: NotificationsHttpOptions, params: string[]) => hookTarget(request, options, params, kind)
  const count = kind === 'repository' ? 2 : 1
  const hookParam = (params: string[]) => params[count]
  return [
    {
      pattern: new RegExp(`^${prefix}/hooks$`),
      methods: {
        GET: async (request, _url, options, params) => {
          const t = await target(request, options, params)
          const hooks = await options.notifications.store.listHooks(t.scope)
          return json(200, hooks.map((hook) => hookObject(options.baseUrl(request), hook, t.scopePath)))
        },
        POST: async (request, _url, options, params) => {
          const t = await target(request, options, params)
          const body = await readJson(request)
          if (body.name !== undefined && body.name !== 'web') throw new ApiError(422, 'name must be web')
          const hook = await options.notifications.store.createHook(t.scope, parseHookInput(body, null, options), t.user.id)
          const baseUrl = options.baseUrl(request)
          await options.notifications.ping(hook, baseUrl, t.user, t.scopePath)
          return json(201, hookObject(baseUrl, hook, t.scopePath))
        },
      },
    },
    {
      pattern: new RegExp(`^${prefix}/hooks/${SEGMENT}$`),
      methods: {
        GET: async (request, _url, options, params) => {
          const t = await target(request, options, params)
          return json(200, hookObject(options.baseUrl(request), await hookOf(t, options, hookParam(params)), t.scopePath))
        },
        PATCH: async (request, _url, options, params) => {
          const t = await target(request, options, params)
          const hook = await hookOf(t, options, hookParam(params))
          await options.notifications.store.updateHook(hook.id, parseHookInput(await readJson(request), hook, options))
          return json(200, hookObject(options.baseUrl(request), (await options.notifications.store.hookById(hook.id))!, t.scopePath))
        },
        DELETE: async (request, _url, options, params) => {
          const t = await target(request, options, params)
          const hook = await hookOf(t, options, hookParam(params))
          await options.notifications.store.deleteHook(hook.id)
          return empty(204)
        },
      },
    },
    {
      pattern: new RegExp(`^${prefix}/hooks/${SEGMENT}/config$`),
      methods: {
        GET: async (request, _url, options, params) => json(200, hookConfig(await hookOf(await target(request, options, params), options, hookParam(params)))),
        PATCH: async (request, _url, options, params) => {
          const t = await target(request, options, params)
          const hook = await hookOf(t, options, hookParam(params))
          await options.notifications.store.updateHook(hook.id, parseHookInput({ config: await readJson(request) }, hook, options))
          return json(200, hookConfig((await options.notifications.store.hookById(hook.id))!))
        },
      },
    },
    {
      pattern: new RegExp(`^${prefix}/hooks/${SEGMENT}/pings$`),
      methods: {
        POST: async (request, _url, options, params) => {
          const t = await target(request, options, params)
          await options.notifications.ping(await hookOf(t, options, hookParam(params)), options.baseUrl(request), t.user, t.scopePath)
          return empty(204)
        },
      },
    },
    ...(kind === 'repository'
      ? [
          {
            pattern: new RegExp(`^${prefix}/hooks/${SEGMENT}/tests$`),
            methods: {
              POST: async (request: Request, _url: URL, options: NotificationsHttpOptions, params: string[]) => {
                await options.notifications.test(await hookOf(await target(request, options, params), options, hookParam(params)))
                return empty(204)
              },
            },
          },
        ]
      : []),
    {
      pattern: new RegExp(`^${prefix}/hooks/${SEGMENT}/deliveries$`),
      methods: {
        GET: async (request, url, options, params) => {
          const t = await target(request, options, params)
          const hook = await hookOf(t, options, hookParam(params))
          const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? 30) || 30))
          const cursor = url.searchParams.get('cursor')
          const rows = await options.notifications.store.deliveriesFor(hook.id, perPage + 1, cursor ? Number(cursor) : undefined)
          const page = rows.slice(0, perPage)
          const headers: Record<string, string> = {}
          if (rows.length > perPage) {
            const next = new URL(url)
            next.searchParams.set('cursor', String(page[page.length - 1]!.id))
            headers.Link = `<${next.toString()}>; rel="next"`
          }
          return json(200, page.map(deliveryJson), headers)
        },
      },
    },
    {
      pattern: new RegExp(`^${prefix}/hooks/${SEGMENT}/deliveries/${SEGMENT}$`),
      methods: {
        GET: async (request, _url, options, params) => {
          const t = await target(request, options, params)
          const hook = await hookOf(t, options, hookParam(params))
          const row = await options.notifications.store.delivery(Number(params[count + 1]))
          if (!row || row.hook_id !== hook.id) throw new ApiError(404, 'Not Found')
          return json(200, {
            ...deliveryJson(row),
            url: row.url,
            error: row.error,
            request: { headers: row.request_headers ? JSON.parse(row.request_headers) : null, payload: JSON.parse(row.payload) },
            response: { headers: row.response_headers ? JSON.parse(row.response_headers) : null, payload: row.response_body },
          })
        },
      },
    },
    {
      pattern: new RegExp(`^${prefix}/hooks/${SEGMENT}/deliveries/${SEGMENT}/attempts$`),
      methods: {
        POST: async (request, _url, options, params) => {
          const t = await target(request, options, params)
          const hook = await hookOf(t, options, hookParam(params))
          const row = await options.notifications.store.delivery(Number(params[count + 1]))
          if (!row || row.hook_id !== hook.id) throw new ApiError(404, 'Not Found')
          const id = await options.notifications.redeliver(row.id)
          return json(202, { id })
        },
      },
    },
  ]
}

const ROUTES: Route[] = [
  {
    pattern: /^\/notifications$/,
    methods: {
      GET: async (request, url, options) => listThreads(request, url, options, await requireUser(request, options)),
      PUT: async (request, _url, options) => markRead(request, options, await requireUser(request, options)),
    },
  },
  {
    pattern: /^\/notifications\/threads\/(\d+)$/,
    methods: {
      GET: async (request, _url, options, params) => {
        const { thread } = await threadOf(request, options, params)
        return json(200, threadJson(options.baseUrl(request), thread))
      },
      PATCH: async (request, _url, options, params) => {
        const { user, thread } = await threadOf(request, options, params)
        await options.notifications.store.markThreadRead(user.id, thread.id)
        return empty(205)
      },
      DELETE: async (request, _url, options, params) => {
        const { user, thread } = await threadOf(request, options, params)
        await options.notifications.store.markThreadDone(user.id, thread.id)
        return empty(204)
      },
    },
  },
  {
    pattern: /^\/notifications\/threads\/(\d+)\/subscription$/,
    methods: {
      GET: async (request, _url, options, params) => {
        const { user, thread } = await threadOf(request, options, params)
        const subscription = await options.notifications.store.threadSubscription(user.id, thread.repository_id, thread.subject_key)
        const baseUrl = options.baseUrl(request)
        return json(200, {
          subscribed: subscription ? subscription.ignored === 0 : thread.reason !== 'subscribed',
          ignored: subscription?.ignored === 1,
          reason: subscription?.reason ?? null,
          created_at: iso(subscription?.created_at ?? null),
          url: apiUrl(baseUrl, `/notifications/threads/${thread.id}/subscription`),
          thread_url: apiUrl(baseUrl, `/notifications/threads/${thread.id}`),
        })
      },
      PUT: async (request, _url, options, params) => {
        const { user, thread } = await threadOf(request, options, params)
        const ignored = bool((await readJson(request)).ignored, 'ignored') ?? false
        await options.notifications.store.setThreadSubscription(user.id, thread.repository_id, thread.subject_key, ignored)
        return json(200, { subscribed: !ignored, ignored, reason: 'manual', url: apiUrl(options.baseUrl(request), `/notifications/threads/${thread.id}/subscription`) })
      },
      DELETE: async (request, _url, options, params) => {
        const { user, thread } = await threadOf(request, options, params)
        await options.notifications.store.setThreadSubscription(user.id, thread.repository_id, thread.subject_key, true)
        return empty(204)
      },
    },
  },
  {
    pattern: new RegExp(`^/repos/${SEGMENT}/${SEGMENT}/notifications$`),
    methods: {
      GET: async (request, url, options, params) => {
        const { user, repository } = await readableRepository(request, options, params)
        return listThreads(request, url, options, user, repository)
      },
      PUT: async (request, _url, options, params) => {
        const { user, repository } = await readableRepository(request, options, params)
        return markRead(request, options, user, repository)
      },
    },
  },
  {
    pattern: new RegExp(`^/repos/${SEGMENT}/${SEGMENT}/subscription$`),
    methods: {
      GET: async (request, _url, options, params) => {
        const { user, repository } = await readableRepository(request, options, params)
        const watch = await options.notifications.store.watch(user.id, repository.id)
        if (!watch) throw new ApiError(404, 'Not Found')
        return json(200, watchJson(options.baseUrl(request), repository, watch))
      },
      PUT: async (request, _url, options, params) => {
        const { user, repository } = await readableRepository(request, options, params)
        const body = await readJson(request)
        const ignored = bool(body.ignored, 'ignored') ?? false
        const subscribed = bool(body.subscribed, 'subscribed') ?? !ignored
        const level = body.level
        if (level !== undefined && level !== 'all' && level !== 'releases' && level !== 'ignore' && level !== 'participating') {
          throw new ApiError(422, 'level must be all, releases, participating or ignore')
        }
        const chosen = level === 'participating' ? null : ((level as 'all' | 'releases' | 'ignore' | undefined) ?? (ignored ? 'ignore' : subscribed ? 'all' : null))
        await options.notifications.store.setWatch(user.id, repository.id, chosen)
        return json(200, watchJson(options.baseUrl(request), repository, await options.notifications.store.watch(user.id, repository.id)))
      },
      DELETE: async (request, _url, options, params) => {
        const { user, repository } = await readableRepository(request, options, params)
        await options.notifications.store.setWatch(user.id, repository.id, null)
        return empty(204)
      },
    },
  },
  {
    pattern: /^\/user\/notification-settings$/,
    methods: {
      GET: async (request, _url, options) => json(200, settingsJson(await options.notifications.store.settings((await requireUser(request, options)).id))),
      PATCH: async (request, _url, options) => {
        const user = await requireUser(request, options)
        const body = await readJson(request)
        const current = await options.notifications.store.settings(user.id)
        const email = body.email ?? current.emailMode
        if (!EMAIL_MODES.includes(email as EmailMode)) throw new ApiError(422, `email must be one of ${EMAIL_MODES.join(', ')}`)
        const address = body.email_address === undefined ? current.emailAddress : body.email_address
        if (address !== null && !isEmailAddress(address)) throw new ApiError(422, 'email_address must be an email address or null')
        const next: NotificationSettings = {
          emailMode: email as EmailMode,
          emailParticipating: bool(body.email_participating, 'email_participating') ?? current.emailParticipating,
          emailWatching: bool(body.email_watching, 'email_watching') ?? current.emailWatching,
          ownActivity: bool(body.own_activity, 'own_activity') ?? current.ownActivity,
          emailAddress: address,
        }
        await options.notifications.store.saveSettings(user.id, next)
        return json(200, settingsJson(next))
      },
    },
  },
  ...hookRoutes('repository', `/repos/${SEGMENT}/${SEGMENT}`),
  ...hookRoutes('organization', `/orgs/${SEGMENT}`),
]

const matchRoute = (method: string, path: string) => {
  for (const route of ROUTES) {
    const match = route.pattern.exec(path)
    if (!match) continue
    const params = match.slice(1).map(decodeURIComponent)
    const handler = route.methods[method]
    if (!handler) {
      return async () => json(405, { message: 'Method Not Allowed' }, { Allow: Object.keys(route.methods).join(', ') })
    }
    return (request: Request, url: URL, options: NotificationsHttpOptions) => handler(request, url, options, params)
  }
  return null
}
