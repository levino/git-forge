import { checkRepositoryAccess, type Database, type RepositoryDirectory, type UserPrincipal } from '@git-forge/accounts'
import { type EmailSender, EmailRejectedError, type JobQueue, readRefs, type Storage } from '@git-forge/core'
import { renderDigest } from './digest.ts'
import { type ForgeEvent, userObject } from './events.ts'
import { DIGEST_DELAY_SECONDS, directCandidates, hookWants, resolveRecipients, wantsEmail } from './fanout.ts'
import { createNotificationStore, type HookRow, type NotificationStore, type RepositoryRow, type WebhookSecrets } from './store.ts'
import {
  buildDeliveryRequest,
  hookEvents,
  hookObject,
  organizationObject,
  pingZen,
  repositoryObject,
  sendDelivery,
  validateWebhookUrl,
  WEBHOOK_MAX_ATTEMPTS,
  webhookRetryDelaySeconds,
} from './webhooks.ts'

export type NotificationJob =
  | { readonly kind: 'notification-event'; readonly eventId: number }
  | { readonly kind: 'webhook-delivery'; readonly deliveryId: number }
  | { readonly kind: 'notification-digest'; readonly userId: string }

export const NOTIFICATION_JOB_KINDS: readonly NotificationJob['kind'][] = ['notification-event', 'webhook-delivery', 'notification-digest']

export const isNotificationJob = (job: { readonly kind: string }): job is NotificationJob => (NOTIFICATION_JOB_KINDS as readonly string[]).includes(job.kind)

export type NotificationsOptions = {
  readonly db: Database
  readonly directory: RepositoryDirectory
  readonly storage?: Storage
  readonly jobs?: JobQueue<NotificationJob>
  readonly email?: EmailSender
  readonly fetch?: (request: Request) => Promise<Response>
  readonly allowInsecureWebhooks?: boolean
  readonly secrets?: WebhookSecrets
  readonly baseUrl?: string
  readonly now?: () => number
  readonly log?: (entry: Record<string, unknown>) => void
}

export type SweepResult = {
  readonly deliveries: number
  readonly digests: number
}

const LEASE_MS = 60_000

const STALE_MS = 60_000

const MAX_QUEUE_DELAY_SECONDS = 12 * 60 * 60

const userPrincipal = (id: string, login: string): UserPrincipal => ({ kind: 'user', id, login, limits: null, tokenId: null })

