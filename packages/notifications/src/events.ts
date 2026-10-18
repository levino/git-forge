import type { RepositoryName } from '@git-forge/core'

export const EVENT_FORMAT_VERSION = 1

export const WEBHOOK_EVENTS = [
  'push',
  'create',
  'delete',
  'release',
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'pull_request_review_thread',
  'discussion',
  'discussion_comment',
  'workflow_run',
  'workflow_job',
  'check_run',
  'check_suite',
  'status',
  'mirror_alarm',
] as const

export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number]

export const isWebhookEventName = (value: unknown): value is WebhookEventName => typeof value === 'string' && (WEBHOOK_EVENTS as readonly string[]).includes(value)

export type EventActor = {
  readonly kind: 'user' | 'app' | 'instance' | 'system'
  readonly id: string | null
  readonly login: string | null
}

export const SYSTEM_ACTOR: EventActor = { kind: 'system', id: null, login: null }

export type SubjectType = 'Issue' | 'PullRequest' | 'Discussion' | 'Release' | 'Commit' | 'CheckSuite' | 'MirrorAlarm'

export type EventSubject = {
  readonly key: string
  readonly type: SubjectType
  readonly title: string
  readonly url?: string
  readonly htmlUrl?: string
  readonly latestCommentUrl?: string
}

export type NotificationReason =
  | 'review_requested'
  | 'assign'
  | 'mention'
  | 'team_mention'
  | 'author'
  | 'comment'
  | 'state_change'
  | 'ci_activity'
  | 'security_alert'
  | 'manual'
  | 'subscribed'

export type WatchAudience = 'all' | 'releases' | 'none'

export type EventAudience = {
  readonly author?: string | null
  readonly participants?: readonly string[]
  readonly mentions?: readonly string[]
  readonly assignees?: readonly string[]
  readonly reviewRequested?: readonly string[]
  readonly ciActor?: string | null
  readonly repositoryAdmins?: boolean
  readonly watchers?: WatchAudience
}

export type ForgeEvent = {
  readonly v: typeof EVENT_FORMAT_VERSION
  readonly name: WebhookEventName
  readonly action?: string
  readonly repository: RepositoryName
  readonly actor: EventActor
  readonly baseUrl: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly subject?: EventSubject
  readonly audience?: EventAudience
}

export type EventContext = {
  readonly baseUrl: string
  readonly repository: RepositoryName
  readonly actor: EventActor
}

const MENTION = /(?<![A-Za-z0-9_@/.`-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)(?![A-Za-z0-9_@-]|\/[A-Za-z0-9])/g

export const extractMentions = (text: string | null | undefined): string[] => {
  if (!text) return []
  const prose = text
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '')
    .replace(/`[^`\n]*`/g, '')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
  const found = new Map<string, string>()
  for (const match of prose.matchAll(MENTION)) {
    const login = match[1]!
    if (!found.has(login.toLowerCase())) found.set(login.toLowerCase(), login)
  }
  return [...found.values()]
}

export const repoPath = (repo: RepositoryName): string => `${repo.owner}/${repo.name}`

export const apiUrl = (baseUrl: string, path: string): string => `${baseUrl}/api/v3${path}`

export const htmlUrl = (baseUrl: string, path: string): string => `${baseUrl}${path}`

export const userObject = (baseUrl: string, login: string | null, id?: string | null) =>
  login === null
    ? null
    : {
        login,
        ...(id ? { id } : {}),
        type: 'User',
        url: apiUrl(baseUrl, `/users/${login}`),
        html_url: htmlUrl(baseUrl, `/${login}`),
      }

const iso = (value: string | number | Date | null | undefined): string | null =>
  value === null || value === undefined ? null : new Date(value).toISOString()

export type IssueInfo = {
  readonly number: number
  readonly title: string
  readonly body?: string | null
  readonly state: 'open' | 'closed'
  readonly author: string
  readonly labels?: readonly string[]
  readonly assignees?: readonly string[]
  readonly createdAt: string | number
  readonly updatedAt: string | number
  readonly closedAt?: string | number | null
  readonly stateReason?: string | null
}

export type PullRequestInfo = IssueInfo & {
  readonly head: { readonly ref: string; readonly sha: string }
  readonly base: { readonly ref: string; readonly sha: string }
  readonly draft?: boolean
  readonly merged?: boolean
  readonly mergedAt?: string | number | null
  readonly mergeCommitSha?: string | null
  readonly requestedReviewers?: readonly string[]
}

export type CommentInfo = {
  readonly id: number
  readonly body: string
  readonly author: string
  readonly createdAt: string | number
  readonly updatedAt: string | number
}

export type ReviewInfo = {
  readonly id: number
  readonly state: 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending'
  readonly body?: string | null
  readonly author: string
  readonly commitId: string
  readonly submittedAt: string | number | null
}

export type ReviewCommentInfo = CommentInfo & {
  readonly path: string
  readonly line?: number | null
  readonly commitId: string
  readonly diffHunk?: string
  readonly inReplyToId?: number | null
}

const issueObject = (context: EventContext, issue: IssueInfo, kind: 'issues' | 'pull') => {
  const path = repoPath(context.repository)
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? null,
    state: issue.state,
    state_reason: issue.stateReason ?? null,
    user: userObject(context.baseUrl, issue.author),
    labels: (issue.labels ?? []).map((name) => ({ name })),
    assignees: (issue.assignees ?? []).map((login) => userObject(context.baseUrl, login)),
    assignee: issue.assignees?.[0] ? userObject(context.baseUrl, issue.assignees[0]) : null,
    created_at: iso(issue.createdAt),
    updated_at: iso(issue.updatedAt),
    closed_at: iso(issue.closedAt),
    url: apiUrl(context.baseUrl, `/repos/${path}/${kind === 'pull' ? 'pulls' : 'issues'}/${issue.number}`),
    html_url: htmlUrl(context.baseUrl, `/${path}/${kind}/${issue.number}`),
    comments_url: apiUrl(context.baseUrl, `/repos/${path}/issues/${issue.number}/comments`),
  }
}

