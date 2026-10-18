# @git-forge/collaboration

Issues, pull requests, reviews, commit statuses, check runs and discussions
for git-forge, plus a GitHub-compatible REST API under `/api/v3`. Design and
rationale: [docs/design.md §17](../../docs/design.md#17-collaboration).

Collaboration data lives only in the instance's SQLite database (D1, libSQL,
a file). It is never written to the bucket and never synced to mirrors; the
only Git writes are merge results (new objects in a new pack, then a
compare-and-swap of the base branch), which are ordinary repository content.

Everything in `src/` uses web-standard APIs and SQLite SQL only. Git work
(tree and line diffs, merge bases, merges, conflicts) is done by pure
functions in `@git-forge/core`; this package decides who may do what and
stores the results.

## Use

```ts
import { handleCollaborationApi, handlePushedRefs, openRepository, createIssue, mergePull, systemScope } from '@git-forge/collaboration'

const options = {
  db,
  storage,
  accounts: createAccountsStore(db),
  onBranchUpdated: async (update) => runPushPipeline(update),
  onActivity: async (scope, activity) => notifications.emit(toForgeEvent(scope, activity)),
}

// HTTP: returns null for paths it does not own (e.g. /api/v3/repos/{o}/{r}/actions/…);
// authenticate defaults to token auth, the Worker passes its session-aware apiPrincipal
handleCollaborationApi(request, { ...options, verifyInstance, publicUrl, authenticate })

// UI or any other caller: the same functions with a principal from a verified token or session
const scope = await openRepository(options, principal, 'acme', 'site')
await createIssue(scope, { title: 'Broken link', body: 'See #3' })
await mergePull(scope, 4, { method: 'squash' })

// after a push (receive-pack onPush): refresh pull requests, dismiss stale reviews, close issues
const system = await systemScope(options, 'acme', 'site')
if (system) await handlePushedRefs(system, outcome.results.filter((result) => result.ok), { kind: 'user', id: pusherId })
```

`openRepository` resolves the actor's access once from the verified principal
(`resolveAccess` of `@git-forge/accounts`; instance admins count as admins,
token ceilings and repository restrictions still apply). Every service
function checks its permission through `allowed()` before touching the
database, so the HTTP layer and a UI share one permission implementation.

## Activity

Every service function reports what happened through `onActivity(scope,
activity)` after its writes: `{ kind, action, number, actor, commentId?,
reviewId?, changes?, requestedReviewer?, before?, after? }` with `kind`
`issues`, `issue_comment`, `pull_request`, `pull_request_review` or
`pull_request_review_comment` and GitHub's webhook action names (`opened`,
`edited`, `closed`, `reopened`, `labeled`, `assigned`, `locked`,
`synchronize`, `review_requested`, `ready_for_review`, `submitted`,
`dismissed`, `created`, …). Edits made through the issue endpoints on a pull
request are reported as `pull_request`. The package does not depend on
`@git-forge/notifications`; the Worker maps activities to its events
(`apps/forge-worker/src/collaboration-events.ts`) and calls
`notifications.emit`, so webhooks, the inbox and e-mail digests see the same
activity whether it came from the API or the UI. A failing handler is logged
and never fails the operation.

## Permissions

`allowed(permission, subject)` is pure. A subject is the resolved access
(`none` … `admin`), whether the caller is authenticated and holds a writable
token (`repo:read` tokens never mutate anything), whether it authored the
item, whether the conversation is locked, and the repository's
collaboration settings.

| Permission | Role | Author may | Readers when `read_can_participate` |
|---|---|---|---|
| `view` | read | | |
| `issue:create`, `pull:create`, `discussion:create`, `comment:create`, `review:submit` | triage | | yes |
| `issue:edit`, `pull:edit`, `discussion:edit`, `comment:edit` (and delete) | write | yes | |
| `issue:close`, `pull:close`, `discussion:close`, `discussion:answer` | triage | yes | |
| `issue:triage` (labels, assignees, milestone), `issue:lock`, `discussion:lock`, `review:request` | triage | | |
| `label:manage`, `milestone:manage`, `pull:merge`, `review:dismiss`, `status:write` | write | | |
| `discussion:category` (also needed to post in *Announcements*) | maintain | | |
| `settings:manage`, `import` | admin | | |

