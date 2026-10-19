import { commentsPage, eventsOf, type IssueComment, type IssueEvent, issueRow } from './issues.ts'
import { listReviews, type Review } from './reviews.ts'
import type { Scope } from './context.ts'

export type TimelineItem =
  | { readonly kind: 'event'; readonly at: number; readonly event: IssueEvent }
  | { readonly kind: 'comment'; readonly at: number; readonly comment: IssueComment }
  | { readonly kind: 'review'; readonly at: number; readonly review: Review }

export const timeline = async (scope: Scope, number: number): Promise<TimelineItem[]> => {
  const row = await issueRow(scope, number)
  const allComments = async () => {
    const comments: IssueComment[] = []
    for (let page = 1; ; page++) {
      const batch = await commentsPage(scope, number, {}, { page, perPage: 100 })
      comments.push(...batch.items)
      if (batch.items.length < 100) return comments
    }
  }
  const [events, comments, reviews] = await Promise.all([
    eventsOf(scope, row),
    allComments(),
    row.is_pull === 1 ? listReviews(scope, number).then((all) => all.filter((review) => review.state !== 'PENDING')) : [],
  ])
  const items: TimelineItem[] = [
    ...events.filter((event) => event.event !== 'reviewed').map((event) => ({ kind: 'event' as const, at: event.createdAt, event })),
    ...comments.map((comment) => ({ kind: 'comment' as const, at: comment.createdAt, comment })),
    ...reviews.map((review) => ({ kind: 'review' as const, at: review.submittedAt ?? review.createdAt, review })),
  ]
  const order = (item: TimelineItem) => (item.kind === 'event' ? item.event.id : item.kind === 'comment' ? item.comment.id : item.review.id)
  return items.sort((a, b) => a.at - b.at || order(a) - order(b))
}
