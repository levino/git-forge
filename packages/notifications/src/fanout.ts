import type { EventAudience, NotificationReason, WebhookEventName } from './events.ts'
import type { NotificationSettings, WatchLevel } from './store.ts'

export const REASON_RANK: Readonly<Record<NotificationReason, number>> = {
  review_requested: 10,
  assign: 9,
  mention: 8,
  team_mention: 7,
  security_alert: 6,
  author: 5,
  comment: 4,
  state_change: 3,
  manual: 2,
  ci_activity: 1,
  subscribed: 0,
}

export const PARTICIPATING_REASONS: ReadonlySet<NotificationReason> = new Set(['review_requested', 'assign', 'mention', 'team_mention', 'security_alert', 'author', 'comment', 'state_change', 'manual'])

export const isParticipating = (reason: NotificationReason): boolean => PARTICIPATING_REASONS.has(reason)

export type DirectCandidate = {
  readonly login: string
  readonly reason: NotificationReason
  readonly subscribe: boolean
}

export const directCandidates = (audience: EventAudience): DirectCandidate[] => {
  const candidates: DirectCandidate[] = []
  const add = (logins: readonly (string | null | undefined)[] | undefined, reason: NotificationReason, subscribe: boolean) => {
    for (const login of logins ?? []) if (login) candidates.push({ login, reason, subscribe })
  }
  add([audience.author], 'author', true)
  add(audience.participants, 'comment', true)
  add(audience.mentions, 'mention', true)
  add(audience.assignees, 'assign', true)
  add(audience.reviewRequested, 'review_requested', true)
  add([audience.ciActor], 'ci_activity', false)
  return candidates
}

export type RecipientInput = {
  readonly eventName: WebhookEventName
  readonly audience: EventAudience
  readonly direct: readonly { readonly userId: string; readonly reason: NotificationReason; readonly subscribe: boolean }[]
  readonly admins: readonly string[]
  readonly threadSubscribers: readonly { readonly user_id: string; readonly reason: NotificationReason; readonly ignored: number }[]
  readonly watchers: readonly { readonly user_id: string; readonly level: WatchLevel }[]
  readonly actorId: string | null
  readonly settings: ReadonlyMap<string, NotificationSettings>
}

export type Recipient = {
  readonly userId: string
  readonly reason: NotificationReason
  readonly subscribe: boolean
}

const better = (current: Recipient | undefined, reason: NotificationReason): boolean => current === undefined || REASON_RANK[reason] > REASON_RANK[current.reason]

export const resolveRecipients = (input: RecipientInput): Recipient[] => {
  const ignoredThread = new Set(input.threadSubscribers.filter((row) => row.ignored === 1).map((row) => row.user_id))
  const ignoredRepository = new Set(input.watchers.filter((row) => row.level === 'ignore').map((row) => row.user_id))
  const chosen = new Map<string, Recipient>()
  const offer = (userId: string, reason: NotificationReason, subscribe: boolean) => {
    const current = chosen.get(userId)
    if (better(current, reason)) chosen.set(userId, { userId, reason, subscribe: subscribe || (current?.subscribe ?? false) })
    else if (subscribe && current && !current.subscribe) chosen.set(userId, { ...current, subscribe: true })
  }
  for (const candidate of input.direct) offer(candidate.userId, candidate.reason, candidate.subscribe)
  if (input.audience.repositoryAdmins) for (const userId of input.admins) offer(userId, 'security_alert', false)
  for (const row of input.threadSubscribers) if (row.ignored === 0) offer(row.user_id, row.reason, false)
  const watchers = input.audience.watchers ?? 'none'
  for (const row of input.watchers) {
    if (watchers === 'all' && row.level === 'all') offer(row.user_id, 'subscribed', false)
    if (watchers === 'releases' && (row.level === 'all' || row.level === 'releases')) offer(row.user_id, 'subscribed', false)
  }
  return [...chosen.values()].filter((recipient) => {
    if (ignoredThread.has(recipient.userId) || ignoredRepository.has(recipient.userId)) return false
    if (recipient.userId === input.actorId && !(input.settings.get(recipient.userId)?.ownActivity ?? false)) return false
    return true
  })
}

export const wantsEmail = (settings: NotificationSettings, reason: NotificationReason): boolean => {
  if (settings.emailMode === 'off') return false
  return isParticipating(reason) ? settings.emailParticipating : settings.emailWatching
}

export const DIGEST_DELAY_SECONDS: Readonly<Record<Exclude<NotificationSettings['emailMode'], 'off'>, number>> = {
  instant: 0,
  hourly: 60 * 60,
  daily: 24 * 60 * 60,
}

export const hookWants = (events: readonly string[], name: string): boolean => events.includes('*') || events.includes(name)