const pullRequestObject = (context: EventContext, pr: PullRequestInfo) => ({
  ...issueObject(context, pr, 'pull'),
  draft: pr.draft ?? false,
  merged: pr.merged ?? false,
  merged_at: iso(pr.mergedAt),
  merge_commit_sha: pr.mergeCommitSha ?? null,
  requested_reviewers: (pr.requestedReviewers ?? []).map((login) => userObject(context.baseUrl, login)),
  head: { ref: pr.head.ref, sha: pr.head.sha, label: `${context.repository.owner}:${pr.head.ref}` },
  base: { ref: pr.base.ref, sha: pr.base.sha, label: `${context.repository.owner}:${pr.base.ref}` },
})

const commentObject = (context: EventContext, comment: CommentInfo, htmlPath: string, apiPath: string) => ({
  id: comment.id,
  body: comment.body,
  user: userObject(context.baseUrl, comment.author),
  created_at: iso(comment.createdAt),
  updated_at: iso(comment.updatedAt),
  url: apiUrl(context.baseUrl, apiPath),
  html_url: htmlUrl(context.baseUrl, htmlPath),
})

const unique = (values: readonly (string | null | undefined)[]): string[] => {
  const seen = new Map<string, string>()
  for (const value of values) if (value && !seen.has(value.toLowerCase())) seen.set(value.toLowerCase(), value)
  return [...seen.values()]
}

const event = (context: EventContext, name: WebhookEventName, action: string | undefined, payload: Record<string, unknown>, extra: Pick<ForgeEvent, 'subject' | 'audience'> = {}): ForgeEvent => ({
  v: EVENT_FORMAT_VERSION,
  name,
  ...(action !== undefined ? { action } : {}),
  repository: context.repository,
  actor: context.actor,
  baseUrl: context.baseUrl,
  payload: action !== undefined ? { action, ...payload } : payload,
  ...extra,
})

const issueSubject = (context: EventContext, issue: IssueInfo, type: 'Issue' | 'PullRequest', latestCommentUrl?: string): EventSubject => {
  const path = repoPath(context.repository)
  const segment = type === 'Issue' ? 'issues' : 'pulls'
  return {
    key: `${type === 'Issue' ? 'issue' : 'pull'}:${issue.number}`,
    type,
    title: issue.title,
    url: apiUrl(context.baseUrl, `/repos/${path}/${segment}/${issue.number}`),
    htmlUrl: htmlUrl(context.baseUrl, `/${path}/${type === 'Issue' ? 'issues' : 'pull'}/${issue.number}`),
    ...(latestCommentUrl ? { latestCommentUrl } : {}),
  }
}

export type IssuesAction = 'opened' | 'edited' | 'closed' | 'reopened' | 'assigned' | 'unassigned' | 'labeled' | 'unlabeled' | 'deleted' | 'transferred' | 'locked' | 'unlocked'

