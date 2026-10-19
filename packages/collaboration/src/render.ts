import type { RepositorySubject } from '@git-forge/accounts'
import { type FileDiff, formatHunks, signatureDate, type ObjectId } from '@git-forge/core'
import type { UserSummary } from './actors.ts'
import { type CommitOutcome, type ContentItem, encodeBase64 } from './contents.ts'
import type { CollaborationSettings } from './permissions.ts'
import type { Discussion, DiscussionCategory, DiscussionComment } from './discussions.ts'
import type { Issue, IssueComment, IssueEvent, Label, Milestone } from './issues.ts'
import type { Reaction, ReactionRollup } from './reactions.ts'
import type { PullCommit, PullDetails, PullRequest } from './pulls.ts'
import type { Review, ReviewComment } from './reviews.ts'
import type { CheckRun, CombinedStatus, CommitStatus } from './statuses.ts'

export type Urls = {
  readonly web: string
  readonly api: string
}

export const iso = (ms: number | null | undefined): string | null => (ms === null || ms === undefined ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'))

const enc = encodeURIComponent

export const repoApi = (urls: Urls, repository: RepositorySubject): string => `${urls.api}/repos/${enc(repository.owner)}/${enc(repository.name)}`

export const repoWeb = (urls: Urls, repository: RepositorySubject): string => `${urls.web}/${enc(repository.owner)}/${enc(repository.name)}`

export const userJson = (urls: Urls, user: UserSummary) => ({
  login: user.login,
  id: user.id,
  node_id: user.id === null ? null : `U_${user.id}`,
  avatar_url: '',
  gravatar_id: '',
  url: `${urls.api}/users/${enc(user.login)}`,
  html_url: `${urls.web}/${enc(user.login)}`,
  type: user.kind === 'user' ? 'User' : 'Bot',
  site_admin: false,
  ...(user.name ? { name: user.name } : {}),
})

const association = (repository: RepositorySubject, user: UserSummary): string =>
  user.kind === 'user' && user.id === repository.ownerId ? 'OWNER' : user.kind === 'user' && user.id !== null ? 'CONTRIBUTOR' : 'NONE'

export const labelJson = (urls: Urls, repository: RepositorySubject, label: Label) => ({
  id: label.id,
  node_id: label.nodeId,
  url: `${repoApi(urls, repository)}/labels/${enc(label.name)}`,
  name: label.name,
  color: label.color,
  default: false,
  description: label.description,
})

export const milestoneJson = (urls: Urls, repository: RepositorySubject, milestone: Milestone) => ({
  url: `${repoApi(urls, repository)}/milestones/${milestone.number}`,
  html_url: `${repoWeb(urls, repository)}/milestone/${milestone.number}`,
  labels_url: `${repoApi(urls, repository)}/milestones/${milestone.number}/labels`,
  id: milestone.id,
  node_id: milestone.nodeId,
  number: milestone.number,
  state: milestone.state,
  title: milestone.title,
  description: milestone.description,
  creator: userJson(urls, milestone.creator),
  open_issues: milestone.openIssues,
  closed_issues: milestone.closedIssues,
  created_at: iso(milestone.createdAt),
  updated_at: iso(milestone.updatedAt),
  closed_at: iso(milestone.closedAt),
  due_on: iso(milestone.dueOn),
})

const encodedPath = (path: string): string => path.split('/').map(enc).join('/')

export const contentJson = (urls: Urls, repository: RepositorySubject, ref: string, item: ContentItem) => {
  const api = repoApi(urls, repository)
  const web = repoWeb(urls, repository)
  const self = `${api}/contents/${encodedPath(item.path)}?ref=${enc(ref)}`
  const git = item.type === 'dir' ? `${api}/git/trees/${item.sha}` : `${api}/git/blobs/${item.sha}`
  const html = `${web}/${item.type === 'dir' ? 'tree' : 'blob'}/${encodedPath(ref)}/${encodedPath(item.path)}`
  return {
    type: item.type,
    ...(item.content ? { encoding: 'base64', content: encodeBase64(item.content).replace(/.{60}/g, '$&\n') } : {}),
    size: item.size,
    name: item.name,
    path: item.path,
    sha: item.sha,
    url: self,
    git_url: git,
    html_url: html,
    download_url: item.type === 'file' ? `${web}/raw/${encodedPath(ref)}/${encodedPath(item.path)}` : null,
    _links: { self, git, html },
  }
}

export const contentCommitJson = (urls: Urls, repository: RepositorySubject, outcome: CommitOutcome) => {
  const api = repoApi(urls, repository)
  const person = { name: outcome.signature.name, email: outcome.signature.email, date: signatureDate(outcome.signature) }
  return {
    sha: outcome.sha,
    url: `${api}/git/commits/${outcome.sha}`,
    html_url: `${repoWeb(urls, repository)}/commit/${outcome.sha}`,
    author: person,
    committer: person,
    message: outcome.message,
    tree: { sha: outcome.tree, url: `${api}/git/trees/${outcome.tree}` },
    parents: outcome.parent ? [{ sha: outcome.parent, url: `${api}/git/commits/${outcome.parent}`, html_url: `${repoWeb(urls, repository)}/commit/${outcome.parent}` }] : [],
    verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
  }
}

export const rollupJson = (url: string, rollup: ReactionRollup) => ({ url, total_count: rollup.total, ...rollup.counts })

export const reactionJson = (urls: Urls, reaction: Reaction) => ({
  id: reaction.id,
  node_id: reaction.nodeId,
  user: userJson(urls, reaction.user),
  content: reaction.content,
  created_at: iso(reaction.createdAt),
})

export const issueJson = (urls: Urls, repository: RepositorySubject, issue: Issue, pull?: Pick<PullRequest, 'mergedAt' | 'draft'>) => {
  const api = repoApi(urls, repository)
  const web = repoWeb(urls, repository)
  return {
    url: `${api}/issues/${issue.number}`,
    repository_url: api,
    labels_url: `${api}/issues/${issue.number}/labels{/name}`,
    comments_url: `${api}/issues/${issue.number}/comments`,
    events_url: `${api}/issues/${issue.number}/events`,
    html_url: `${web}/${issue.isPull ? 'pull' : 'issues'}/${issue.number}`,
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    user: userJson(urls, issue.author),
    labels: issue.labels.map((label) => labelJson(urls, repository, label)),
    state: issue.state,
    state_reason: issue.stateReason,
    locked: issue.locked,
    active_lock_reason: issue.lockReason,
    assignee: issue.assignees[0] ? userJson(urls, issue.assignees[0]) : null,
    assignees: issue.assignees.map((user) => userJson(urls, user)),
    milestone: issue.milestone ? milestoneJson(urls, repository, issue.milestone) : null,
    comments: issue.comments,
    created_at: iso(issue.createdAt),
    updated_at: iso(issue.updatedAt),
    closed_at: iso(issue.closedAt),
    closed_by: issue.closedBy ? userJson(urls, issue.closedBy) : null,
    author_association: association(repository, issue.author),
    body: issue.body,
    reactions: rollupJson(`${api}/issues/${issue.number}/reactions`, issue.reactions),
    ...(issue.isPull
      ? {
          draft: pull?.draft ?? false,
          pull_request: {
            url: `${api}/pulls/${issue.number}`,
            html_url: `${web}/pull/${issue.number}`,
            diff_url: `${web}/pull/${issue.number}.diff`,
            patch_url: `${web}/pull/${issue.number}.patch`,
            merged_at: iso(pull?.mergedAt ?? null),
          },
        }
      : {}),
  }
}

export const commentJson = (urls: Urls, repository: RepositorySubject, comment: IssueComment) => ({
  url: `${repoApi(urls, repository)}/issues/comments/${comment.id}`,
  html_url: `${repoWeb(urls, repository)}/issues/${comment.issueNumber}#issuecomment-${comment.id}`,
  issue_url: `${repoApi(urls, repository)}/issues/${comment.issueNumber}`,
  id: comment.id,
  node_id: comment.nodeId,
  user: userJson(urls, comment.author),
  created_at: iso(comment.createdAt),
  updated_at: iso(comment.updatedAt),
  author_association: association(repository, comment.author),
  body: comment.body,
  reactions: rollupJson(`${repoApi(urls, repository)}/issues/comments/${comment.id}/reactions`, comment.reactions),
})

export const eventJson = (urls: Urls, repository: RepositorySubject, event: IssueEvent) => ({
  id: event.id,
  node_id: event.nodeId,
  url: `${repoApi(urls, repository)}/issues/events/${event.id}`,
  actor: userJson(urls, event.actor),
  event: event.event,
  commit_id: (event.data.commit_id as string | undefined) ?? null,
  commit_url: event.data.commit_id ? `${repoApi(urls, repository)}/commits/${event.data.commit_id as string}` : null,
  created_at: iso(event.createdAt),
  ...Object.fromEntries(Object.entries(event.data).filter(([key]) => key !== 'commit_id')),
})

export const repositoryJson = (
  urls: Urls,
  repository: RepositorySubject,
  settings: CollaborationSettings,
  permissions: { readonly admin: boolean; readonly maintain: boolean; readonly push: boolean; readonly triage: boolean; readonly pull: boolean },
  defaultBranch: string,
) => ({
  id: repository.id,
  node_id: `R_${repository.id}`,
  name: repository.name,
  full_name: `${repository.owner}/${repository.name}`,
  private: repository.visibility === 'private',
  visibility: repository.visibility,
  description: repository.description,
  homepage: repository.homepage,
  topics: repository.topics,
  archived: repository.archived,
  disabled: false,
  owner: {
    login: repository.owner,
    id: repository.ownerId,
    type: repository.ownerKind === 'organization' ? 'Organization' : 'User',
    url: `${urls.api}/users/${enc(repository.owner)}`,
    html_url: `${urls.web}/${enc(repository.owner)}`,
  },
  html_url: repoWeb(urls, repository),
  url: repoApi(urls, repository),
  clone_url: `${repoWeb(urls, repository)}.git`,
  issues_url: `${repoApi(urls, repository)}/issues{/number}`,
  pulls_url: `${repoApi(urls, repository)}/pulls{/number}`,
  default_branch: defaultBranch,
  has_issues: settings.hasIssues,
  has_discussions: settings.hasDiscussions,
  has_projects: false,
  has_wiki: false,
  allow_merge_commit: settings.allowMergeCommit,
  allow_squash_merge: settings.allowSquashMerge,
  allow_rebase_merge: settings.allowRebaseMerge,
  read_can_participate: settings.readCanParticipate,
  permissions,
})

const branchJson = (urls: Urls, repository: RepositorySubject, ref: string, sha: ObjectId, owner: UserSummary) => ({
  label: `${repository.owner}:${ref}`,
  ref,
  sha,
  user: userJson(urls, owner),
  repo: { id: repository.id, name: repository.name, full_name: `${repository.owner}/${repository.name}`, private: repository.visibility === 'private', url: repoApi(urls, repository) },
})

export const pullJson = (urls: Urls, repository: RepositorySubject, pull: PullRequest | PullDetails, reviewComments = 0) => {
  const api = repoApi(urls, repository)
  const web = repoWeb(urls, repository)
  const issue = issueJson(urls, repository, pull, pull)
  const owner: UserSummary = { kind: 'user', id: repository.ownerId, login: repository.owner, name: null, email: null }
  const details = 'mergeableState' in pull ? pull : null
  return {
    url: `${api}/pulls/${pull.number}`,
    id: pull.id,
    node_id: pull.nodeId,
    html_url: `${web}/pull/${pull.number}`,
    diff_url: `${web}/pull/${pull.number}.diff`,
    patch_url: `${web}/pull/${pull.number}.patch`,
    issue_url: `${api}/issues/${pull.number}`,
    commits_url: `${api}/pulls/${pull.number}/commits`,
    review_comments_url: `${api}/pulls/${pull.number}/comments`,
    review_comment_url: `${api}/pulls/comments{/number}`,
    comments_url: `${api}/issues/${pull.number}/comments`,
    statuses_url: `${api}/statuses/${pull.headSha}`,
    number: pull.number,
    state: pull.state,
    locked: pull.locked,
    title: pull.title,
    user: issue.user,
    body: pull.body,
    labels: issue.labels,
    milestone: issue.milestone,
    active_lock_reason: pull.lockReason,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    merged_at: iso(pull.mergedAt),
    merge_commit_sha: pull.mergeCommitSha,
    assignee: issue.assignee,
    assignees: issue.assignees,
    requested_reviewers: pull.requestedReviewers.map((user) => userJson(urls, user)),
    requested_teams: [],
    head: pull.headRepository
      ? branchJson(urls, pull.headRepository, pull.headRef, pull.headSha, { kind: 'user', id: pull.headRepository.ownerId, login: pull.headRepository.owner, name: null, email: null })
      : branchJson(urls, repository, pull.headRef, pull.headSha, owner),
    base: branchJson(urls, repository, pull.baseRef, pull.baseSha, owner),
    author_association: issue.author_association,
    auto_merge: null,
    draft: pull.draft,
    merged: pull.merged,
    merged_by: pull.mergedBy ? userJson(urls, pull.mergedBy) : null,
    merge_method: pull.mergeMethod,
    comments: pull.comments,
    review_comments: reviewComments,
    maintainer_can_modify: pull.maintainerCanModify,
    ...(details
      ? {
          mergeable: details.mergeable,
          rebaseable: details.rebaseable,
          mergeable_state: details.mergeableState,
          merge_conflicts: details.conflicts,
          merge_blockers: details.blockers,
          merge_base_sha: details.mergeBase,
          commits: details.commits,
          additions: details.additions,
          deletions: details.deletions,
          changed_files: details.changedFiles,
        }
      : {}),
  }
}

export const commitJson = (urls: Urls, repository: RepositorySubject, commit: PullCommit) => {
  const api = repoApi(urls, repository)
  return {
    sha: commit.sha,
    node_id: `C_${commit.sha}`,
    commit: {
      author: { name: commit.author.name, email: commit.author.email, date: signatureDate(commit.author) },
      committer: { name: commit.committer.name, email: commit.committer.email, date: signatureDate(commit.committer) },
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree, url: `${api}/git/trees/${commit.tree}` },
      url: `${api}/git/commits/${commit.sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `${api}/commits/${commit.sha}`,
    html_url: `${repoWeb(urls, repository)}/commit/${commit.sha}`,
    comments_url: `${api}/commits/${commit.sha}/comments`,
    author: null,
    committer: null,
    parents: commit.parents.map((sha) => ({ sha, url: `${api}/commits/${sha}`, html_url: `${repoWeb(urls, repository)}/commit/${sha}` })),
  }
}

const FILE_STATUS: Readonly<Record<FileDiff['status'], string>> = { added: 'added', removed: 'removed', modified: 'modified', renamed: 'renamed' }

export const fileJson = (urls: Urls, repository: RepositorySubject, head: ObjectId, file: FileDiff) => {
  const web = repoWeb(urls, repository)
  const path = file.path.split('/').map(enc).join('/')
  return {
    sha: file.newId ?? file.oldId,
    filename: file.path,
    status: file.status === 'modified' && file.oldMode !== file.newMode && file.oldId === file.newId ? 'changed' : FILE_STATUS[file.status],
    additions: file.additions,
    deletions: file.deletions,
    changes: file.additions + file.deletions,
    blob_url: `${web}/blob/${head}/${path}`,
    raw_url: `${web}/raw/${head}/${path}`,
    contents_url: `${repoApi(urls, repository)}/contents/${path}?ref=${head}`,
    ...(file.kind === 'text' || file.kind === 'lfs' ? { patch: formatHunks(file.hunks).replace(/\n$/, '') } : {}),
    ...(file.previousPath ? { previous_filename: file.previousPath } : {}),
    kind: file.kind,
    ...(file.lfs ? { lfs: file.lfs } : {}),
  }
}

export const reviewJson = (urls: Urls, repository: RepositorySubject, review: Review) => ({
  id: review.id,
  node_id: review.nodeId,
  user: userJson(urls, review.author),
  body: review.body ?? '',
  state: review.state,
  html_url: `${repoWeb(urls, repository)}/pull/${review.pullNumber}#pullrequestreview-${review.id}`,
  pull_request_url: `${repoApi(urls, repository)}/pulls/${review.pullNumber}`,
  author_association: association(repository, review.author),
  submitted_at: iso(review.submittedAt),
  commit_id: review.commitId,
  ...(review.dismissedAt ? { dismissed_at: iso(review.dismissedAt), dismissal_message: review.dismissalMessage } : {}),
})

export const reviewCommentJson = (urls: Urls, repository: RepositorySubject, comment: ReviewComment) => ({
  url: `${repoApi(urls, repository)}/pulls/comments/${comment.id}`,
  pull_request_review_id: comment.reviewId,
  id: comment.id,
  node_id: comment.nodeId,
  diff_hunk: comment.diffHunk,
  path: comment.path,
  position: comment.outdated ? null : comment.line,
  original_position: comment.originalLine,
  commit_id: comment.commitId,
  original_commit_id: comment.originalCommitId,
  ...(comment.inReplyToId !== null ? { in_reply_to_id: comment.inReplyToId } : {}),
  user: userJson(urls, comment.author),
  body: comment.body,
  created_at: iso(comment.createdAt),
  updated_at: iso(comment.updatedAt),
  html_url: `${repoWeb(urls, repository)}/pull/${comment.pullNumber}#discussion_r${comment.id}`,
  pull_request_url: `${repoApi(urls, repository)}/pulls/${comment.pullNumber}`,
  author_association: association(repository, comment.author),
  start_line: comment.startLine,
  original_start_line: comment.originalStartLine,
  start_side: comment.startSide,
  line: comment.line,
  original_line: comment.originalLine,
  side: comment.side,
  subject_type: 'line',
  reactions: rollupJson(`${repoApi(urls, repository)}/pulls/comments/${comment.id}/reactions`, comment.reactions),
})

export const statusJson = (urls: Urls, repository: RepositorySubject, status: CommitStatus) => ({
  url: `${repoApi(urls, repository)}/statuses/${status.sha}`,
  id: status.id,
  node_id: status.nodeId,
  state: status.state,
  description: status.description,
  target_url: status.targetUrl,
  context: status.context,
  created_at: iso(status.createdAt),
  updated_at: iso(status.createdAt),
  creator: userJson(urls, status.creator),
})

export const combinedStatusJson = (urls: Urls, repository: RepositorySubject, combined: CombinedStatus) => ({
  state: combined.state,
  statuses: combined.statuses.map((status) => statusJson(urls, repository, status)),
  sha: combined.sha,
  total_count: combined.statuses.length,
  repository: { id: repository.id, name: repository.name, full_name: `${repository.owner}/${repository.name}` },
  commit_url: `${repoApi(urls, repository)}/commits/${combined.sha}`,
  url: `${repoApi(urls, repository)}/commits/${combined.sha}/status`,
})

export const checkRunJson = (urls: Urls, repository: RepositorySubject, run: CheckRun) => ({
  id: run.id,
  node_id: run.nodeId,
  head_sha: run.headSha,
  external_id: run.externalId,
  url: `${repoApi(urls, repository)}/check-runs/${run.id}`,
  html_url: `${repoWeb(urls, repository)}/runs/${run.id}`,
  details_url: run.detailsUrl,
  status: run.status,
  conclusion: run.conclusion,
  started_at: iso(run.startedAt),
  completed_at: iso(run.completedAt),
  output: { ...run.output, annotations_count: 0, annotations_url: `${repoApi(urls, repository)}/check-runs/${run.id}/annotations` },
  name: run.name,
  check_suite: null,
  app: run.creator.kind === 'app' ? { slug: run.creator.login.replace(/\[bot\]$/, ''), name: run.creator.name } : null,
  pull_requests: [],
})

export const categoryJson = (category: DiscussionCategory) => ({
  id: category.id,
  node_id: category.nodeId,
  slug: category.slug,
  name: category.name,
  emoji: category.emoji,
  description: category.description,
  is_answerable: category.answerable,
  created_at: iso(category.createdAt),
})

export const discussionJson = (urls: Urls, repository: RepositorySubject, discussion: Discussion) => ({
  id: discussion.id,
  node_id: discussion.nodeId,
  number: discussion.number,
  url: `${repoApi(urls, repository)}/discussions/${discussion.number}`,
  html_url: `${repoWeb(urls, repository)}/discussions/${discussion.number}`,
  repository_url: repoApi(urls, repository),
  category: categoryJson(discussion.category),
  title: discussion.title,
  body: discussion.body,
  user: userJson(urls, discussion.author),
  state: discussion.state,
  state_reason: discussion.stateReason,
  locked: discussion.locked,
  comments: discussion.comments,
  answer_comment_id: discussion.answerCommentId,
  answer_html_url: discussion.answerCommentId ? `${repoWeb(urls, repository)}/discussions/${discussion.number}#discussioncomment-${discussion.answerCommentId}` : null,
  answer_chosen_at: iso(discussion.answerChosenAt),
  answer_chosen_by: discussion.answerChosenBy ? userJson(urls, discussion.answerChosenBy) : null,
  author_association: association(repository, discussion.author),
  created_at: iso(discussion.createdAt),
  updated_at: iso(discussion.updatedAt),
  closed_at: iso(discussion.closedAt),
})

export const discussionCommentJson = (urls: Urls, repository: RepositorySubject, comment: DiscussionComment) => ({
  id: comment.id,
  node_id: comment.nodeId,
  parent_id: comment.parentId,
  html_url: `${repoWeb(urls, repository)}/discussions/${comment.discussionNumber}#discussioncomment-${comment.id}`,
  discussion_url: `${repoApi(urls, repository)}/discussions/${comment.discussionNumber}`,
  user: userJson(urls, comment.author),
  body: comment.body,
  is_answer: comment.isAnswer,
  child_comment_count: comment.replies,
  author_association: association(repository, comment.author),
  created_at: iso(comment.createdAt),
  updated_at: iso(comment.updatedAt),
})
