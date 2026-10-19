import { authenticateRequest, type InstanceVerifier, type Principal, type RepositoryDirectory } from '@git-forge/accounts'
import { isValidName, MAX_WEB_FILE_BYTES, readAll, SizeLimitError } from '@git-forge/core'
import { type ContentItem, deleteContents, getContents, putContents } from './contents.ts'
import { createReaction, deleteReaction, listReactions, type ReactionKind, type ReactionSubject } from './reactions.ts'
import { CollaborationError, type CollaborationOptions, invalid, openRepository, type Scope, scopeOptions } from './context.ts'
import { createFork, forkInfo, forkNetwork, listForks } from './forks.ts'
import { DEFAULT_SETTINGS } from './permissions.ts'
import {
  createCategory,
  createDiscussion,
  createDiscussionComment,
  deleteCategory,
  deleteDiscussionComment,
  getCategory,
  getDiscussion,
  getDiscussionComment,
  listCategories,
  listDiscussionComments,
  listDiscussions,
  setAnswer,
  setDiscussionLocked,
  updateCategory,
  updateDiscussion,
  updateDiscussionComment,
} from './discussions.ts'
import { currentRefs, defaultBranch, objectDatabase, resolveCommitish } from './git.ts'
import { loadCodeOwners } from './owners.ts'
import {
  changeAssignees,
  changeIssueLabels,
  createComment,
  createIssue,
  createLabel,
  createMilestone,
  deleteComment,
  deleteLabel,
  deleteMilestone,
  getComment,
  getIssue,
  getLabel,
  getMilestone,
  type IssueFilters,
  listComments,
  listEvents,
  listIssueLabels,
  listIssues,
  listLabels,
  listMilestones,
  type Page,
  type Paged,
  setLocked,
  updateComment,
  updateIssue,
  updateLabel,
  updateMilestone,
} from './issues.ts'
import { createPull, getPull, listPulls, mergePull, pullCodeOwners, pullCommits, pullDiff, pullFiles, updatePull } from './pulls.ts'
import {
  categoryJson,
  checkRunJson,
  combinedStatusJson,
  commentJson,
  contentCommitJson,
  contentJson,
  commitJson,
  discussionCommentJson,
  discussionJson,
  eventJson,
  fileJson,
  issueJson,
  labelJson,
  milestoneJson,
  pullJson,
  reactionJson,
  repositoryJson,
  reviewCommentJson,
  reviewJson,
  statusJson,
  type Urls,
  userJson,
} from './render.ts'
import {
  changeRequestedReviewers,
  createReview,
  createReviewComment,
  deletePendingReview,
  deleteReviewComment,
  dismissReview,
  getReview,
  getReviewComment,
  listRequestedReviewers,
  listReviewComments,
  listReviews,
  submitReview,
  updateReviewBody,
  updateReviewComment,
} from './reviews.ts'
import { rolePermissions, updateSettings } from './settings.ts'
import { combinedStatus, createCheckRun, createStatus, getCheckRun, listCheckRuns, listStatuses, updateCheckRun } from './statuses.ts'
import { timeline } from './timeline.ts'

export type CollaborationApiOptions = CollaborationOptions & {
  readonly verifyInstance?: InstanceVerifier
  readonly authenticate?: (request: Request) => Promise<Principal | null>
  readonly prefix?: string
  readonly publicUrl?: string
}

type Body = Record<string, unknown>

type Context = {
  readonly scope: Scope
  readonly url: URL
  readonly urls: Urls
  readonly body: Body
  readonly request: Request
  readonly params: readonly string[]
}

type Handler = (context: Context) => Promise<Response>

type Route = { readonly method: string; readonly pattern: RegExp; readonly handler: Handler; readonly body?: boolean; readonly maxBody?: number }

const GHES_VERSION = '3.14.0'

const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-GitHub-Media-Type': 'github.v3', 'X-GitHub-Enterprise-Version': GHES_VERSION }

const json = (status: number, body: unknown, extra: Record<string, string> = {}): Response =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { ...headers, ...extra } })

const errorResponse = (status: number, message: string, errors: readonly unknown[] = [], extra: Record<string, string> = {}) =>
  json(status, { message, ...(errors.length > 0 ? { errors } : {}), documentation_url: 'https://docs.github.com/rest' }, extra)

const MAX_BODY_BYTES = 1024 * 1024