export const issuesEvent = (context: EventContext, action: IssuesAction, issue: IssueInfo, changes?: Record<string, unknown>): ForgeEvent =>
  event(context, 'issues', action, { issue: issueObject(context, issue, 'issues'), ...(changes ? { changes } : {}) }, {
    subject: issueSubject(context, issue, 'Issue'),
    audience: {
      author: issue.author,
      assignees: action === 'opened' || action === 'assigned' ? (issue.assignees ?? []) : [],
      mentions: action === 'opened' ? extractMentions(issue.body) : [],
      watchers: action === 'opened' || action === 'closed' || action === 'reopened' ? 'all' : 'none',
    },
  })

export type CommentAction = 'created' | 'edited' | 'deleted'

export const issueCommentEvent = (context: EventContext, action: CommentAction, issue: IssueInfo | PullRequestInfo, comment: CommentInfo, isPullRequest = false): ForgeEvent => {
  const path = repoPath(context.repository)
  const apiPath = `/repos/${path}/issues/comments/${comment.id}`
  const htmlPath = `/${path}/${isPullRequest ? 'pull' : 'issues'}/${issue.number}#issuecomment-${comment.id}`
  const issuePayload = isPullRequest ? { ...issueObject(context, issue, 'pull'), pull_request: { url: apiUrl(context.baseUrl, `/repos/${path}/pulls/${issue.number}`) } } : issueObject(context, issue, 'issues')
  return event(context, 'issue_comment', action, { issue: issuePayload, comment: commentObject(context, comment, htmlPath, apiPath) }, {
    subject: issueSubject(context, issue, isPullRequest ? 'PullRequest' : 'Issue', apiUrl(context.baseUrl, apiPath)),
    audience:
      action === 'created'
        ? { participants: [comment.author], mentions: extractMentions(comment.body), watchers: 'all' }
        : { watchers: 'none', mentions: action === 'edited' ? extractMentions(comment.body) : [] },
  })
}

export type PullRequestAction =
  | 'opened'
  | 'edited'
  | 'closed'
  | 'reopened'
  | 'synchronize'
  | 'assigned'
  | 'unassigned'
  | 'review_requested'
  | 'review_request_removed'
  | 'labeled'
  | 'unlabeled'
  | 'ready_for_review'
  | 'converted_to_draft'

export const pullRequestEvent = (
  context: EventContext,
  action: PullRequestAction,
  pullRequest: PullRequestInfo,
  options: { readonly requestedReviewer?: string; readonly before?: string; readonly after?: string; readonly changes?: Record<string, unknown> } = {},
): ForgeEvent =>
  event(
    context,
    'pull_request',
    action,
    {
      number: pullRequest.number,
      pull_request: pullRequestObject(context, pullRequest),
      ...(options.requestedReviewer ? { requested_reviewer: userObject(context.baseUrl, options.requestedReviewer) } : {}),
      ...(options.before ? { before: options.before } : {}),
      ...(options.after ? { after: options.after } : {}),
      ...(options.changes ? { changes: options.changes } : {}),
    },
    {
      subject: issueSubject(context, pullRequest, 'PullRequest'),
      audience: {
        author: pullRequest.author,
        assignees: action === 'opened' || action === 'assigned' ? (pullRequest.assignees ?? []) : [],
        reviewRequested:
          action === 'review_requested' ? unique([options.requestedReviewer]) : action === 'opened' ? (pullRequest.requestedReviewers ?? []) : [],
        mentions: action === 'opened' ? extractMentions(pullRequest.body) : [],
        watchers: action === 'opened' || action === 'closed' || action === 'reopened' ? 'all' : 'none',
      },
    },
  )

export type ReviewAction = 'submitted' | 'edited' | 'dismissed'

export const pullRequestReviewEvent = (context: EventContext, action: ReviewAction, pullRequest: PullRequestInfo, review: ReviewInfo): ForgeEvent => {
  const path = repoPath(context.repository)
  return event(
    context,
    'pull_request_review',
    action,
    {
      pull_request: pullRequestObject(context, pullRequest),
      review: {
        id: review.id,
        state: review.state,
        body: review.body ?? null,
        user: userObject(context.baseUrl, review.author),
        commit_id: review.commitId,
        submitted_at: iso(review.submittedAt),
        html_url: htmlUrl(context.baseUrl, `/${path}/pull/${pullRequest.number}#pullrequestreview-${review.id}`),
      },
    },
    {
      subject: issueSubject(context, pullRequest, 'PullRequest'),
      audience: action === 'submitted' ? { participants: [review.author], mentions: extractMentions(review.body), watchers: 'all' } : { watchers: 'none' },
    },
  )
}