Locked conversations accept comments and reviews from `write` and above
only. `has_issues: false` disables creating issues, `has_discussions: false`
disables discussions (`410`). Labels, assignees and a milestone sent with a
new issue or pull request by someone without `issue:triage` are dropped
silently, as on GitHub.

## Numbering and references

Issues, pull requests and discussions share one number sequence per
repository (`repository_numbers`, allocated as `MAX + 1` inside the insert
batch, unique per repository). Bodies are stored as raw Markdown. `#N` and
`owner/repo#N` outside code spans and fenced blocks create a
`cross-referenced` event on the target (once per source). Closing keywords
(`close[sd]`, `fix(es|ed)`, `resolve[sd]`, optional colon) in a pull
request's title, body or commit messages close the referenced issues when it
is merged into the default branch; commits pushed directly to the default
branch do the same.

## Pull requests

- Same-repository branches only (`head` may be `owner:branch` with the
  repository owner). Forks come later.
- The head and base shas are refreshed from `refs.json` on every read and on
  every push (`handlePushedRefs`): a moved head records `synchronize` or
  `head_ref_force_pushed` and, if the base branch's protection rule has
  `dismiss_stale_reviews`, dismisses all approvals; a base branch that
  contains the head marks the pull request merged (a merge done with plain
  `git push`).
- Files and diff are computed between the merge base and the head
  (three-dot, like GitHub); commits are `base..head`, parents first.
- `mergeable`, `rebaseable` and the conflicts are computed by
  `checkMergeability` (core) and cached per `base:head` pair.
  `mergeable_state` is `draft`, `dirty` (conflicts), `behind` (only the
  strict status check fails), `blocked` (other protection problems) or
  `clean`.
- Merging (`merge`, `squash`, `rebase`) builds the objects in core,
  evaluates `evaluateBranchUpdate(rule, actor, update, { via: 'pull-request', … })`
  with approvals (latest review per reviewer with write access, the author's
  own reviews never count), requested changes, the last-push approval, the
  up-to-date flag and the latest commit statuses and check runs of the head,
  then stores one pack and moves the base branch with compare-and-swap. A
  base that moved in between is retried. `onBranchUpdated` lets the host
  start CI and notify mirrors exactly as after a push.
- `require_code_owner_reviews` is satisfied only when the base has no
  `CODEOWNERS` file (`.github/`, root, `docs/`); parsing owners comes later.
