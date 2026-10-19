import { type Database, first, sql, type Statement } from '@git-forge/accounts'
import type { EventSubject, ForgeEvent, NotificationReason, WebhookEventName } from './events.ts'

export type WatchLevel = 'all' | 'releases' | 'ignore'

export type EmailMode = 'off' | 'instant' | 'hourly' | 'daily'

export const EMAIL_MODES: readonly EmailMode[] = ['off', 'instant', 'hourly', 'daily']

export type NotificationSettings = {
  readonly emailMode: EmailMode
  readonly emailParticipating: boolean
  readonly emailWatching: boolean
  readonly ownActivity: boolean
  readonly emailAddress: string | null
}

export const DEFAULT_SETTINGS: NotificationSettings = {
  emailMode: 'instant',
  emailParticipating: true,
  emailWatching: false,
  ownActivity: false,
  emailAddress: null,
}

export type StoredEvent = {
  readonly id: number
  readonly event: ForgeEvent
  readonly repositoryId: string | null
  readonly createdAt: number
}

export type ThreadRow = {
  readonly id: number
  readonly user_id: string
  readonly repository_id: string
  readonly subject_key: string
  readonly subject_type: string
  readonly subject_title: string
  readonly subject_url: string | null
  readonly latest_comment_url: string | null
  readonly html_url: string | null
  readonly reason: NotificationReason
  readonly unread: number
  readonly last_event_id: number | null
  readonly updated_at: number
  readonly last_read_at: number | null
  readonly emailed_at: number | null
  readonly owner_login: string
  readonly repository_name: string
}

export type HookScope = { readonly kind: 'repository'; readonly id: string } | { readonly kind: 'organization'; readonly id: string } | { readonly kind: 'app'; readonly id: string }

const SCOPE_COLUMN = { repository: 'repository_id', organization: 'organization_id', app: 'app_id' } as const

export type SealedValue = { readonly keyId: string; readonly iv: string; readonly ciphertext: string }

export type WebhookSecrets = {
  readonly seal: (context: readonly string[], value: string) => Promise<SealedValue>
  readonly open: (context: readonly string[], sealed: SealedValue) => Promise<string>
}

const SECRET_CONTEXT = ['git-forge-webhook-secret']

export type HookRow = {
  readonly id: number
  readonly repository_id: string | null
  readonly organization_id: string | null
  readonly app_id: string | null
  readonly url: string
  readonly content_type: 'json' | 'form'
  readonly secret: string | null
  readonly secret_key_id: string | null
  readonly secret_iv: string | null
  readonly insecure_ssl: number
  readonly events: string
  readonly active: number
  readonly created_by: string | null
  readonly created_at: number
  readonly updated_at: number
}

export type HookInput = {
  readonly url: string
  readonly contentType: 'json' | 'form'
  readonly secret: string | null | undefined
  readonly insecureSsl: boolean
  readonly events: readonly string[]
  readonly active: boolean
}

export type DeliveryStatus = 'pending' | 'delivered' | 'failed'

export type DeliveryRow = {
  readonly id: number
  readonly hook_id: number
  readonly guid: string
  readonly event: string
  readonly action: string | null
  readonly event_id: number | null
  readonly repository_id: string | null
  readonly redelivery: number
  readonly status: DeliveryStatus
  readonly attempts: number
  readonly status_code: number | null
  readonly duration_ms: number | null
  readonly error: string | null
  readonly url: string
  readonly payload: string
  readonly request_headers: string | null
  readonly response_headers: string | null
  readonly response_body: string | null
  readonly created_at: number
  readonly delivered_at: number | null
  readonly next_attempt_at: number | null
}

export type RepositoryRow = {
  readonly id: string
  readonly name: string
  readonly visibility: 'public' | 'private'
  readonly owner_id: string
  readonly owner_login: string
  readonly owner_kind: 'user' | 'organization'
  readonly created_at: number
}

export type UserRow = { readonly id: string; readonly login: string; readonly email: string | null }

type SettingsRow = {
  email_mode: EmailMode
  email_participating: number
  email_watching: number
  own_activity: number
  email_address: string | null
  digest_due_at: number | null
}

const settingsOf = (row: SettingsRow | null): NotificationSettings =>
  row
    ? {
        emailMode: row.email_mode,
        emailParticipating: row.email_participating === 1,
        emailWatching: row.email_watching === 1,
        ownActivity: row.own_activity === 1,
        emailAddress: row.email_address,
      }
    : DEFAULT_SETTINGS