export const pullRequestReviewCommentEvent = (context: EventContext, action: CommentAction, pullRequest: PullRequestInfo, comment: ReviewCommentInfo): ForgeEvent => {
  const path = repoPath(context.repository)
  const apiPath = `/repos/${path}/pulls/comments/${comment.id}`
  return event(
    context,
    'pull_request_review_comment',
    action,
    {
      pull_request: pullRequestObject(context, pullRequest),
      comment: {
        ...commentObject(context, comment, `/${path}/pull/${pullRequest.number}#discussion_r${comment.id}`, apiPath),
        path: comment.path,
        line: comment.line ?? null,
        commit_id: comment.commitId,
        diff_hunk: comment.diffHunk ?? '',
        in_reply_to_id: comment.inReplyToId ?? undefined,
      },
    },
    {
      subject: issueSubject(context, pullRequest, 'PullRequest', apiUrl(context.baseUrl, apiPath)),
      audience: action === 'created' ? { participants: [comment.author], mentions: extractMentions(comment.body), watchers: 'all' } : { watchers: 'none' },
    },
  )
}

export type PushCommit = {
  readonly id: string
  readonly message: string
  readonly timestamp: string
  readonly author: { readonly name: string; readonly email: string }
  readonly committer: { readonly name: string; readonly email: string }
  readonly distinct?: boolean
}

export type PushInfo = {
  readonly ref: string
  readonly before: string
  readonly after: string
  readonly forced: boolean
  readonly commits: readonly PushCommit[]
  readonly pusher: { readonly name: string; readonly email: string | null }
}

const ZERO = '0000000000000000000000000000000000000000'

export const MAX_PUSH_COMMITS = 20