- Commit messages: merge `Merge pull request #N from owner/branch` + title,
  squash `title (#N)` + bullet list of the commit messages (or the single
  commit's body), rebase keeps the original messages and authors. The merger
  is the committer (and the author of merge commits); the pull request author
  is the squash author. Signatures use the account's display name and e-mail
  (fallback `login@users.noreply.invalid`, see `noreplyDomain`).

## Reviews and line comments

A review is `PENDING` (visible only to its author), `COMMENTED`, `APPROVED`,
`CHANGES_REQUESTED` or `DISMISSED`. Line comments are anchored to
`commit_id + path + line + side` (with optional `start_line`/`start_side` for
ranges) and validated against the diff of that commit (the line must be part
of a hunk). When the head moves and the file's blob at the head differs from
the commented commit, the comment is outdated (`line: null`, `original_line`
kept). Replies inherit the anchor of the thread's first comment.

## Statuses and check runs

`POST /statuses/{sha}` stores commit statuses (append-only, latest per
context wins); check runs are created and updated through `/check-runs`. The
CI package writes them with `recordCommitStatus` / `recordCheckRun` /
`updateCheckRunRecord` (system or app actor) without going through HTTP.
`checkStates(db, repositoryId, sha)` maps both to the `CheckState` record
that branch protection evaluates; for a name present as status and as check
run, the worse state wins.

## Discussions

Separate from issues as on GitHub: categories (created on first use:
General, Q&A (answerable), Ideas, Announcements), threads with one level of
replies, an answer per discussion in answerable categories (chosen by the
author or triage+), close with a reason, lock.

## REST API (`/api/v3`)

GitHub shapes where reasonable; IDs are integers except users and
repositories (accounts use UUIDs). Pagination with `page`/`per_page`
(≤ 100) and a `Link` header. Errors are `{ message, errors?, documentation_url }`.

| Route | Notes |
|---|---|
| `GET\|PATCH /repos/{o}/{r}` | repository with `permissions`; `PATCH` (admin) sets `has_issues`, `has_discussions`, `read_can_participate`, `allow_merge_commit`, `allow_squash_merge`, `allow_rebase_merge` |
| `GET\|POST /repos/{o}/{r}/issues`, `GET\|PATCH …/issues/{n}` | filters `state`, `labels`, `assignee` (`none`, `*`), `creator`, `milestone` (`none`, `*`), `since`, `sort`, `direction`; pull requests are included like on GitHub |
| `GET\|POST …/issues/{n}/comments`, `GET …/issues/comments`, `GET\|PATCH\|DELETE …/issues/comments/{id}` | |
| `GET\|POST\|PUT\|DELETE …/issues/{n}/labels[/{name}]`, `POST\|DELETE …/issues/{n}/assignees`, `PUT\|DELETE …/issues/{n}/lock` | unknown labels are created by writers |
| `GET …/issues/{n}/events`, `GET …/issues/{n}/timeline` | |
| `GET\|POST …/labels`, `GET\|PATCH\|DELETE …/labels/{name}`, `GET\|POST …/milestones`, `GET\|PATCH\|DELETE …/milestones/{n}` | |
| `GET\|POST …/pulls`, `GET\|PATCH …/pulls/{n}` | `Accept: application/vnd.github.diff` returns the diff; extra fields `merge_conflicts`, `merge_blockers`, `merge_base_sha` |
| `GET …/pulls/{n}/commits`, `GET …/pulls/{n}/files` | files carry `kind` (`text`, `binary`, `lfs`, `submodule`, `large`) and `lfs` pointers |
| `GET\|PUT …/pulls/{n}/merge` | `merge_method`, `commit_title`, `commit_message`, `sha`; `405` not mergeable or blocked, `409` head moved |
| `GET\|POST …/pulls/{n}/reviews`, `GET\|PUT\|DELETE …/reviews/{id}`, `POST …/reviews/{id}/events`, `PUT …/reviews/{id}/dismissals`, `GET …/reviews/{id}/comments` | |
| `GET\|POST …/pulls/{n}/comments`, `POST …/pulls/{n}/comments/{id}/replies`, `GET …/pulls/comments`, `GET\|PATCH\|DELETE …/pulls/comments/{id}` | |
| `GET\|POST\|DELETE …/pulls/{n}/requested_reviewers` | users only |
| `POST …/statuses/{sha}`, `GET …/commits/{ref}/statuses`, `GET …/commits/{ref}/status` | |
| `POST …/check-runs`, `GET\|PATCH …/check-runs/{id}`, `GET …/commits/{ref}/check-runs` | |
| `GET\|POST …/discussion-categories`, `GET\|PATCH\|DELETE …/discussion-categories/{slug}` | not in GitHub's REST API (GraphQL only there) |
| `GET\|POST …/discussions`, `GET\|PATCH …/discussions/{n}`, `PUT\|DELETE …/discussions/{n}/lock`, `PUT\|DELETE …/discussions/{n}/answer` | |
| `GET\|POST …/discussions/{n}/comments` (`reply_to_id`), `GET\|PATCH\|DELETE …/discussions/comments/{id}` | |

## Tests

`pnpm --filter @git-forge/collaboration test`: pure permission and reference
tests, service tests on `node:sqlite` with real `git` histories (merge,
squash and rebase results are compared commit by commit with `git merge
--no-ff`, `git merge --squash` and `git rebase --force-rebase`), and REST
tests. The end-to-end test with the real git client against `wrangler dev`
is `apps/forge-worker/test/e2e/collaboration.e2e.test.ts`.