export const createNotificationStore = (db: Database, now: () => number = Date.now, secrets?: WebhookSecrets) => {
  const secretColumns = async (secret: string | null): Promise<[string | null, string | null, string | null]> => {
    if (secret === null || !secrets) return [secret, null, null]
    const sealed = await secrets.seal(SECRET_CONTEXT, secret)
    return [sealed.ciphertext, sealed.keyId, sealed.iv]
  }
  const store = {
    db,

    hookSecret: async (hook: HookRow): Promise<string | null> => {
      if (hook.secret === null || hook.secret_key_id === null || hook.secret_iv === null) return hook.secret
      if (!secrets) throw new Error('webhook secret is sealed but ACTIONS_SECRETS_KEY is missing')
      return secrets.open(SECRET_CONTEXT, { keyId: hook.secret_key_id, iv: hook.secret_iv, ciphertext: hook.secret })
    },

    insertEvent: async (event: ForgeEvent, repositoryId: string | null): Promise<number> => {
      const rows = await db.all<{ id: number }>(
        sql(
          'INSERT INTO forge_events (name, action, repository_id, actor_kind, actor_id, actor_login, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
          event.name,
          event.action ?? null,
          repositoryId,
          event.actor.kind,
          event.actor.id,
          event.actor.login,
          JSON.stringify(event),
          now(),
        ),
      )
      return rows[0]!.id
    },

    getEvent: async (id: number): Promise<StoredEvent | null> => {
      const row = await first<{ id: number; data: string; repository_id: string | null; created_at: number }>(
        db,
        sql('SELECT id, data, repository_id, created_at FROM forge_events WHERE id = ?', id),
      )
      return row ? { id: row.id, event: JSON.parse(row.data) as ForgeEvent, repositoryId: row.repository_id, createdAt: row.created_at } : null
    },

    latestPushEvent: async (repositoryId: string): Promise<number | null> =>
      (await first<{ id: number }>(db, sql("SELECT id FROM forge_events WHERE repository_id = ? AND name = 'push' ORDER BY id DESC LIMIT 1", repositoryId)))?.id ?? null,

    repositoryById: (id: string): Promise<RepositoryRow | null> =>
      first<RepositoryRow>(
        db,
        sql(
          'SELECT r.id, r.name, r.visibility, r.owner_id, a.login AS owner_login, a.kind AS owner_kind, r.created_at FROM repositories r JOIN accounts a ON a.id = r.owner_id WHERE r.id = ?',
          id,
        ),
      ),

    repositoryByName: (owner: string, name: string): Promise<RepositoryRow | null> =>
      first<RepositoryRow>(
        db,
        sql(
          'SELECT r.id, r.name, r.visibility, r.owner_id, a.login AS owner_login, a.kind AS owner_kind, r.created_at FROM repositories r JOIN accounts a ON a.id = r.owner_id WHERE a.login = ? AND r.name = ? AND r.deleted_at IS NULL',
          owner,
          name,
        ),
      ),

    usersByLogin: async (logins: readonly string[]): Promise<UserRow[]> => {
      if (logins.length === 0) return []
      return db.all<UserRow>(
        sql(
          `SELECT id, login, email FROM accounts WHERE kind = 'user' AND disabled_at IS NULL AND login IN (${logins.map(() => '?').join(', ')})`,
          ...logins,
        ),
      )
    },

    usersById: async (ids: readonly string[]): Promise<UserRow[]> => {
      if (ids.length === 0) return []
      return db.all<UserRow>(sql(`SELECT id, login, email FROM accounts WHERE kind = 'user' AND disabled_at IS NULL AND id IN (${ids.map(() => '?').join(', ')})`, ...ids))
    },

    organizationRole: async (organizationId: string, userId: string): Promise<'member' | 'owner' | null> =>
      (await first<{ role: 'member' | 'owner' }>(db, sql('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?', organizationId, userId)))?.role ?? null,

    repositoryAdmins: async (repository: RepositoryRow): Promise<string[]> => {
      const owners =
        repository.owner_kind === 'user'
          ? [repository.owner_id]
          : (await db.all<{ user_id: string }>(sql("SELECT user_id FROM organization_members WHERE organization_id = ? AND role = 'owner'", repository.owner_id))).map((row) => row.user_id)
      const collaborators = await db.all<{ user_id: string }>(sql("SELECT user_id FROM repository_collaborators WHERE repository_id = ? AND role = 'admin'", repository.id))
      return [...new Set([...owners, ...collaborators.map((row) => row.user_id)])]
    },

    watch: async (userId: string, repositoryId: string): Promise<{ readonly level: WatchLevel; readonly createdAt: number } | null> => {
      const row = await first<{ level: WatchLevel; created_at: number }>(db, sql('SELECT level, created_at FROM repository_watches WHERE user_id = ? AND repository_id = ?', userId, repositoryId))
      return row ? { level: row.level, createdAt: row.created_at } : null
    },

    setWatch: async (userId: string, repositoryId: string, level: WatchLevel | null): Promise<void> => {
      if (level === null) {
        await db.run(sql('DELETE FROM repository_watches WHERE user_id = ? AND repository_id = ?', userId, repositoryId))
        return
      }
      const at = now()
      await db.run(
        sql(
          'INSERT INTO repository_watches (user_id, repository_id, level, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, repository_id) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at',
          userId,
          repositoryId,
          level,
          at,
          at,
        ),
      )
    },

    watchers: (repositoryId: string): Promise<{ user_id: string; level: WatchLevel }[]> =>
      db.all<{ user_id: string; level: WatchLevel }>(sql('SELECT user_id, level FROM repository_watches WHERE repository_id = ?', repositoryId)),

    threadSubscribers: (repositoryId: string, subjectKey: string): Promise<{ user_id: string; reason: NotificationReason; ignored: number }[]> =>
      db.all<{ user_id: string; reason: NotificationReason; ignored: number }>(
        sql('SELECT user_id, reason, ignored FROM thread_subscriptions WHERE repository_id = ? AND subject_key = ?', repositoryId, subjectKey),
      ),

    subscribeThreadStatements: (entries: readonly { readonly userId: string; readonly reason: NotificationReason }[], repositoryId: string, subjectKey: string): Statement[] => {
      const at = now()
      return entries.map((entry) =>
        sql(
          'INSERT INTO thread_subscriptions (user_id, repository_id, subject_key, reason, ignored, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?) ON CONFLICT (user_id, repository_id, subject_key) DO NOTHING',
          entry.userId,
          repositoryId,
          subjectKey,
          entry.reason,
          at,
          at,
        ),
      )
    },

    setThreadSubscription: async (userId: string, repositoryId: string, subjectKey: string, ignored: boolean | null): Promise<void> => {
      if (ignored === null) {
        await db.run(sql('DELETE FROM thread_subscriptions WHERE user_id = ? AND repository_id = ? AND subject_key = ?', userId, repositoryId, subjectKey))
        return
      }
      const at = now()
      await db.run(
        sql(
          "INSERT INTO thread_subscriptions (user_id, repository_id, subject_key, reason, ignored, created_at, updated_at) VALUES (?, ?, ?, 'manual', ?, ?, ?) ON CONFLICT (user_id, repository_id, subject_key) DO UPDATE SET ignored = excluded.ignored, updated_at = excluded.updated_at",
          userId,
          repositoryId,
          subjectKey,
          ignored ? 1 : 0,
          at,
          at,
        ),
      )
    },

    threadSubscription: (userId: string, repositoryId: string, subjectKey: string) =>
      first<{ reason: string; ignored: number; created_at: number }>(
        db,
        sql('SELECT reason, ignored, created_at FROM thread_subscriptions WHERE user_id = ? AND repository_id = ? AND subject_key = ?', userId, repositoryId, subjectKey),
      ),

    upsertThreadStatement: (userId: string, repositoryId: string, subject: EventSubject, reason: NotificationReason, eventId: number, at: number): Statement =>
      sql(
        `INSERT INTO notification_threads (user_id, repository_id, subject_key, subject_type, subject_title, subject_url, latest_comment_url, html_url, reason, unread, last_event_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (user_id, repository_id, subject_key) DO UPDATE SET subject_type = excluded.subject_type, subject_title = excluded.subject_title,
           subject_url = excluded.subject_url, latest_comment_url = excluded.latest_comment_url, html_url = excluded.html_url, reason = excluded.reason,
           unread = 1, last_event_id = excluded.last_event_id, updated_at = excluded.updated_at
         WHERE notification_threads.last_event_id IS NULL OR notification_threads.last_event_id < excluded.last_event_id`,
        userId,
        repositoryId,
        subject.key,
        subject.type,
        subject.title,
        subject.url ?? null,
        subject.latestCommentUrl ?? null,
        subject.htmlUrl ?? null,
        reason,
        eventId,
        at,
      ),

    threads: async (
      userId: string,
      filter: {
        readonly all: boolean
        readonly participating: boolean
        readonly repositoryId?: string
        readonly since?: number
        readonly before?: number
        readonly limit: number
        readonly offset: number
      },
    ): Promise<ThreadRow[]> => {
      const clauses = ['t.user_id = ?']
      const params: (string | number)[] = [userId]
      if (!filter.all) clauses.push('t.unread = 1')
      if (filter.participating) clauses.push("t.reason <> 'subscribed'")
      if (filter.repositoryId) {
        clauses.push('t.repository_id = ?')
        params.push(filter.repositoryId)
      }
      if (filter.since !== undefined) {
        clauses.push('t.updated_at >= ?')
        params.push(filter.since)
      }
      if (filter.before !== undefined) {
        clauses.push('t.updated_at < ?')
        params.push(filter.before)
      }
      return db.all<ThreadRow>(
        sql(
          `SELECT t.*, a.login AS owner_login, r.name AS repository_name FROM notification_threads t
           JOIN repositories r ON r.id = t.repository_id JOIN accounts a ON a.id = r.owner_id
           WHERE ${clauses.join(' AND ')} ORDER BY t.updated_at DESC, t.id DESC LIMIT ? OFFSET ?`,
          ...params,
          filter.limit,
          filter.offset,
        ),
      )
    },

    thread: (userId: string, id: number): Promise<ThreadRow | null> =>
      first<ThreadRow>(
        db,
        sql(
          `SELECT t.*, a.login AS owner_login, r.name AS repository_name FROM notification_threads t
           JOIN repositories r ON r.id = t.repository_id JOIN accounts a ON a.id = r.owner_id WHERE t.user_id = ? AND t.id = ?`,
          userId,
          id,
        ),
      ),

    markThreadRead: async (userId: string, id: number): Promise<boolean> =>
      (await db.run(sql('UPDATE notification_threads SET unread = 0, last_read_at = ? WHERE user_id = ? AND id = ?', now(), userId, id))).changes > 0,

    markThreadDone: async (userId: string, id: number): Promise<boolean> =>
      (await db.run(sql('DELETE FROM notification_threads WHERE user_id = ? AND id = ?', userId, id))).changes > 0,

    markAllRead: async (userId: string, lastReadAt: number, repositoryId?: string): Promise<number> =>
      (
        await db.run(
          repositoryId
            ? sql('UPDATE notification_threads SET unread = 0, last_read_at = ? WHERE user_id = ? AND repository_id = ? AND unread = 1 AND updated_at <= ?', now(), userId, repositoryId, lastReadAt)
            : sql('UPDATE notification_threads SET unread = 0, last_read_at = ? WHERE user_id = ? AND unread = 1 AND updated_at <= ?', now(), userId, lastReadAt),
        )
      ).changes,

    settings: async (userId: string): Promise<NotificationSettings> =>
      settingsOf(await first<SettingsRow>(db, sql('SELECT * FROM notification_settings WHERE user_id = ?', userId))),

    settingsFor: async (userIds: readonly string[]): Promise<Map<string, NotificationSettings>> => {
      const result = new Map<string, NotificationSettings>()
      if (userIds.length === 0) return result
      const rows = await db.all<SettingsRow & { user_id: string }>(
        sql(`SELECT * FROM notification_settings WHERE user_id IN (${userIds.map(() => '?').join(', ')})`, ...userIds),
      )
      for (const id of userIds) result.set(id, DEFAULT_SETTINGS)
      for (const row of rows) result.set(row.user_id, settingsOf(row))
      return result
    },

    saveSettings: async (userId: string, settings: NotificationSettings): Promise<void> => {
      await db.run(
        sql(
          `INSERT INTO notification_settings (user_id, email_mode, email_participating, email_watching, own_activity, email_address, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (user_id) DO UPDATE SET email_mode = excluded.email_mode, email_participating = excluded.email_participating, email_watching = excluded.email_watching,
             own_activity = excluded.own_activity, email_address = excluded.email_address, updated_at = excluded.updated_at`,
          userId,
          settings.emailMode,
          settings.emailParticipating ? 1 : 0,
          settings.emailWatching ? 1 : 0,
          settings.ownActivity ? 1 : 0,
          settings.emailAddress,
          now(),
        ),
      )
    },

    claimDigest: async (userId: string, dueAt: number): Promise<boolean> => {
      await db.run(sql('INSERT INTO notification_settings (user_id, updated_at) VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING', userId, now()))
      return (await db.run(sql('UPDATE notification_settings SET digest_due_at = ? WHERE user_id = ? AND digest_due_at IS NULL', dueAt, userId))).changes > 0
    },

    digestDueAt: async (userId: string): Promise<number | null> =>
      (await first<{ digest_due_at: number | null }>(db, sql('SELECT digest_due_at FROM notification_settings WHERE user_id = ?', userId)))?.digest_due_at ?? null,

    releaseDigest: async (userId: string): Promise<void> => {
      await db.run(sql('UPDATE notification_settings SET digest_due_at = NULL WHERE user_id = ?', userId))
    },

    dueDigests: async (before: number): Promise<string[]> =>
      (await db.all<{ user_id: string }>(sql('SELECT user_id FROM notification_settings WHERE digest_due_at IS NOT NULL AND digest_due_at <= ? LIMIT 500', before))).map((row) => row.user_id),

    pendingEmailThreads: (userId: string, upTo: number): Promise<ThreadRow[]> =>
      db.all<ThreadRow>(
        sql(
          `SELECT t.*, a.login AS owner_login, r.name AS repository_name FROM notification_threads t
           JOIN repositories r ON r.id = t.repository_id JOIN accounts a ON a.id = r.owner_id
           WHERE t.user_id = ? AND t.unread = 1 AND t.updated_at <= ? AND (t.emailed_at IS NULL OR t.emailed_at < t.updated_at)
           ORDER BY t.updated_at DESC LIMIT 200`,
          userId,
          upTo,
        ),
      ),

    markEmailed: async (userId: string, ids: readonly number[], at: number): Promise<void> => {
      if (ids.length === 0) return
      await db.run(sql(`UPDATE notification_threads SET emailed_at = ? WHERE user_id = ? AND id IN (${ids.map(() => '?').join(', ')})`, at, userId, ...ids))
    },

    hooksFor: (repository: RepositoryRow): Promise<HookRow[]> =>
      db.all<HookRow>(
        sql(
          'SELECT * FROM webhooks WHERE active = 1 AND (repository_id = ? OR organization_id = ?) ORDER BY id',
          repository.id,
          repository.owner_kind === 'organization' ? repository.owner_id : '',
        ),
      ),

    appHooksFor: (repository: RepositoryRow): Promise<(HookRow & { installation_id: number; installation_events: string })[]> =>
      db.all<HookRow & { installation_id: number; installation_events: string }>(
        sql(
          `SELECT w.*, i.id AS installation_id, i.events AS installation_events FROM app_installations i
           JOIN apps a ON a.id = i.app_id AND a.disabled_at IS NULL
           JOIN webhooks w ON w.app_id = i.app_id AND w.active = 1
           WHERE i.account_id = ? AND i.deleted_at IS NULL AND i.suspended_at IS NULL
             AND (i.repository_selection = 'all' OR EXISTS (SELECT 1 FROM app_installation_repositories r WHERE r.installation_id = i.id AND r.repository_id = ?))
           ORDER BY w.id`,
          repository.owner_id,
          repository.id,
        ),
      ),

    listHooks: (scope: HookScope): Promise<HookRow[]> => db.all<HookRow>(sql(`SELECT * FROM webhooks WHERE ${SCOPE_COLUMN[scope.kind]} = ? ORDER BY id`, scope.id)),

    hook: (scope: HookScope, id: number): Promise<HookRow | null> => first<HookRow>(db, sql(`SELECT * FROM webhooks WHERE id = ? AND ${SCOPE_COLUMN[scope.kind]} = ?`, id, scope.id)),

    hookById: (id: number): Promise<HookRow | null> => first<HookRow>(db, sql('SELECT * FROM webhooks WHERE id = ?', id)),

    createHook: async (scope: HookScope, input: HookInput, createdBy: string | null): Promise<HookRow> => {
      const at = now()
      const rows = await db.all<HookRow>(
        sql(
          'INSERT INTO webhooks (repository_id, organization_id, app_id, url, content_type, secret, secret_key_id, secret_iv, insecure_ssl, events, active, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
          scope.kind === 'repository' ? scope.id : null,
          scope.kind === 'organization' ? scope.id : null,
          scope.kind === 'app' ? scope.id : null,
          input.url,
          input.contentType,
          ...(await secretColumns(input.secret ?? null)),
          input.insecureSsl ? 1 : 0,
          JSON.stringify(input.events),
          input.active ? 1 : 0,
          createdBy,
          at,
          at,
        ),
      )
      return rows[0]!
    },

    updateHook: async (id: number, input: HookInput): Promise<void> => {
      const secret = input.secret === undefined ? [] : await secretColumns(input.secret)
      await db.run(
        sql(
          `UPDATE webhooks SET url = ?, content_type = ?, ${secret.length > 0 ? 'secret = ?, secret_key_id = ?, secret_iv = ?, ' : ''}insecure_ssl = ?, events = ?, active = ?, updated_at = ? WHERE id = ?`,
          input.url,
          input.contentType,
          ...secret,
          input.insecureSsl ? 1 : 0,
          JSON.stringify(input.events),
          input.active ? 1 : 0,
          now(),
          id,
        ),
      )
    },

    deleteHook: async (id: number): Promise<void> => {
      await db.batch([sql('DELETE FROM webhook_deliveries WHERE hook_id = ?', id), sql('DELETE FROM webhooks WHERE id = ?', id)])
    },

    insertDelivery: async (input: {
      readonly hookId: number
      readonly guid: string
      readonly event: WebhookEventName | 'ping'
      readonly action: string | null
      readonly eventId: number | null
      readonly repositoryId: string | null
      readonly url: string
      readonly payload: string
      readonly redelivery: boolean
    }): Promise<number | null> => {
      const rows = await db.all<{ id: number }>(
        sql(
          `INSERT INTO webhook_deliveries (hook_id, guid, event, action, event_id, repository_id, redelivery, status, attempts, url, payload, created_at, next_attempt_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?
           WHERE ? IS NULL OR ? = 1 OR NOT EXISTS (SELECT 1 FROM webhook_deliveries WHERE event_id = ? AND hook_id = ? AND redelivery = 0)
           RETURNING id`,
          input.hookId,
          input.guid,
          input.event,
          input.action,
          input.eventId,
          input.repositoryId,
          input.redelivery ? 1 : 0,
          input.url,
          input.payload,
          now(),
          now(),
          input.eventId,
          input.redelivery ? 1 : 0,
          input.eventId,
          input.hookId,
        ),
      )
      return rows[0]?.id ?? null
    },

    delivery: (id: number): Promise<DeliveryRow | null> => first<DeliveryRow>(db, sql('SELECT * FROM webhook_deliveries WHERE id = ?', id)),

    deliveriesFor: (hookId: number, limit: number, beforeId?: number): Promise<DeliveryRow[]> =>
      db.all<DeliveryRow>(
        beforeId === undefined
          ? sql('SELECT * FROM webhook_deliveries WHERE hook_id = ? ORDER BY id DESC LIMIT ?', hookId, limit)
          : sql('SELECT * FROM webhook_deliveries WHERE hook_id = ? AND id < ? ORDER BY id DESC LIMIT ?', hookId, beforeId, limit),
      ),

    recordAttempt: async (
      id: number,
      attempt: {
        readonly status: DeliveryStatus
        readonly statusCode: number | null
        readonly durationMs: number
        readonly error: string | null
        readonly requestHeaders: Record<string, string>
        readonly responseHeaders: Record<string, string> | null
        readonly responseBody: string | null
        readonly nextAttemptAt: number | null
      },
    ): Promise<boolean> =>
      (
        await db.run(
          sql(
            `UPDATE webhook_deliveries SET status = ?, attempts = attempts + 1, status_code = ?, duration_ms = ?, error = ?, request_headers = ?, response_headers = ?, response_body = ?,
             delivered_at = ?, next_attempt_at = ? WHERE id = ? AND status = 'pending'`,
            attempt.status,
            attempt.statusCode,
            attempt.durationMs,
            attempt.error,
            JSON.stringify(attempt.requestHeaders),
            attempt.responseHeaders === null ? null : JSON.stringify(attempt.responseHeaders),
            attempt.responseBody,
            now(),
            attempt.nextAttemptAt,
            id,
          ),
        )
      ).changes > 0,

    claimDelivery: async (id: number, leaseUntil: number, dueBy: number): Promise<DeliveryRow | null> => {
      const rows = await db.all<DeliveryRow>(
        sql("UPDATE webhook_deliveries SET next_attempt_at = ? WHERE id = ? AND status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) RETURNING *", leaseUntil, id, dueBy),
      )
      return rows[0] ?? null
    },

    pendingDeliveries: async (before: number): Promise<number[]> =>
      (await db.all<{ id: number }>(sql("SELECT id FROM webhook_deliveries WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY id LIMIT 500", before))).map(
        (row) => row.id,
      ),
  }
  return store
}

export type NotificationStore = ReturnType<typeof createNotificationStore>
