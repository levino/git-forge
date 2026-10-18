# @git-forge/notifications

Events, notifications, email digests and webhooks. Design and rationale:
[design.md §16](../../docs/design.md#16-notifications-webhooks-email-and-releases).
Tables: `packages/accounts/migrations/0006_notifications.sql`.

## Emitting events

Producers build a `ForgeEvent` with the builders in `src/events.ts` and hand
it to `emit`:

```ts
import { issueCommentEvent, issuesEvent } from '@git-forge/notifications'

const context = { baseUrl: 'https://forge.example.org', repository: { owner, name }, actor: { kind: 'user', id, login } }
await notifications.emit(issuesEvent(context, 'opened', { number: 12, title, body, state: 'open', author: login, createdAt, updatedAt }))
await notifications.emit(issueCommentEvent(context, 'created', issue, { id: 7, body, author: login, createdAt, updatedAt }))
```

| Builder | Webhook event | Notifies |
|---|---|---|
| `pushEvent`, `refEvent` | `push`, `create`, `delete` | watchers (`all`), one thread per ref |
| `issuesEvent` | `issues` | author, assignees, mentions (on `opened`), watchers on open/close/reopen |
| `issueCommentEvent` | `issue_comment` | thread participants, mentions, watchers; the commenter becomes a participant |
| `pullRequestEvent` | `pull_request` | author, assignees, requested reviewers, mentions, watchers on open/close/reopen |
| `pullRequestReviewEvent`, `pullRequestReviewCommentEvent` | `pull_request_review`, `pull_request_review_comment` | participants, mentions, watchers |
| `workflowRunEvent` (`completed`), `workflowJobEvent` | `workflow_run`, `workflow_job` | the triggering user (`ci_activity`) |
| `releaseEvent` (`published`) | `release` | watchers with `all` or `releases` |
| `mirrorAlarmEvent` | `mirror_alarm` (custom) | repository admins (`security_alert`) and watchers |

Payloads are GitHub-compatible minus `repository`, `organization` and
`sender`, which are added when a webhook is delivered. `extractMentions`
finds `@login` outside code and quotes; `pushInfos` turns a `PushOutcome`
into push payloads by reading commits from the object database.

## Runtime

```ts
const notifications = createNotifications({ db, directory: accountsStore, storage, jobs, email, fetch, baseUrl, allowInsecureWebhooks })
await notifications.emit(event)          // stores the event, enqueues fan-out
await notifications.runJob(job)          // notification-event | webhook-delivery | notification-digest
await notifications.sweep()              // cron safety net: stuck deliveries and due digests
```

Without `jobs`, fan-out, deliveries and instant digests run inline.
`handleNotificationsRequest(request, options)` serves the REST API; it
returns `null` for other paths.

## REST API (under `/api/v3`, GitHub-compatible)

| Route | Who |
|---|---|
| `GET /notifications?all=&participating=&since=&before=&per_page=&page=`, `PUT /notifications {last_read_at?}` | the user |
| `GET\|PATCH\|DELETE /notifications/threads/{id}` (read, mark read, mark done) | the user |
| `GET\|PUT\|DELETE /notifications/threads/{id}/subscription {ignored}` | the user |
| `GET\|PUT /repos/{owner}/{repo}/notifications` | the user, read access |
| `GET\|PUT\|DELETE /repos/{owner}/{repo}/subscription {subscribed, ignored, level?}` | the user, read access; `level` (`all`, `releases`, `participating`, `ignore`) is an extension |
| `GET\|PATCH /user/notification-settings {email, email_participating, email_watching, own_activity, email_address}` | the user (not on GitHub) |
| `GET\|POST /repos/{owner}/{repo}/hooks`, `GET\|PATCH\|DELETE …/hooks/{id}`, `GET\|PATCH …/hooks/{id}/config`, `POST …/hooks/{id}/pings`, `GET …/hooks/{id}/deliveries[/{delivery}]`, `POST …/hooks/{id}/deliveries/{delivery}/attempts` | repository admin (token with `repo:admin`) or instance admin |
| the same under `/orgs/{org}/hooks` | organization owner or instance admin |

Hook bodies follow GitHub: `{ name: 'web', config: { url, content_type, secret, insecure_ssl }, events, active }`,
`PATCH` also takes `add_events` and `remove_events`. `events: ['*']`
subscribes to everything.

## Verifying deliveries

```ts
import { verifySignature } from '@git-forge/notifications'
const ok = await verifySignature(secret, rawBody, request.headers.get('X-Hub-Signature-256'))
```

Any GitHub webhook library (e.g. `@octokit/webhooks`) works as well.
