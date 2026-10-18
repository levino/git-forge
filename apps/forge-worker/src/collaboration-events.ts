import {
  type Activity,
  type Discussion,
  type DiscussionComment,
  getComment,
  getDiscussion,
  getDiscussionComment,
  getIssue,
  getPullSummary,
  getReview,
  getReviewComment,
  type Issue,
  loadUsers,
  type PullRequest,
  type Scope,
} from '@git-forge/collaboration'
import {
  type CommentAction,
  type DiscussionAction,
  discussionCommentEvent,
  type DiscussionCommentInfo,
  discussionEvent,
  type DiscussionInfo,
  type EventActor,
  type ForgeEvent,
  issueCommentEvent,
  type IssueInfo,
  type IssuesAction,
  issuesEvent,
  type PullRequestAction,
  pullRequestEvent,
  type PullRequestInfo,
  pullRequestReviewCommentEvent,
  pullRequestReviewEvent,
  type ReviewAction,
  type ReviewInfo,
  SYSTEM_ACTOR,
} from '@git-forge/notifications'

const issueInfo = (issue: Issue): IssueInfo => ({
  number: issue.number,
  title: issue.title,
  body: issue.body,
  state: issue.state,
  author: issue.author.login,
  labels: issue.labels.map((label) => label.name),
  assignees: issue.assignees.map((user) => user.login),
  createdAt: issue.createdAt,
  updatedAt: issue.updatedAt,
  closedAt: issue.closedAt,
  stateReason: issue.stateReason,
})

const pullInfo = (pull: PullRequest): PullRequestInfo => ({
  ...issueInfo(pull),
  head: { ref: pull.headRef, sha: pull.headSha },
  base: { ref: pull.baseRef, sha: pull.baseSha },
  draft: pull.draft,
  merged: pull.merged,
  mergedAt: pull.mergedAt,
  mergeCommitSha: pull.mergeCommitSha,
  requestedReviewers: pull.requestedReviewers.map((user) => user.login),
})

const discussionInfo = (discussion: Discussion): DiscussionInfo => ({
  number: discussion.number,
  title: discussion.title,
  body: discussion.body,
  state: discussion.state,
  stateReason: discussion.stateReason,
  locked: discussion.locked,
  author: discussion.author.login,
  category: { slug: discussion.category.slug, name: discussion.category.name, answerable: discussion.category.answerable },
  answerCommentId: discussion.answerCommentId,
  comments: discussion.comments,
  createdAt: discussion.createdAt,
  updatedAt: discussion.updatedAt,
})

const discussionCommentInfo = (comment: DiscussionComment): DiscussionCommentInfo => ({
  id: comment.id,
  body: comment.body,
  author: comment.author.login,
  createdAt: comment.createdAt,
  updatedAt: comment.updatedAt,
  parentId: comment.parentId,
})

const REVIEW_STATE: Readonly<Record<string, ReviewInfo['state']>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
  PENDING: 'pending',
}

export const activityEvent = async (scope: Scope, activity: Activity, baseUrl: string): Promise<ForgeEvent> => {
  const actor: EventActor =
    activity.actor.kind === 'system' ? SYSTEM_ACTOR : { kind: activity.actor.kind, id: activity.actor.id, login: (await loadUsers(scope.db, [activity.actor]))(activity.actor).login }
  const context = { baseUrl, repository: scope.repo, actor }
  const number = activity.number
  switch (activity.kind) {
    case 'issues':
      return issuesEvent(context, activity.action as IssuesAction, issueInfo(await getIssue(scope, number)), activity.changes)
    case 'issue_comment': {
      const issue = await getIssue(scope, number)
      const comment = await getComment(scope, activity.commentId!)
      const subject = issue.isPull ? pullInfo(await getPullSummary(scope, number)) : issueInfo(issue)
      return issueCommentEvent(
        context,
        activity.action as CommentAction,
        subject,
        { id: comment.id, body: comment.body, author: comment.author.login, createdAt: comment.createdAt, updatedAt: comment.updatedAt },
        issue.isPull,
      )
    }
    case 'pull_request':
      return pullRequestEvent(context, activity.action as PullRequestAction, pullInfo(await getPullSummary(scope, number)), {
        ...(activity.requestedReviewer ? { requestedReviewer: activity.requestedReviewer } : {}),
        ...(activity.before ? { before: activity.before } : {}),
        ...(activity.after ? { after: activity.after } : {}),
        ...(activity.changes ? { changes: activity.changes } : {}),
      })
    case 'pull_request_review': {
      const review = await getReview(scope, number, activity.reviewId!)
      return pullRequestReviewEvent(context, activity.action as ReviewAction, pullInfo(await getPullSummary(scope, number)), {
        id: review.id,
        state: REVIEW_STATE[review.state] ?? 'commented',
        body: review.body,
        author: review.author.login,
        commitId: review.commitId,
        submittedAt: review.submittedAt,
      })
    }
    case 'pull_request_review_comment': {
      const comment = await getReviewComment(scope, activity.commentId!)
      return pullRequestReviewCommentEvent(context, activity.action as CommentAction, pullInfo(await getPullSummary(scope, number)), {
        id: comment.id,
        body: comment.body,
        author: comment.author.login,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        path: comment.path,
        line: comment.line,
        commitId: comment.commitId,
        diffHunk: comment.diffHunk,
        inReplyToId: comment.inReplyToId,
      })
    }
    case 'discussion': {
      const answer = activity.action === 'answered' && activity.commentId !== undefined ? discussionCommentInfo(await getDiscussionComment(scope, activity.commentId)) : undefined
      return discussionEvent(context, activity.action as DiscussionAction, discussionInfo(await getDiscussion(scope, number)), {
        ...(activity.changes ? { changes: activity.changes } : {}),
        ...(answer ? { answer } : {}),
      })
    }
    case 'discussion_comment':
      return discussionCommentEvent(
        context,
        activity.action as CommentAction,
        discussionInfo(await getDiscussion(scope, number)),
        discussionCommentInfo(await getDiscussionComment(scope, activity.commentId!)),
      )
  }
}
