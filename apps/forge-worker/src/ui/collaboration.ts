import {
  can,
  CollaborationError,
  invalid,
  REACTION_KINDS,
  REACTIONS,
  type ReactionContent,
  type ReactionKind,
  type ReactionRollup,
  type Scope,
  type TimelineItem,
  toggleReaction,
  viewerReactions,
} from '@git-forge/collaboration'
import type { Principal } from '@git-forge/accounts'
import type { ForgeServices, UiSession } from '../app.ts'
import { renderMarkdown } from './markdown.ts'
import { blobUrl, type OpenRepository, rawUrl } from './repository.ts'

export type FormOutcome = { readonly kind: 'redirect'; readonly location: string } | { readonly kind: 'error'; readonly status: number; readonly message: string }

export const parseNumber = (value: string | undefined): number | null => {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

export const renderBody = (repo: OpenRepository, body: string | null): Promise<string> | null =>
  body && body.trim() !== ''
    ? renderMarkdown(body, { blob: blobUrl(repo.name, repo.defaultBranch ?? 'HEAD', []), raw: rawUrl(repo.name, repo.defaultBranch ?? 'HEAD', []), directory: '' })
    : null

export const scopeFor = (forge: ForgeServices, request: Request, principal: Principal, repo: OpenRepository): Promise<Scope | null> =>
  forge.collaboration(request, principal, repo.name.owner, repo.name.name)

export const runForm = async (
  forge: ForgeServices,
  request: Request,
  repo: OpenRepository,
  action: (scope: Scope, form: FormData, session: UiSession) => Promise<string>,
): Promise<FormOutcome> => {
  const session = await forge.verifySessionWrite(request)
  if (!session) return { kind: 'error', status: 403, message: 'The form expired or you are not signed in. Reload the page and try again.' }
  const scope = await scopeFor(forge, request, session.principal, repo)
  if (!scope) return { kind: 'error', status: 404, message: 'Not found.' }
  try {
    return { kind: 'redirect', location: await action(scope, await request.formData(), session) }
  } catch (error) {
    if (error instanceof CollaborationError) return { kind: 'error', status: error.status, message: error.message }
    throw error
  }
}

export const field = (form: FormData, name: string): string => String(form.get(name) ?? '')

export const reactTo = (scope: Scope, form: FormData): Promise<void> => {
  const kind = field(form, 'kind')
  if (!(REACTION_KINDS as readonly string[]).includes(kind)) throw invalid('Unknown reaction subject')
  return toggleReaction(scope, { kind: kind as ReactionKind, id: Number(field(form, 'subject')) }, field(form, 'content'))
}

export type ReactionProps = { readonly kind: ReactionKind; readonly subject: number; readonly rollup: ReactionRollup; readonly mine: readonly ReactionContent[]; readonly csrf: string | null }

export type Reactable = { readonly id: number; readonly subject: number; readonly reactions: ReactionRollup }

export const reactionsFor = async (scope: Scope, kind: ReactionKind, items: readonly Reactable[], csrf: string | null, locked = false): Promise<Map<number, ReactionProps>> => {
  const viewer = await viewerReactions(scope, kind, items.map((item) => item.id))
  const allowed = csrf !== null && can(scope, 'reaction:create', { locked }) ? csrf : null
  return new Map(items.map((item) => [item.id, { kind, subject: item.subject, rollup: item.reactions, mine: REACTIONS.filter((content) => viewer.has(`${item.id}:${content}`)), csrf: allowed }]))
}

const nested = (data: Readonly<Record<string, unknown>>, key: string, inner: string): string | null => {
  const value = data[key]
  if (typeof value !== 'object' || value === null) return null
  const text = (value as Record<string, unknown>)[inner]
  return typeof text === 'string' || typeof text === 'number' ? String(text) : null
}

export const describeEvent = (event: string, data: Readonly<Record<string, unknown>>): string => {
  switch (event) {
    case 'closed':
      return data.state_reason === 'not_planned' ? 'closed this as not planned' : 'closed this'
    case 'reopened':
      return 'reopened this'
    case 'merged':
      return `merged commit ${String(data.commit_id ?? '').slice(0, 7)}`
    case 'labeled':
      return `added the ${nested(data, 'label', 'name') ?? ''} label`
    case 'unlabeled':
      return `removed the ${nested(data, 'label', 'name') ?? ''} label`
    case 'assigned':
      return `assigned ${nested(data, 'assignee', 'login') ?? 'someone'}`
    case 'unassigned':
      return `unassigned ${nested(data, 'assignee', 'login') ?? 'someone'}`
    case 'renamed':
      return `changed the title from “${nested(data, 'rename', 'from') ?? ''}” to “${nested(data, 'rename', 'to') ?? ''}”`
    case 'milestoned':
      return 'added this to a milestone'
    case 'demilestoned':
      return 'removed this from a milestone'
    case 'locked':
      return 'locked the conversation'
    case 'unlocked':
      return 'unlocked the conversation'
    case 'cross-referenced':
      return 'mentioned this elsewhere'
    case 'referenced':
      return 'referenced this in a commit'
    case 'review_requested':
      return `requested a review from ${nested(data, 'requested_reviewer', 'login') ?? 'someone'}`
    case 'review_request_removed':
      return `removed the review request for ${nested(data, 'requested_reviewer', 'login') ?? 'someone'}`
    case 'review_dismissed':
      return 'dismissed a review'
    case 'head_ref_force_pushed':
      return 'force-pushed the head branch'
    case 'base_ref_changed':
      return `changed the base branch from ${String(data.from ?? '')} to ${String(data.to ?? '')}`
    case 'ready_for_review':
      return 'marked this as ready for review'
    case 'convert_to_draft':
      return 'marked this as a draft'
    default:
      return event.replace(/_/g, ' ')
  }
}

export type RenderedItem =
  | { readonly kind: 'comment'; readonly id: number; readonly author: string; readonly at: number; readonly html: string }
  | { readonly kind: 'event'; readonly id: number; readonly actor: string; readonly at: number; readonly text: string }
  | { readonly kind: 'review'; readonly id: number; readonly author: string; readonly at: number; readonly state: string; readonly html: string | null }

export const renderTimeline = async (repo: OpenRepository, items: readonly TimelineItem[]): Promise<RenderedItem[]> =>
  Promise.all(
    items.map(async (item): Promise<RenderedItem> => {
      if (item.kind === 'comment') {
        return { kind: 'comment', id: item.comment.id, author: item.comment.author.login, at: item.at, html: (await renderBody(repo, item.comment.body)) ?? '' }
      }
      if (item.kind === 'review') {
        return { kind: 'review', id: item.review.id, author: item.review.author.login, at: item.at, state: item.review.state, html: await renderBody(repo, item.review.body) }
      }
      return { kind: 'event', id: item.event.id, actor: item.event.actor.login, at: item.at, text: describeEvent(item.event.event, item.event.data) }
    }),
  )

export const unlessMissing = async <T>(promise: Promise<T>): Promise<T | null> => {
  try {
    return await promise
  } catch (error) {
    if (error instanceof CollaborationError && error.status === 404) return null
    throw error
  }
}

export const safeUrl = (value: string | null): string | null => {
  if (!value) return null
  try {
    const url = new URL(value, 'https://placeholder.invalid')
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : null
  } catch {
    return null
  }
}