export const createNotifications = (options: NotificationsOptions) => {
  const now = options.now ?? Date.now
  const store: NotificationStore = createNotificationStore(options.db, now, options.secrets)
  const log = options.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify(entry)))
  const fetcher = options.fetch ?? ((request: Request) => fetch(request))

  const defaultBranch = async (repository: RepositoryRow): Promise<string | null> => {
    if (!options.storage) return null
    const refs = await readRefs(options.storage, { owner: repository.owner_login, name: repository.name })
    return refs ? refs.state.head.replace(/^refs\/heads\//, '') : null
  }

  const schedule = async (job: NotificationJob, delaySeconds = 0): Promise<boolean> => {
    if (!options.jobs) return false
    await options.jobs.enqueue(job, delaySeconds > 0 ? { delaySeconds: Math.min(MAX_QUEUE_DELAY_SECONDS, Math.ceil(delaySeconds)) } : {})
    return true
  }

  const canRead = async (userId: string, login: string, repository: RepositoryRow): Promise<boolean> =>
    (await checkRepositoryAccess(options.directory, userPrincipal(userId, login), { owner: repository.owner_login, name: repository.name }, 'read')).decision === 'allow'

  const deliver = async (deliveryId: number): Promise<void> => {
    const pending = await store.delivery(deliveryId)
    if (!pending || pending.status !== 'pending') return
    if (pending.next_attempt_at !== null && pending.next_attempt_at > now() + 1000) {
      await schedule({ kind: 'webhook-delivery', deliveryId }, (pending.next_attempt_at - now()) / 1000)
      return
    }
    const delivery = await store.claimDelivery(deliveryId, now() + LEASE_MS, now() + 1000)
    if (!delivery) return
    const fail = (error: string) =>
      store.recordAttempt(deliveryId, { status: 'failed', statusCode: null, durationMs: 0, error, requestHeaders: {}, responseHeaders: null, responseBody: null, nextAttemptAt: null })
    const hook = await store.hookById(delivery.hook_id)
    if (!hook) return void (await fail('webhook was deleted'))
    if (hook.active !== 1 && delivery.event !== 'ping') return void (await fail('webhook is inactive'))
    const invalid = validateWebhookUrl(hook.url, { allowInsecure: options.allowInsecureWebhooks ?? false })
    if (invalid) return void (await fail(invalid))
    const request = await buildDeliveryRequest(hook, delivery, await store.hookSecret(hook))
    const outcome = await sendDelivery(request, fetcher, now)
    const attempt = delivery.attempts + 1
    const retry = !outcome.ok && outcome.retryable && attempt < WEBHOOK_MAX_ATTEMPTS
    const delay = webhookRetryDelaySeconds(attempt)
    await store.recordAttempt(deliveryId, {
      status: outcome.ok ? 'delivered' : retry ? 'pending' : 'failed',
      statusCode: outcome.statusCode,
      durationMs: outcome.durationMs,
      error: outcome.error,
      requestHeaders: Object.fromEntries(Object.entries(request.headers).filter(([name]) => !name.startsWith('X-Hub-Signature'))),
      responseHeaders: outcome.responseHeaders,
      responseBody: outcome.responseBody,
      nextAttemptAt: retry ? now() + delay * 1000 : null,
    })
    log({ event: 'webhook-delivery', hook: hook.id, delivery: deliveryId, guid: delivery.guid, attempt, status: outcome.statusCode, ok: outcome.ok, retry })
    if (retry) await schedule({ kind: 'webhook-delivery', deliveryId }, delay)
  }

  const dispatchDelivery = async (deliveryId: number): Promise<void> => {
    if (!(await schedule({ kind: 'webhook-delivery', deliveryId }))) await deliver(deliveryId)
  }

  const webhookPayload = async (event: ForgeEvent, repository: RepositoryRow): Promise<Record<string, unknown>> => {
    const organization = organizationObject(event.baseUrl, repository)
    return {
      ...event.payload,
      repository: repositoryObject(event.baseUrl, repository, await defaultBranch(repository)),
      ...(organization ? { organization } : {}),
      sender: userObject(event.baseUrl, event.actor.login, event.actor.id),
    }
  }

  const createDeliveries = async (
    targets: readonly { readonly hook: HookRow; readonly payload: string }[],
    event: { readonly name: ForgeEvent['name'] | 'ping'; readonly action: string | null; readonly eventId: number | null; readonly repositoryId: string | null },
  ): Promise<number[]> => {
    const created: number[] = []
    for (const { hook, payload } of targets) {
      const id = await store.insertDelivery({ hookId: hook.id, guid: crypto.randomUUID(), event: event.name, action: event.action, eventId: event.eventId, repositoryId: event.repositoryId, url: hook.url, payload, redelivery: false })
      if (id !== null) created.push(id)
    }
    for (const id of created) await dispatchDelivery(id)
    return created
  }

  const fanOutWebhooks = async (eventId: number, event: ForgeEvent, repository: RepositoryRow, only?: number): Promise<number> => {
    const hooks = (await store.hooksFor(repository)).filter((hook) => (only === undefined ? hookWants(hookEvents(hook), event.name) : hook.id === only))
    const appHooks = only === undefined ? (await store.appHooksFor(repository)).filter((hook) => hookWants(JSON.parse(hook.installation_events) as string[], event.name)) : []
    if (hooks.length === 0 && appHooks.length === 0) return 0
    const payload = await webhookPayload(event, repository)
    const text = JSON.stringify(payload)
    const targets = [
      ...hooks.map((hook) => ({ hook, payload: text })),
      ...appHooks.map((hook) => ({ hook, payload: JSON.stringify({ ...payload, installation: { id: hook.installation_id, node_id: `MDIz${hook.installation_id}` } }) })),
    ]
    return (await createDeliveries(targets, { name: event.name, action: event.action ?? null, eventId: only === undefined ? eventId : null, repositoryId: repository.id })).length
  }

  const emitToApp = async (appId: string, name: 'installation' | 'installation_repositories', action: string, payload: Record<string, unknown>, sender: { readonly id: string; readonly login: string }, baseUrl: string): Promise<number> => {
    const [hook] = await store.listHooks({ kind: 'app', id: appId })
    if (!hook || hook.active !== 1) return 0
    const body = JSON.stringify({ action, ...payload, sender: userObject(baseUrl, sender.login, sender.id) })
    return (await createDeliveries([{ hook, payload: body }], { name, action, eventId: null, repositoryId: null })).length
  }

  const test = async (hook: HookRow): Promise<number> => {
    if (!hook.repository_id || !hookWants(hookEvents(hook), 'push')) return 0
    const eventId = await store.latestPushEvent(hook.repository_id)
    const stored = eventId === null ? null : await store.getEvent(eventId)
    const repository = await store.repositoryById(hook.repository_id)
    if (!stored || !repository) return 0
    return fanOutWebhooks(stored.id, stored.event, repository, hook.id)
  }

  const scheduleDigest = async (userId: string, delaySeconds: number): Promise<void> => {
    if (!(await store.claimDigest(userId, now() + delaySeconds * 1000))) return
    if (await schedule({ kind: 'notification-digest', userId }, delaySeconds)) return
    if (delaySeconds === 0) await digest(userId)
  }

  const fanOutNotifications = async (eventId: number, event: ForgeEvent, repository: RepositoryRow): Promise<number> => {
    const { subject, audience } = event
    if (!subject || !audience) return 0
    const candidates = directCandidates(audience)
    const users = await store.usersByLogin([...new Set(candidates.map((candidate) => candidate.login))])
    const byLogin = new Map(users.map((user) => [user.login.toLowerCase(), user]))
    const direct = candidates.flatMap((candidate) => {
      const user = byLogin.get(candidate.login.toLowerCase())
      return user ? [{ userId: user.id, reason: candidate.reason, subscribe: candidate.subscribe }] : []
    })
    const admins = audience.repositoryAdmins ? await store.repositoryAdmins(repository) : []
    const threadSubscribers = await store.threadSubscribers(repository.id, subject.key)
    const watchers = audience.watchers && audience.watchers !== 'none' ? await store.watchers(repository.id) : []
    const involved = [...new Set([...direct.map((entry) => entry.userId), ...admins, ...threadSubscribers.map((row) => row.user_id), ...watchers.map((row) => row.user_id)])]
    const settings = await store.settingsFor(involved)
    const recipients = resolveRecipients({ eventName: event.name, audience, direct, admins, threadSubscribers, watchers, actorId: event.actor.kind === 'user' ? event.actor.id : null, settings })
    const accounts = new Map((await store.usersById(involved)).map((user) => [user.id, user]))
    const readable = new Map<string, boolean>()
    const allowed = async (userId: string): Promise<boolean> => {
      const user = accounts.get(userId)
      if (!user) return false
      if (!readable.has(userId)) readable.set(userId, await canRead(userId, user.login, repository))
      return readable.get(userId)!
    }
    const at = now()
    const statements = []
    const notified = []
    for (const recipient of recipients) {
      if (!(await allowed(recipient.userId))) continue
      statements.push(store.upsertThreadStatement(recipient.userId, repository.id, subject, recipient.reason, eventId, at))
      notified.push(recipient)
    }
    const subscribers = []
    for (const entry of direct) if (entry.subscribe && (await allowed(entry.userId))) subscribers.push(entry)
    statements.push(...store.subscribeThreadStatements(subscribers, repository.id, subject.key))
    if (statements.length > 0) await options.db.batch(statements)
    if (options.email) {
      for (const recipient of notified) {
        const preferences = settings.get(recipient.userId)!
        if (preferences.emailMode === 'off' || !wantsEmail(preferences, recipient.reason)) continue
        if (!(preferences.emailAddress ?? accounts.get(recipient.userId)?.email)) continue
        await scheduleDigest(recipient.userId, DIGEST_DELAY_SECONDS[preferences.emailMode])
      }
    }
    return notified.length
  }

  const processEvent = async (eventId: number): Promise<void> => {
    const stored = await store.getEvent(eventId)
    if (!stored?.repositoryId) return
    const repository = await store.repositoryById(stored.repositoryId)
    if (!repository) return
    const hooks = await fanOutWebhooks(eventId, stored.event, repository)
    const notified = await fanOutNotifications(eventId, stored.event, repository)
    log({ event: 'notification-event', id: eventId, name: stored.event.name, action: stored.event.action, repository: `${repository.owner_login}/${repository.name}`, hooks, notified })
  }

  const digest = async (userId: string): Promise<void> => {
    const dueAt = await store.digestDueAt(userId)
    if (dueAt === null) return
    if (dueAt > now() + 1000) {
      if (!(await schedule({ kind: 'notification-digest', userId }, (dueAt - now()) / 1000))) return
      return
    }
    const [user] = await store.usersById([userId])
    const settings = await store.settings(userId)
    const address = settings.emailAddress ?? user?.email ?? null
    if (!user || !address || !options.email || settings.emailMode === 'off') {
      await store.releaseDigest(userId)
      return
    }
    const snapshot = now()
    const threads = await store.pendingEmailThreads(userId, snapshot)
    const wanted = threads.filter((thread) => wantsEmail(settings, thread.reason))
    if (wanted.length > 0) {
      const baseUrl = options.baseUrl ?? new URL(wanted[0]!.html_url ?? wanted[0]!.subject_url ?? 'http://localhost').origin
      try {
        const sent = await options.email.send(renderDigest({ login: user.login, address, threads: wanted, baseUrl }))
        log({ event: 'notification-email', user: user.login, threads: wanted.length, id: sent.id })
      } catch (error) {
        if (!(error instanceof EmailRejectedError)) throw error
        log({ event: 'notification-email-rejected', user: user.login, error: error.message })
      }
    }
    await store.markEmailed(
      userId,
      threads.map((thread) => thread.id),
      snapshot,
    )
    await store.releaseDigest(userId)
    const later = (await store.pendingEmailThreads(userId, now())).filter((thread) => thread.updated_at > snapshot && wantsEmail(settings, thread.reason))
    if (later.length > 0) await scheduleDigest(userId, DIGEST_DELAY_SECONDS[settings.emailMode])
  }

  const emit = async (event: ForgeEvent): Promise<number | null> => {
    const repository = await store.repositoryByName(event.repository.owner, event.repository.name)
    if (!repository) return null
    const eventId = await store.insertEvent(event, repository.id)
    if (!(await schedule({ kind: 'notification-event', eventId }))) await processEvent(eventId)
    return eventId
  }

  const ping = async (hook: HookRow, baseUrl: string, sender: { readonly id: string; readonly login: string }, scopePath: string): Promise<number> => {
    const repository = hook.repository_id ? await store.repositoryById(hook.repository_id) : null
    const organization = repository ? organizationObject(baseUrl, repository) : null
    const payload = {
      zen: pingZen(hook.id),
      hook_id: hook.id,
      hook: hookObject(baseUrl, hook, scopePath),
      ...(repository ? { repository: repositoryObject(baseUrl, repository, await defaultBranch(repository)) } : {}),
      ...(organization ? { organization } : {}),
      sender: userObject(baseUrl, sender.login, sender.id),
    }
    return (await createDeliveries([{ hook, payload: JSON.stringify(payload) }], { name: 'ping', action: null, eventId: null, repositoryId: hook.repository_id }))[0]!
  }

  const redeliver = async (deliveryId: number): Promise<number | null> => {
    const original = await store.delivery(deliveryId)
    if (!original) return null
    const id = (await store.insertDelivery({
      hookId: original.hook_id,
      guid: original.guid,
      event: original.event as ForgeEvent['name'],
      action: original.action,
      eventId: original.event_id,
      repositoryId: original.repository_id,
      url: original.url,
      payload: original.payload,
      redelivery: true,
    }))!
    await dispatchDelivery(id)
    return id
  }

  const runJob = async (job: NotificationJob): Promise<void> => {
    switch (job.kind) {
      case 'notification-event':
        return processEvent(job.eventId)
      case 'webhook-delivery':
        return deliver(job.deliveryId)
      case 'notification-digest':
        return digest(job.userId)
    }
  }

  const sweep = async (): Promise<SweepResult> => {
    const deliveries = await store.pendingDeliveries(now() - STALE_MS)
    for (const id of deliveries) await dispatchDelivery(id)
    const digests = await store.dueDigests(now() - (options.jobs ? STALE_MS : 0))
    for (const userId of digests) if (!(await schedule({ kind: 'notification-digest', userId }))) await digest(userId)
    return { deliveries: deliveries.length, digests: digests.length }
  }

  return { store, emit, emitToApp, runJob, sweep, ping, test, redeliver, processEvent }
}

export type Notifications = ReturnType<typeof createNotifications>