const readBody = async (request: Request, limit = MAX_BODY_BYTES): Promise<Body> => {
  if (!request.body) return {}
  let bytes: Uint8Array
  try {
    bytes = await readAll(request.body, limit)
  } catch (error) {
    if (error instanceof SizeLimitError) throw new CollaborationError(422, 'request body too large')
    throw error
  }
  if (bytes.length === 0) return {}
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new CollaborationError(400, 'Problems parsing JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CollaborationError(400, 'Body should be a JSON object')
  return value as Body
}

const pageOf = (url: URL): Page => {
  const page = Number(url.searchParams.get('page') ?? '1')
  const perPage = Number(url.searchParams.get('per_page') ?? '30')
  return {
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    perPage: Number.isSafeInteger(perPage) && perPage > 0 ? Math.min(perPage, 100) : 30,
  }
}

const linkHeader = (url: URL, page: Page, total: number): Record<string, string> => {
  const last = Math.max(1, Math.ceil(total / page.perPage))
  const link = (target: number, rel: string) => {
    const next = new URL(url)
    next.searchParams.set('page', String(target))
    next.searchParams.set('per_page', String(page.perPage))
    return `<${next.toString()}>; rel="${rel}"`
  }
  const parts: string[] = []
  if (page.page < last) parts.push(link(page.page + 1, 'next'), link(last, 'last'))
  if (page.page > 1) parts.push(link(1, 'first'), link(page.page - 1, 'prev'))
  return parts.length > 0 ? { Link: parts.join(', ') } : {}
}

const paged = <T>(context: Context, result: Paged<T>, render: (item: T) => unknown): Response => {
  const page = pageOf(context.url)
  return json(200, result.items.map(render), linkHeader(context.url, page, result.total))
}

const sliced = <T>(context: Context, items: readonly T[], render: (item: T) => unknown): Response => {
  const page = pageOf(context.url)
  const start = (page.page - 1) * page.perPage
  return json(200, items.slice(start, start + page.perPage).map(render), linkHeader(context.url, page, items.length))
}

const int = (value: string): number => {
  if (!/^\d{1,15}$/.test(value)) throw new CollaborationError(404, 'Not Found')
  return Number(value)
}

const strings = (body: Body, key: string): string[] | undefined => {
  const value = body[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw invalid(`${key} must be an array`)
  return value.map((entry) => {
    if (typeof entry === 'string') return entry
    if (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string') return (entry as { name: string }).name
    throw invalid(`${key} must be an array of strings`)
  })
}

const labelNames = (body: Body): string[] => {
  if (Array.isArray((body as { labels?: unknown }).labels)) return strings(body, 'labels')!
  if (Array.isArray(body)) return body as string[]
  return []
}

const time = (value: string | null): number | undefined => {
  if (value === null) return undefined
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) throw invalid('since must be an ISO 8601 timestamp')
  return parsed
}

const choice = <T extends string>(value: string | null, allowed: readonly T[]): T | undefined => (value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : undefined)

const wantsDiff = (request: Request): 'diff' | 'patch' | null => {
  const accept = request.headers.get('Accept') ?? ''
  if (/application\/vnd\.github(\.v3)?\.diff/.test(accept)) return 'diff'
  if (/application\/vnd\.github(\.v3)?\.patch/.test(accept)) return 'patch'
  return null
}

const issueFilters = (url: URL, kind: NonNullable<IssueFilters['kind']>): IssueFilters => {
  const params = url.searchParams
  const labels = params.get('labels')
  return {
    kind,
    ...(choice(params.get('state'), ['open', 'closed', 'all'] as const) ? { state: choice(params.get('state'), ['open', 'closed', 'all'] as const)! } : {}),
    ...(labels ? { labels: labels.split(',').map((label) => label.trim()).filter(Boolean) } : {}),
    ...(params.get('assignee') !== null ? { assignee: params.get('assignee')! } : {}),
    ...(params.get('creator') !== null ? { creator: params.get('creator')! } : {}),
    ...(params.get('milestone') !== null ? { milestone: params.get('milestone')! } : {}),
    ...(time(params.get('since')) !== undefined ? { since: time(params.get('since'))! } : {}),
    ...(choice(params.get('sort'), ['created', 'updated', 'comments'] as const) ? { sort: choice(params.get('sort'), ['created', 'updated', 'comments'] as const)! } : {}),
    ...(choice(params.get('direction'), ['asc', 'desc'] as const) ? { direction: choice(params.get('direction'), ['asc', 'desc'] as const)! } : {}),
  }
}

const issueResponse = async (context: Context, number: number, status = 200): Promise<Response> => {
  const issue = await getIssue(context.scope, number)
  if (!issue.isPull) return json(status, issueJson(context.urls, context.scope.repository, issue))
  const pull = await getPull(context.scope, number)
  return json(status, issueJson(context.urls, context.scope.repository, issue, pull))
}

const pullResponse = async (context: Context, number: number, status = 200): Promise<Response> => {
  const format = wantsDiff(context.request)
  if (format) return new Response(await pullDiff(context.scope, number), { status: 200, headers: { 'Content-Type': `text/x-${format}; charset=utf-8`, 'Cache-Control': 'no-store' } })
  const pull = await getPull(context.scope, number)
  const comments = (await listReviewComments(context.scope, number)).length
  return json(status, pullJson(context.urls, context.scope.repository, pull, comments))
}

const NO_PERMISSIONS = { admin: false, maintain: false, push: false, triage: false, pull: true }

const repositoryResponse = async (context: Context, status = 200): Promise<Response> => {
  const { scope } = context
  let branch = 'main'
  try {
    branch = defaultBranch(await currentRefs(scope))
  } catch {}
  const fork = await forkInfo(scope)
  return json(status, {
    ...repositoryJson(context.urls, scope.repository, scope.settings, rolePermissions(scope), branch),
    fork: (await scope.accounts.forkInfo(scope.repository.id)) !== null,
    ...(fork
      ? {
          parent: repositoryJson(context.urls, fork.parent, DEFAULT_SETTINGS, NO_PERMISSIONS, ''),
          source: repositoryJson(context.urls, fork.source, DEFAULT_SETTINGS, NO_PERMISSIONS, ''),
        }
      : {}),
  })
}

const SETTINGS_FIELDS: Readonly<Record<string, string>> = {
  has_issues: 'hasIssues',
  has_discussions: 'hasDiscussions',
  read_can_participate: 'readCanParticipate',
  allow_merge_commit: 'allowMergeCommit',
  allow_squash_merge: 'allowSquashMerge',
  allow_rebase_merge: 'allowRebaseMerge',
}

const reactionRoutes = (kind: ReactionKind, prefix: string): Route[] => {
  const subject = (context: Context): ReactionSubject => ({ kind, id: int(context.params[0]!) })
  return [
    { method: 'GET', pattern: new RegExp(`^${prefix}/reactions$`), handler: async (context) => sliced(context, await listReactions(context.scope, subject(context), context.url.searchParams.get('content')), (reaction) => reactionJson(context.urls, reaction)) },
    {
      method: 'POST',
      pattern: new RegExp(`^${prefix}/reactions$`),
      body: true,
      handler: async (context) => {
        const { reaction, created } = await createReaction(context.scope, subject(context), context.body.content)
        return json(created ? 201 : 200, reactionJson(context.urls, reaction))
      },
    },
    {
      method: 'DELETE',
      pattern: new RegExp(`^${prefix}/reactions/(\\d+)$`),
      handler: async (context) => {
        await deleteReaction(context.scope, subject(context), int(context.params[1]!))
        return json(204, null)
      },
    },
  ]
}

const CONTENTS_BODY_BYTES = Math.ceil((MAX_WEB_FILE_BYTES * 4) / 3) + 64 * 1024

const routes: readonly Route[] = [
  { method: 'GET', pattern: /^$/, handler: repositoryResponse },
  ...reactionRoutes('issue', '/issues/(\\d+)'),
  ...reactionRoutes('issue_comment', '/issues/comments/(\\d+)'),
  ...reactionRoutes('review_comment', '/pulls/comments/(\\d+)'),
  {
    method: 'GET',
    pattern: /^\/contents(?:\/(.*))?$/,
    handler: async (context) => {
      const { ref, item } = await getContents(context.scope, context.params[0] ?? '', context.url.searchParams.get('ref'))
      return json(200, Array.isArray(item) ? item.map((entry) => contentJson(context.urls, context.scope.repository, ref, entry)) : contentJson(context.urls, context.scope.repository, ref, item as ContentItem))
    },
  },
  {
    method: 'PUT',
    pattern: /^\/contents\/(.+)$/,
    body: true,
    maxBody: CONTENTS_BODY_BYTES,
    handler: async (context) => {
      const { outcome, item, created } = await putContents(context.scope, context.params[0]!, context.body)
      return json(created ? 201 : 200, { content: contentJson(context.urls, context.scope.repository, outcome.branch, item), commit: contentCommitJson(context.urls, context.scope.repository, outcome) })
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/contents\/(.+)$/,
    body: true,
    handler: async (context) => json(200, { content: null, commit: contentCommitJson(context.urls, context.scope.repository, await deleteContents(context.scope, context.params[0]!, context.body)) }),
  },
  {
    method: 'PATCH',
    pattern: /^$/,
    body: true,
    handler: async (context) => {
      const input = Object.fromEntries(Object.entries(SETTINGS_FIELDS).filter(([field]) => context.body[field] !== undefined).map(([field, key]) => [key, context.body[field]]))
      const unknown = Object.keys(context.body).filter((field) => !(field in SETTINGS_FIELDS))
      if (unknown.length > 0) throw invalid(`unsupported fields: ${unknown.join(', ')}`)
      const settings = await updateSettings(context.scope, input)
      const scope = { ...context.scope, settings }
      return repositoryResponse({ ...context, scope })
    },
  },
  {
    method: 'GET',
    pattern: /^\/forks$/,
    handler: async (context) => sliced(context, await listForks(context.scope), (repository) => repositoryJson(context.urls, repository, DEFAULT_SETTINGS, NO_PERMISSIONS, '')),
  },
  {
    method: 'POST',
    pattern: /^\/forks$/,
    body: true,
    handler: async (context) => {
      const fork = await createFork(context.scope, { organization: context.body.organization, name: context.body.name, defaultBranchOnly: context.body.default_branch_only })
      const scope = await openRepository(scopeOptions(context.scope), context.scope.actor.principal, fork.owner, fork.name)
      return repositoryResponse({ ...context, scope }, 202)
    },
  },
  {
    method: 'GET',
    pattern: /^\/network$/,
    handler: async (context) => {
      const network = await forkNetwork(context.scope)
      return json(200, {
        root: network.root ? repositoryJson(context.urls, network.root, DEFAULT_SETTINGS, NO_PERMISSIONS, '') : null,
        forks: network.forks.map((fork) => ({ ...repositoryJson(context.urls, fork, DEFAULT_SETTINGS, NO_PERMISSIONS, ''), parent_id: fork.parentId })),
      })
    },
  },
  { method: 'GET', pattern: /^\/issues$/, handler: async (context) => paged(context, await listIssues(context.scope, issueFilters(context.url, 'all'), pageOf(context.url)), (issue) => issueJson(context.urls, context.scope.repository, issue)) },
  {
    method: 'POST',
    pattern: /^\/issues$/,
    body: true,
    handler: async (context) => {
      const labels = strings(context.body, 'labels')
      const assignees = strings(context.body, 'assignees') ?? (typeof context.body.assignee === 'string' ? [context.body.assignee] : undefined)
      const issue = await createIssue(context.scope, {
        title: context.body.title,
        body: context.body.body,
        ...(labels ? { labels } : {}),
        ...(assignees ? { assignees } : {}),
        ...(context.body.milestone !== undefined ? { milestone: context.body.milestone } : {}),
      })
      return json(201, issueJson(context.urls, context.scope.repository, issue), { Location: `${context.urls.api}/repos/${context.scope.repo.owner}/${context.scope.repo.name}/issues/${issue.number}` })
    },
  },
  { method: 'GET', pattern: /^\/issues\/comments$/, handler: async (context) => paged(context, await listComments(context.scope, null, { ...(time(context.url.searchParams.get('since')) !== undefined ? { since: time(context.url.searchParams.get('since'))! } : {}) }, pageOf(context.url)), (comment) => commentJson(context.urls, context.scope.repository, comment)) },
  { method: 'GET', pattern: /^\/issues\/comments\/(\d+)$/, handler: async (context) => json(200, commentJson(context.urls, context.scope.repository, await getComment(context.scope, int(context.params[0]!)))) },
  { method: 'PATCH', pattern: /^\/issues\/comments\/(\d+)$/, body: true, handler: async (context) => json(200, commentJson(context.urls, context.scope.repository, await updateComment(context.scope, int(context.params[0]!), context.body.body))) },
  {
    method: 'DELETE',
    pattern: /^\/issues\/comments\/(\d+)$/,
    handler: async (context) => {
      await deleteComment(context.scope, int(context.params[0]!))
      return json(204, null)
    },
  },
  { method: 'GET', pattern: /^\/issues\/(\d+)$/, handler: (context) => issueResponse(context, int(context.params[0]!)) },
  {
    method: 'PATCH',
    pattern: /^\/issues\/(\d+)$/,
    body: true,
    handler: async (context) => {
      const labels = strings(context.body, 'labels')
      const assignees = strings(context.body, 'assignees') ?? (context.body.assignee === null ? [] : typeof context.body.assignee === 'string' ? [context.body.assignee] : undefined)
      await updateIssue(context.scope, int(context.params[0]!), {
        ...(context.body.title !== undefined ? { title: context.body.title } : {}),
        ...(context.body.body !== undefined ? { body: context.body.body } : {}),
        ...(context.body.state !== undefined ? { state: context.body.state } : {}),
        ...(context.body.state_reason !== undefined ? { stateReason: context.body.state_reason } : {}),
        ...(labels ? { labels } : {}),
        ...(assignees ? { assignees } : {}),
        ...(context.body.milestone !== undefined ? { milestone: context.body.milestone } : {}),
      })
      return issueResponse(context, int(context.params[0]!))
    },
  },
  { method: 'GET', pattern: /^\/issues\/(\d+)\/comments$/, handler: async (context) => paged(context, await listComments(context.scope, int(context.params[0]!), { ...(time(context.url.searchParams.get('since')) !== undefined ? { since: time(context.url.searchParams.get('since'))! } : {}) }, pageOf(context.url)), (comment) => commentJson(context.urls, context.scope.repository, comment)) },
  { method: 'POST', pattern: /^\/issues\/(\d+)\/comments$/, body: true, handler: async (context) => json(201, commentJson(context.urls, context.scope.repository, await createComment(context.scope, int(context.params[0]!), context.body.body))) },
  { method: 'GET', pattern: /^\/issues\/(\d+)\/events$/, handler: async (context) => sliced(context, await listEvents(context.scope, int(context.params[0]!)), (event) => eventJson(context.urls, context.scope.repository, event)) },
  {
    method: 'GET',
    pattern: /^\/issues\/(\d+)\/timeline$/,
    handler: async (context) =>
      sliced(context, await timeline(context.scope, int(context.params[0]!)), (item) => {
        const { urls } = context
        const repository = context.scope.repository
        if (item.kind === 'event') return eventJson(urls, repository, item.event)
        if (item.kind === 'comment') return { ...commentJson(urls, repository, item.comment), event: 'commented', actor: userJson(urls, item.comment.author) }
        return { ...reviewJson(urls, repository, item.review), event: 'reviewed', actor: userJson(urls, item.review.author) }
      }),
  },
  { method: 'GET', pattern: /^\/issues\/(\d+)\/labels$/, handler: async (context) => sliced(context, await listIssueLabels(context.scope, int(context.params[0]!)), (label) => labelJson(context.urls, context.scope.repository, label)) },
  { method: 'POST', pattern: /^\/issues\/(\d+)\/labels$/, body: true, handler: async (context) => json(200, (await changeIssueLabels(context.scope, int(context.params[0]!), labelNames(context.body), 'add')).map((label) => labelJson(context.urls, context.scope.repository, label))) },
  { method: 'PUT', pattern: /^\/issues\/(\d+)\/labels$/, body: true, handler: async (context) => json(200, (await changeIssueLabels(context.scope, int(context.params[0]!), labelNames(context.body), 'set')).map((label) => labelJson(context.urls, context.scope.repository, label))) },
  {
    method: 'DELETE',
    pattern: /^\/issues\/(\d+)\/labels$/,
    handler: async (context) => {
      await changeIssueLabels(context.scope, int(context.params[0]!), (await listIssueLabels(context.scope, int(context.params[0]!))).map((label) => label.name), 'remove')
      return json(204, null)
    },
  },
  { method: 'DELETE', pattern: /^\/issues\/(\d+)\/labels\/([^/]+)$/, handler: async (context) => json(200, (await changeIssueLabels(context.scope, int(context.params[0]!), [context.params[1]!], 'remove')).map((label) => labelJson(context.urls, context.scope.repository, label))) },
  { method: 'POST', pattern: /^\/issues\/(\d+)\/assignees$/, body: true, handler: async (context) => json(201, issueJson(context.urls, context.scope.repository, await changeAssignees(context.scope, int(context.params[0]!), strings(context.body, 'assignees') ?? [], 'add'))) },
  { method: 'DELETE', pattern: /^\/issues\/(\d+)\/assignees$/, body: true, handler: async (context) => json(200, issueJson(context.urls, context.scope.repository, await changeAssignees(context.scope, int(context.params[0]!), strings(context.body, 'assignees') ?? [], 'remove'))) },
  {
    method: 'PUT',
    pattern: /^\/issues\/(\d+)\/lock$/,
    body: true,
    handler: async (context) => {
      const reason = context.body.lock_reason
      if (reason !== undefined && typeof reason !== 'string') throw invalid('lock_reason must be a string')
      await setLocked(context.scope, int(context.params[0]!), true, (reason as string | undefined) ?? null)
      return json(204, null)
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/issues\/(\d+)\/lock$/,
    handler: async (context) => {
      await setLocked(context.scope, int(context.params[0]!), false)
      return json(204, null)
    },
  },
  { method: 'GET', pattern: /^\/labels$/, handler: async (context) => paged(context, await listLabels(context.scope, pageOf(context.url)), (label) => labelJson(context.urls, context.scope.repository, label)) },
  { method: 'POST', pattern: /^\/labels$/, body: true, handler: async (context) => json(201, labelJson(context.urls, context.scope.repository, await createLabel(context.scope, context.body))) },
  { method: 'GET', pattern: /^\/labels\/([^/]+)$/, handler: async (context) => json(200, labelJson(context.urls, context.scope.repository, await getLabel(context.scope, context.params[0]!))) },
  {
    method: 'PATCH',
    pattern: /^\/labels\/([^/]+)$/,
    body: true,
    handler: async (context) =>
      json(200, labelJson(context.urls, context.scope.repository, await updateLabel(context.scope, context.params[0]!, { newName: context.body.new_name ?? context.body.name, color: context.body.color, description: context.body.description }))),
  },
  {
    method: 'DELETE',
    pattern: /^\/labels\/([^/]+)$/,
    handler: async (context) => {
      await deleteLabel(context.scope, context.params[0]!)
      return json(204, null)
    },
  },
  {
    method: 'GET',
    pattern: /^\/milestones$/,
    handler: async (context) => {
      const params = context.url.searchParams
      const state = choice(params.get('state'), ['open', 'closed', 'all'] as const)
      const sort = choice(params.get('sort'), ['due_on', 'completeness'] as const)
      const direction = choice(params.get('direction'), ['asc', 'desc'] as const)
      return paged(context, await listMilestones(context.scope, { ...(state ? { state } : {}), ...(sort ? { sort } : {}), ...(direction ? { direction } : {}) }, pageOf(context.url)), (milestone) => milestoneJson(context.urls, context.scope.repository, milestone))
    },
  },
  {
    method: 'POST',
    pattern: /^\/milestones$/,
    body: true,
    handler: async (context) => json(201, milestoneJson(context.urls, context.scope.repository, await createMilestone(context.scope, { title: context.body.title, description: context.body.description, state: context.body.state, dueOn: context.body.due_on }))),
  },
  { method: 'GET', pattern: /^\/milestones\/(\d+)$/, handler: async (context) => json(200, milestoneJson(context.urls, context.scope.repository, await getMilestone(context.scope, int(context.params[0]!)))) },
  {
    method: 'PATCH',
    pattern: /^\/milestones\/(\d+)$/,
    body: true,
    handler: async (context) => json(200, milestoneJson(context.urls, context.scope.repository, await updateMilestone(context.scope, int(context.params[0]!), { title: context.body.title, description: context.body.description, state: context.body.state, dueOn: context.body.due_on }))),
  },
  {
    method: 'DELETE',
    pattern: /^\/milestones\/(\d+)$/,
    handler: async (context) => {
      await deleteMilestone(context.scope, int(context.params[0]!))
      return json(204, null)
    },
  },
  {
    method: 'GET',
    pattern: /^\/pulls$/,
    handler: async (context) => {
      const params = context.url.searchParams
      const state = choice(params.get('state'), ['open', 'closed', 'all'] as const)
      const sort = choice(params.get('sort'), ['created', 'updated'] as const)
      const direction = choice(params.get('direction'), ['asc', 'desc'] as const)
      const result = await listPulls(
        context.scope,
        {
          ...(state ? { state } : {}),
          ...(sort ? { sort } : {}),
          ...(direction ? { direction } : {}),
          ...(params.get('head') !== null ? { head: params.get('head')! } : {}),
          ...(params.get('base') !== null ? { base: params.get('base')! } : {}),
        },
        pageOf(context.url),
      )
      return paged(context, result, (pull) => pullJson(context.urls, context.scope.repository, pull))
    },
  },
  {
    method: 'POST',
    pattern: /^\/pulls$/,
    body: true,
    handler: async (context) => {
      const pull = await createPull(context.scope, {
        title: context.body.title,
        body: context.body.body,
        head: context.body.head,
        headRepo: context.body.head_repo,
        base: context.body.base,
        draft: context.body.draft,
        maintainerCanModify: context.body.maintainer_can_modify,
      })
      return json(201, pullJson(context.urls, context.scope.repository, pull), { Location: `${context.urls.api}/repos/${context.scope.repo.owner}/${context.scope.repo.name}/pulls/${pull.number}` })
    },
  },
  { method: 'GET', pattern: /^\/pulls\/comments$/, handler: async (context) => sliced(context, await listReviewComments(context.scope, null), (comment) => reviewCommentJson(context.urls, context.scope.repository, comment)) },
  { method: 'GET', pattern: /^\/pulls\/comments\/(\d+)$/, handler: async (context) => json(200, reviewCommentJson(context.urls, context.scope.repository, await getReviewComment(context.scope, int(context.params[0]!)))) },
  { method: 'PATCH', pattern: /^\/pulls\/comments\/(\d+)$/, body: true, handler: async (context) => json(200, reviewCommentJson(context.urls, context.scope.repository, await updateReviewComment(context.scope, int(context.params[0]!), context.body.body))) },
  {
    method: 'DELETE',
    pattern: /^\/pulls\/comments\/(\d+)$/,
    handler: async (context) => {
      await deleteReviewComment(context.scope, int(context.params[0]!))
      return json(204, null)
    },
  },
  { method: 'GET', pattern: /^\/pulls\/(\d+)$/, handler: (context) => pullResponse(context, int(context.params[0]!)) },
  {
    method: 'PATCH',
    pattern: /^\/pulls\/(\d+)$/,
    body: true,
    handler: async (context) => {
      await updatePull(context.scope, int(context.params[0]!), {
        ...(context.body.title !== undefined ? { title: context.body.title } : {}),
        ...(context.body.body !== undefined ? { body: context.body.body } : {}),
        ...(context.body.state !== undefined ? { state: context.body.state } : {}),
        ...(context.body.base !== undefined ? { base: context.body.base } : {}),
        ...(context.body.draft !== undefined ? { draft: context.body.draft } : {}),
        ...(context.body.maintainer_can_modify !== undefined ? { maintainerCanModify: context.body.maintainer_can_modify } : {}),
      })
      return pullResponse(context, int(context.params[0]!))
    },
  },
  {
    method: 'GET',
    pattern: /^\/pulls\/(\d+)\/codeowners$/,
    handler: async (context) => {
      const review = await pullCodeOwners(context.scope, int(context.params[0]!))
      return json(200, { path: review.file, approved: review.approved, files: review.files.map((file) => ({ filename: file.path, owners: file.owners, approved_by: file.approvedBy })) })
    },
  },
  {
    method: 'GET',
    pattern: /^\/codeowners\/errors$/,
    handler: async (context) => {
      const ref = context.url.searchParams.get('ref') ?? 'HEAD'
      const commit = await resolveCommitish(context.scope, ref)
      if (!commit) throw new CollaborationError(404, `No commit found for the ref ${ref}`)
      const codeowners = await loadCodeOwners(objectDatabase(context.scope), commit)
      if (!codeowners) throw new CollaborationError(404, 'Not Found')
      const lines = codeowners.errors.map((error) => ({ line: error.line, column: 1, kind: 'Invalid pattern or owner', message: error.message, path: codeowners.path }))
      return json(200, { errors: lines })
    },
  },
  { method: 'GET', pattern: /^\/pulls\/(\d+)\/commits$/, handler: async (context) => sliced(context, await pullCommits(context.scope, int(context.params[0]!)), (commit) => commitJson(context.urls, context.scope.repository, commit)) },
  {
    method: 'GET',
    pattern: /^\/pulls\/(\d+)\/files$/,
    handler: async (context) => {
      const number = int(context.params[0]!)
      const files = await pullFiles(context.scope, number)
      const head = (await getPull(context.scope, number)).headSha
      return sliced(context, files, (file) => fileJson(context.urls, context.scope.repository, head, file))
    },
  },
  {
    method: 'GET',
    pattern: /^\/pulls\/(\d+)\/merge$/,
    handler: async (context) => ((await getPull(context.scope, int(context.params[0]!))).merged ? json(204, null) : errorResponse(404, 'Not Found')),
  },
  {
    method: 'PUT',
    pattern: /^\/pulls\/(\d+)\/merge$/,
    body: true,
    handler: async (context) => {
      const result = await mergePull(context.scope, int(context.params[0]!), {
        method: context.body.merge_method,
        commitTitle: context.body.commit_title,
        commitMessage: context.body.commit_message,
        sha: context.body.sha,
      })
      return json(200, { sha: result.sha, merged: true, message: result.message })
    },
  },
  { method: 'GET', pattern: /^\/pulls\/(\d+)\/reviews$/, handler: async (context) => sliced(context, await listReviews(context.scope, int(context.params[0]!)), (review) => reviewJson(context.urls, context.scope.repository, review)) },
  {
    method: 'POST',
    pattern: /^\/pulls\/(\d+)\/reviews$/,
    body: true,
    handler: async (context) => {
      const comments = context.body.comments
      if (comments !== undefined && !Array.isArray(comments)) throw invalid('comments must be an array')
      const review = await createReview(context.scope, int(context.params[0]!), {
        commitId: context.body.commit_id,
        body: context.body.body,
        event: context.body.event,
        comments: ((comments ?? []) as Body[]).map((comment) => ({
          path: comment.path,
          line: comment.line ?? comment.position,
          side: comment.side,
          startLine: comment.start_line,
          startSide: comment.start_side,
          body: comment.body,
        })),
      })
      return json(200, reviewJson(context.urls, context.scope.repository, review))
    },
  },
  { method: 'GET', pattern: /^\/pulls\/(\d+)\/reviews\/(\d+)$/, handler: async (context) => json(200, reviewJson(context.urls, context.scope.repository, await getReview(context.scope, int(context.params[0]!), int(context.params[1]!)))) },
  { method: 'PUT', pattern: /^\/pulls\/(\d+)\/reviews\/(\d+)$/, body: true, handler: async (context) => json(200, reviewJson(context.urls, context.scope.repository, await updateReviewBody(context.scope, int(context.params[0]!), int(context.params[1]!), context.body.body))) },
  { method: 'DELETE', pattern: /^\/pulls\/(\d+)\/reviews\/(\d+)$/, handler: async (context) => json(200, reviewJson(context.urls, context.scope.repository, await deletePendingReview(context.scope, int(context.params[0]!), int(context.params[1]!)))) },
  { method: 'POST', pattern: /^\/pulls\/(\d+)\/reviews\/(\d+)\/events$/, body: true, handler: async (context) => json(200, reviewJson(context.urls, context.scope.repository, await submitReview(context.scope, int(context.params[0]!), int(context.params[1]!), { event: context.body.event, body: context.body.body }))) },
  { method: 'PUT', pattern: /^\/pulls\/(\d+)\/reviews\/(\d+)\/dismissals$/, body: true, handler: async (context) => json(200, reviewJson(context.urls, context.scope.repository, await dismissReview(context.scope, int(context.params[0]!), int(context.params[1]!), context.body.message))) },
  { method: 'GET', pattern: /^\/pulls\/(\d+)\/reviews\/(\d+)\/comments$/, handler: async (context) => sliced(context, await listReviewComments(context.scope, int(context.params[0]!), { reviewId: int(context.params[1]!) }), (comment) => reviewCommentJson(context.urls, context.scope.repository, comment)) },
  { method: 'GET', pattern: /^\/pulls\/(\d+)\/comments$/, handler: async (context) => sliced(context, await listReviewComments(context.scope, int(context.params[0]!)), (comment) => reviewCommentJson(context.urls, context.scope.repository, comment)) },
  {
    method: 'POST',
    pattern: /^\/pulls\/(\d+)\/comments$/,
    body: true,
    handler: async (context) =>
      json(
        201,
        reviewCommentJson(
          context.urls,
          context.scope.repository,
          await createReviewComment(context.scope, int(context.params[0]!), {
            body: context.body.body,
            commitId: context.body.commit_id,
            path: context.body.path,
            line: context.body.line ?? context.body.position,
            side: context.body.side,
            startLine: context.body.start_line,
            startSide: context.body.start_side,
            inReplyTo: context.body.in_reply_to,
          }),
        ),
      ),
  },
  {
    method: 'POST',
    pattern: /^\/pulls\/(\d+)\/comments\/(\d+)\/replies$/,
    body: true,
    handler: async (context) =>
      json(201, reviewCommentJson(context.urls, context.scope.repository, await createReviewComment(context.scope, int(context.params[0]!), { body: context.body.body, path: undefined, line: undefined, inReplyTo: int(context.params[1]!) }))),
  },
  { method: 'GET', pattern: /^\/pulls\/(\d+)\/requested_reviewers$/, handler: async (context) => json(200, { users: (await listRequestedReviewers(context.scope, int(context.params[0]!))).map((user) => userJson(context.urls, user)), teams: [] }) },
  {
    method: 'POST',
    pattern: /^\/pulls\/(\d+)\/requested_reviewers$/,
    body: true,
    handler: async (context) => {
      await changeRequestedReviewers(context.scope, int(context.params[0]!), strings(context.body, 'reviewers') ?? [], 'add')
      return pullResponse(context, int(context.params[0]!), 201)
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/pulls\/(\d+)\/requested_reviewers$/,
    body: true,
    handler: async (context) => {
      await changeRequestedReviewers(context.scope, int(context.params[0]!), strings(context.body, 'reviewers') ?? [], 'remove')
      return pullResponse(context, int(context.params[0]!))
    },
  },
  {
    method: 'POST',
    pattern: /^\/statuses\/([0-9a-f]{40})$/,
    body: true,
    handler: async (context) =>
      json(201, statusJson(context.urls, context.scope.repository, await createStatus(context.scope, context.params[0]!, { state: context.body.state, context: context.body.context, targetUrl: context.body.target_url, description: context.body.description }))),
  },
  { method: 'GET', pattern: /^\/(?:commits|statuses)\/(.+?)\/statuses$|^\/statuses\/([0-9a-f]{40})$/, handler: async (context) => paged(context, await listStatuses(context.scope, context.params[0] ?? context.params[1]!, pageOf(context.url)), (status) => statusJson(context.urls, context.scope.repository, status)) },
  { method: 'GET', pattern: /^\/commits\/(.+?)\/status$/, handler: async (context) => json(200, combinedStatusJson(context.urls, context.scope.repository, await combinedStatus(context.scope, context.params[0]!))) },
  {
    method: 'GET',
    pattern: /^\/commits\/(.+?)\/check-runs$/,
    handler: async (context) => {
      const params = context.url.searchParams
      const result = await listCheckRuns(
        context.scope,
        context.params[0]!,
        { ...(params.get('check_name') ? { name: params.get('check_name')! } : {}), ...(params.get('status') ? { status: params.get('status')! } : {}), latest: params.get('filter') !== 'all' },
        pageOf(context.url),
      )
      return json(200, { total_count: result.total, check_runs: result.items.map((run) => checkRunJson(context.urls, context.scope.repository, run)) }, linkHeader(context.url, pageOf(context.url), result.total))
    },
  },
  {
    method: 'POST',
    pattern: /^\/check-runs$/,
    body: true,
    handler: async (context) =>
      json(
        201,
        checkRunJson(
          context.urls,
          context.scope.repository,
          await createCheckRun(context.scope, {
            name: context.body.name,
            headSha: context.body.head_sha,
            status: context.body.status,
            conclusion: context.body.conclusion,
            externalId: context.body.external_id,
            detailsUrl: context.body.details_url,
            startedAt: context.body.started_at,
            completedAt: context.body.completed_at,
            output: context.body.output,
          }),
        ),
      ),
  },
  { method: 'GET', pattern: /^\/check-runs\/(\d+)$/, handler: async (context) => json(200, checkRunJson(context.urls, context.scope.repository, await getCheckRun(context.scope, int(context.params[0]!)))) },
  {
    method: 'PATCH',
    pattern: /^\/check-runs\/(\d+)$/,
    body: true,
    handler: async (context) =>
      json(
        200,
        checkRunJson(
          context.urls,
          context.scope.repository,
          await updateCheckRun(context.scope, int(context.params[0]!), {
            ...(context.body.name !== undefined ? { name: context.body.name } : {}),
            ...(context.body.status !== undefined ? { status: context.body.status } : {}),
            ...(context.body.conclusion !== undefined ? { conclusion: context.body.conclusion } : {}),
            ...(context.body.external_id !== undefined ? { externalId: context.body.external_id } : {}),
            ...(context.body.details_url !== undefined ? { detailsUrl: context.body.details_url } : {}),
            ...(context.body.started_at !== undefined ? { startedAt: context.body.started_at } : {}),
            ...(context.body.completed_at !== undefined ? { completedAt: context.body.completed_at } : {}),
            ...(context.body.output !== undefined ? { output: context.body.output } : {}),
          }),
        ),
      ),
  },
  { method: 'GET', pattern: /^\/discussion-categories$/, handler: async (context) => json(200, (await listCategories(context.scope)).map(categoryJson)) },
  { method: 'POST', pattern: /^\/discussion-categories$/, body: true, handler: async (context) => json(201, categoryJson(await createCategory(context.scope, { slug: context.body.slug, name: context.body.name, emoji: context.body.emoji, description: context.body.description, answerable: context.body.is_answerable }))) },
  { method: 'GET', pattern: /^\/discussion-categories\/([^/]+)$/, handler: async (context) => json(200, categoryJson(await getCategory(context.scope, context.params[0]!))) },
  { method: 'PATCH', pattern: /^\/discussion-categories\/([^/]+)$/, body: true, handler: async (context) => json(200, categoryJson(await updateCategory(context.scope, context.params[0]!, { slug: context.body.slug, name: context.body.name, emoji: context.body.emoji, description: context.body.description, answerable: context.body.is_answerable }))) },
  {
    method: 'DELETE',
    pattern: /^\/discussion-categories\/([^/]+)$/,
    handler: async (context) => {
      await deleteCategory(context.scope, context.params[0]!)
      return json(204, null)
    },
  },
  {
    method: 'GET',
    pattern: /^\/discussions$/,
    handler: async (context) => {
      const params = context.url.searchParams
      const state = choice(params.get('state'), ['open', 'closed', 'all'] as const)
      const answered = params.get('answered')
      const result = await listDiscussions(
        context.scope,
        { ...(params.get('category') ? { category: params.get('category')! } : {}), ...(state ? { state } : {}), ...(answered === 'true' || answered === 'false' ? { answered: answered === 'true' } : {}) },
        pageOf(context.url),
      )
      return paged(context, result, (discussion) => discussionJson(context.urls, context.scope.repository, discussion))
    },
  },
  { method: 'POST', pattern: /^\/discussions$/, body: true, handler: async (context) => json(201, discussionJson(context.urls, context.scope.repository, await createDiscussion(context.scope, { title: context.body.title, body: context.body.body, category: context.body.category }))) },
  { method: 'GET', pattern: /^\/discussions\/comments\/(\d+)$/, handler: async (context) => json(200, discussionCommentJson(context.urls, context.scope.repository, await getDiscussionComment(context.scope, int(context.params[0]!)))) },
  { method: 'PATCH', pattern: /^\/discussions\/comments\/(\d+)$/, body: true, handler: async (context) => json(200, discussionCommentJson(context.urls, context.scope.repository, await updateDiscussionComment(context.scope, int(context.params[0]!), context.body.body))) },
  {
    method: 'DELETE',
    pattern: /^\/discussions\/comments\/(\d+)$/,
    handler: async (context) => {
      await deleteDiscussionComment(context.scope, int(context.params[0]!))
      return json(204, null)
    },
  },
  { method: 'GET', pattern: /^\/discussions\/(\d+)$/, handler: async (context) => json(200, discussionJson(context.urls, context.scope.repository, await getDiscussion(context.scope, int(context.params[0]!)))) },
  {
    method: 'PATCH',
    pattern: /^\/discussions\/(\d+)$/,
    body: true,
    handler: async (context) =>
      json(
        200,
        discussionJson(
          context.urls,
          context.scope.repository,
          await updateDiscussion(context.scope, int(context.params[0]!), {
            ...(context.body.title !== undefined ? { title: context.body.title } : {}),
            ...(context.body.body !== undefined ? { body: context.body.body } : {}),
            ...(context.body.category !== undefined ? { category: context.body.category } : {}),
            ...(context.body.state !== undefined ? { state: context.body.state } : {}),
            ...(context.body.state_reason !== undefined ? { stateReason: context.body.state_reason } : {}),
          }),
        ),
      ),
  },
  { method: 'PUT', pattern: /^\/discussions\/(\d+)\/lock$/, handler: async (context) => json(200, discussionJson(context.urls, context.scope.repository, await setDiscussionLocked(context.scope, int(context.params[0]!), true))) },
  { method: 'DELETE', pattern: /^\/discussions\/(\d+)\/lock$/, handler: async (context) => json(200, discussionJson(context.urls, context.scope.repository, await setDiscussionLocked(context.scope, int(context.params[0]!), false))) },
  {
    method: 'GET',
    pattern: /^\/discussions\/(\d+)\/comments$/,
    handler: async (context) => {
      const parent = context.url.searchParams.get('parent_id')
      return sliced(context, await listDiscussionComments(context.scope, int(context.params[0]!), parent ? { parentId: int(parent) } : {}), (comment) => discussionCommentJson(context.urls, context.scope.repository, comment))
    },
  },
  { method: 'POST', pattern: /^\/discussions\/(\d+)\/comments$/, body: true, handler: async (context) => json(201, discussionCommentJson(context.urls, context.scope.repository, await createDiscussionComment(context.scope, int(context.params[0]!), { body: context.body.body, parentId: context.body.reply_to_id }))) },
  {
    method: 'PUT',
    pattern: /^\/discussions\/(\d+)\/answer$/,
    body: true,
    handler: async (context) => {
      if (typeof context.body.comment_id !== 'number') throw invalid('comment_id is required')
      return json(200, discussionJson(context.urls, context.scope.repository, await setAnswer(context.scope, int(context.params[0]!), context.body.comment_id)))
    },
  },
  { method: 'DELETE', pattern: /^\/discussions\/(\d+)\/answer$/, handler: async (context) => json(200, discussionJson(context.urls, context.scope.repository, await setAnswer(context.scope, int(context.params[0]!), null))) },
]

const REPO_PATH = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/

const decode = (value: string): string | null => {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

export const matchCollaborationRoute = (pathname: string, method: string, prefix = '/api/v3'): { owner: string; name: string; route: Route | null; allowed: string[]; params: string[] } | null => {
  if (!pathname.startsWith(`${prefix}/repos/`)) return null
  const match = REPO_PATH.exec(pathname.slice(prefix.length))
  if (!match) return null
  const owner = decode(match[1]!)
  const name = decode(match[2]!)
  const rest = match[3] ?? ''
  if (!owner || !name) return null
  const candidates = routes.filter((route) => route.pattern.test(rest))
  if (candidates.length === 0) return null
  const route = candidates.find((candidate) => candidate.method === method) ?? null
  const params = route ? route.pattern.exec(rest)!.slice(1).filter((value) => value !== undefined).map((value) => decode(value) ?? '') : []
  return { owner, name, route, allowed: [...new Set(candidates.map((candidate) => candidate.method))], params }
}

const urlsFor = (request: Request, options: CollaborationApiOptions): Urls => {
  const web = options.publicUrl ?? new URL(request.url).origin
  return { web, api: `${web}${options.prefix ?? '/api/v3'}` }
}

export const handleCollaborationApi = async (request: Request, options: CollaborationApiOptions): Promise<Response | null> => {
  const url = new URL(request.url)
  const matched = matchCollaborationRoute(url.pathname, request.method, options.prefix)
  if (!matched) return null
  if (!matched.route) return errorResponse(405, 'Method Not Allowed', [], { Allow: matched.allowed.join(', ') })
  if (!isValidName(matched.owner) || !isValidName(matched.name)) return errorResponse(404, 'Not Found')
  const principal: Principal | null = options.authenticate
    ? await options.authenticate(request)
    : await authenticateRequest(request, {
        directory: options.accounts as RepositoryDirectory,
        ...(options.verifyInstance ? { verifyInstance: options.verifyInstance } : {}),
      })
  if (!principal) return errorResponse(401, 'Bad credentials', [], { 'WWW-Authenticate': 'Bearer' })
  try {
    const scope = await openRepository(options, principal, matched.owner, matched.name)
    const body = matched.route.body ? await readBody(request, matched.route.maxBody) : {}
    return await matched.route.handler({ scope, url, urls: urlsFor(request, options), body, request, params: matched.params })
  } catch (error) {
    if (error instanceof CollaborationError) {
      if (error.status === 404 && principal.kind === 'anonymous') return errorResponse(404, 'Not Found')
      return errorResponse(error.status, error.message, error.details, error.status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {})
    }
    throw error
  }
}