export const pushEvent = (context: EventContext, push: PushInfo): ForgeEvent => {
  const path = repoPath(context.repository)
  const created = push.before === ZERO
  const deleted = push.after === ZERO
  const commitObject = (commit: PushCommit) => ({
    id: commit.id,
    distinct: commit.distinct ?? true,
    message: commit.message,
    timestamp: commit.timestamp,
    url: htmlUrl(context.baseUrl, `/${path}/commit/${commit.id}`),
    author: { name: commit.author.name, email: commit.author.email },
    committer: { name: commit.committer.name, email: commit.committer.email },
    added: [],
    removed: [],
    modified: [],
  })
  const commits = push.commits.slice(0, MAX_PUSH_COMMITS).map(commitObject)
  const head = push.commits.find((commit) => commit.id === push.after)
  const short = push.ref.replace(/^refs\/(heads|tags)\//, '')
  return event(
    context,
    'push',
    undefined,
    {
      ref: push.ref,
      before: push.before,
      after: push.after,
      created,
      deleted,
      forced: push.forced,
      base_ref: null,
      compare: htmlUrl(context.baseUrl, created || deleted ? `/${path}/commit/${push.after}` : `/${path}/compare/${push.before.slice(0, 12)}...${push.after.slice(0, 12)}`),
      commits,
      head_commit: head ? commitObject(head) : null,
      pusher: { name: push.pusher.name, email: push.pusher.email },
    },
    {
      subject: {
        key: `push:${push.ref}`,
        type: 'Commit',
        title: deleted ? `${short} was deleted` : `${push.commits.length === 1 ? '1 new commit' : `${push.commits.length} new commits`} on ${short}${push.forced ? ' (force push)' : ''}`,
        htmlUrl: htmlUrl(context.baseUrl, deleted ? `/${path}` : `/${path}/commit/${push.after}`),
      },
      audience: { watchers: 'all' },
    },
  )
}

export type MirrorAlarmInfo = {
  readonly remote: string
  readonly upstream: string
  readonly alarms: readonly {
    readonly kind: 'history-rewritten' | 'ref-deleted'
    readonly ref: string
    readonly localRef: string
    readonly oldId: string
    readonly newId: string | null
    readonly archivedAs: string
    readonly at: string
  }[]
}

export const mirrorAlarmEvent = (context: EventContext, info: MirrorAlarmInfo): ForgeEvent => {
  const path = repoPath(context.repository)
  const rewritten = info.alarms.filter((alarm) => alarm.kind === 'history-rewritten').length
  const deleted = info.alarms.length - rewritten
  const parts = [rewritten > 0 ? `${rewritten} rewritten` : null, deleted > 0 ? `${deleted} deleted` : null].filter(Boolean).join(', ')
  return event(
    context,
    'mirror_alarm',
    'raised',
    {
      remote: info.remote,
      upstream: info.upstream,
      alarms: info.alarms.map((alarm) => ({
        kind: alarm.kind,
        ref: alarm.ref,
        local_ref: alarm.localRef,
        old_id: alarm.oldId,
        new_id: alarm.newId,
        archived_as: alarm.archivedAs,
        at: alarm.at,
      })),
    },
    {
      subject: {
        key: `mirror:${info.remote}`,
        type: 'MirrorAlarm',
        title: `Upstream ${info.remote} rewrote history (${parts})`,
        url: apiUrl(context.baseUrl, `/repos/${path}/mirrors`),
        htmlUrl: htmlUrl(context.baseUrl, `/${path}/settings/mirrors`),
      },
      audience: { repositoryAdmins: true, watchers: 'all' },
    },
  )
}

export type WorkflowRunInfo = {
  readonly id: number
  readonly name: string
  readonly path: string
  readonly runNumber?: number
  readonly event: string
  readonly status: 'queued' | 'in_progress' | 'completed'
  readonly conclusion: string | null
  readonly headBranch: string | null
  readonly headSha: string
  readonly actor: string | null
  readonly createdAt: string | number
  readonly updatedAt: string | number
}

export type WorkflowRunAction = 'requested' | 'in_progress' | 'completed'

export const workflowRunEvent = (context: EventContext, action: WorkflowRunAction, run: WorkflowRunInfo): ForgeEvent => {
  const path = repoPath(context.repository)
  const failed = run.conclusion !== null && run.conclusion !== 'success' && run.conclusion !== 'skipped' && run.conclusion !== 'neutral'
  return event(
    context,
    'workflow_run',
    action,
    {
      workflow_run: {
        id: run.id,
        name: run.name,
        path: run.path,
        run_number: run.runNumber ?? run.id,
        event: run.event,
        status: run.status,
        conclusion: run.conclusion,
        head_branch: run.headBranch,
        head_sha: run.headSha,
        actor: userObject(context.baseUrl, run.actor),
        triggering_actor: userObject(context.baseUrl, run.actor),
        created_at: iso(run.createdAt),
        updated_at: iso(run.updatedAt),
        url: apiUrl(context.baseUrl, `/repos/${path}/actions/runs/${run.id}`),
        html_url: htmlUrl(context.baseUrl, `/${path}/actions/runs/${run.id}`),
      },
      workflow: { name: run.name, path: run.path },
    },
    action === 'completed'
      ? {
          subject: {
            key: `ci:${run.id}`,
            type: 'CheckSuite',
            title: `${run.name} workflow run ${failed ? 'failed' : 'succeeded'} for ${run.headBranch ?? run.headSha.slice(0, 7)}`,
            url: apiUrl(context.baseUrl, `/repos/${path}/actions/runs/${run.id}`),
            htmlUrl: htmlUrl(context.baseUrl, `/${path}/actions/runs/${run.id}`),
          },
          audience: { ciActor: run.actor, watchers: 'none' },
        }
      : {},
  )
}

export const workflowJobEvent = (context: EventContext, payload: { readonly action: 'queued' | 'in_progress' | 'completed'; readonly workflow_job: Record<string, unknown> }): ForgeEvent =>
  event(context, 'workflow_job', payload.action, { workflow_job: payload.workflow_job })

export type ReleaseAction = 'created' | 'published' | 'edited' | 'deleted' | 'prereleased' | 'released' | 'unpublished'

export const releaseEvent = (
  context: EventContext,
  action: ReleaseAction,
  release: { readonly id: number; readonly tag_name: string; readonly name: string | null; readonly html_url: string; readonly url: string; readonly prerelease: boolean } & Record<string, unknown>,
): ForgeEvent =>
  event(
    context,
    'release',
    action,
    { release },
    action === 'published'
      ? {
          subject: { key: `release:${release.id}`, type: 'Release', title: release.name || release.tag_name, url: release.url, htmlUrl: release.html_url },
          audience: { watchers: 'releases' },
        }
      : {},
  )

export const refEvent = (context: EventContext, name: 'create' | 'delete', ref: string): ForgeEvent => {
  const tag = ref.startsWith('refs/tags/')
  return event(context, name, undefined, { ref: ref.replace(/^refs\/(heads|tags)\//, ''), ref_type: tag ? 'tag' : 'branch', pusher_type: 'user' })
}
