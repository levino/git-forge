import type { EmailMessage } from '@git-forge/core'
import type { NotificationReason } from './events.ts'
import type { ThreadRow } from './store.ts'

const REASON_TEXT: Readonly<Record<NotificationReason, string>> = {
  review_requested: 'your review was requested',
  assign: 'you were assigned',
  mention: 'you were mentioned',
  team_mention: 'your team was mentioned',
  author: 'you opened it',
  comment: 'you commented',
  state_change: 'you changed its state',
  ci_activity: 'you triggered this run',
  security_alert: 'you administer this repository',
  manual: 'you subscribed',
  subscribed: 'you are watching the repository',
}

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export type DigestInput = {
  readonly login: string
  readonly address: string
  readonly threads: readonly ThreadRow[]
  readonly baseUrl: string
  readonly instanceName?: string
}

export const renderDigest = (input: DigestInput): EmailMessage => {
  const name = input.instanceName ?? new URL(input.baseUrl).host
  const count = input.threads.length
  const [single] = input.threads
  const subject =
    count === 1 && single
      ? `[${single.owner_login}/${single.repository_name}] ${single.subject_title}`
      : `[${name}] ${count} new notifications`
  const settingsUrl = `${input.baseUrl}/settings/notifications`
  const lines = input.threads.map((thread) => {
    const url = thread.html_url ?? thread.subject_url ?? `${input.baseUrl}/${thread.owner_login}/${thread.repository_name}`
    return { repository: `${thread.owner_login}/${thread.repository_name}`, title: thread.subject_title, type: thread.subject_type, reason: REASON_TEXT[thread.reason] ?? thread.reason, url }
  })
  const text = [
    `Hello ${input.login},`,
    '',
    count === 1 ? 'there is a new notification for you:' : `there are ${count} new notifications for you:`,
    '',
    ...lines.flatMap((line) => [`[${line.repository}] ${line.type}: ${line.title}`, `  ${line.url}`, `  (${line.reason})`, '']),
    `Change how and when you get these emails: ${settingsUrl}`,
    '',
  ].join('\n')
  const html = [
    `<p>Hello ${escapeHtml(input.login)},</p>`,
    `<ul>`,
    ...lines.map(
      (line) =>
        `<li><a href="${escapeHtml(line.url)}">[${escapeHtml(line.repository)}] ${escapeHtml(line.type)}: ${escapeHtml(line.title)}</a><br><small>${escapeHtml(line.reason)}</small></li>`,
    ),
    `</ul>`,
    `<p><small><a href="${escapeHtml(settingsUrl)}">Notification settings</a></small></p>`,
  ].join('\n')
  return {
    to: [input.address],
    subject,
    text,
    html,
    headers: { 'List-Unsubscribe': `<${settingsUrl}>`, 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
  }
}
