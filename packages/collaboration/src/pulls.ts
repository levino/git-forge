import {
  evaluateBranchUpdate,
  first,
  protectionActor,
  selectProtectionRule,
  sql,
  type Statement,
  type UpdateEvidence,
} from '@git-forge/accounts'
import {
  checkMergeability,
  commitsBetween,
  type CommitDetails,
  diffTreesWithContent,
  type FileDiff,
  formatFileDiff,
  MERGE_METHODS,
  type MergeConflict,
  type Mergeability,
  type MergeMethod,
  mergeBases,
  mergeBranches,
  type ObjectId,
  parseCommit,
  readCommitDetails,
  type RefsState,
  resolvePath,
  type Signature,
  signatureAt,
  storeObjects,
  updateRefs,
  ZERO_ID,
} from '@git-forge/core'
import { actorColumns, loadUsers, type UserSummary } from './actors.ts'
import {
  type ActorRef,
  CollaborationError,
  type CollaborationOptions,
  emitActivity,
  type EventActor,
  invalid,
  nodeId,
  notFound,
  readSettings,
  refFromColumns,
  requirePermission,
  type Scope,
  SYSTEM_ACTOR,
} from './context.ts'
import { branchName, branchRef, branchTip, currentRefs, defaultBranch, objectDatabase } from './git.ts'
import {
  allIn,
  chunked,
  closeIssuesByReference,
  crossReferenceStatements,
  DEFAULT_PAGE,
  emitIssueChanges,
  eventStatement,
  hydrateIssues,
  insertIssueStatements,
  type Issue,
  type IssueState,
  type IssueUpdate,
  offset,
  type Page,
  type Paged,
  placeholders,
  updateIssueStatements,
} from './issues.ts'
import { PULL_SELECT, type PullRow, pullRow, recentCommits, refreshPull } from './pull-rows.ts'
import { listRequestedReviewers, reviewEvidence } from './reviews.ts'
import { checkStates } from './statuses.ts'

export type PullRequest = Issue & {
  readonly headRef: string
  readonly baseRef: string
  readonly headSha: ObjectId
  readonly baseSha: ObjectId
  readonly draft: boolean
  readonly merged: boolean
  readonly mergedAt: number | null
  readonly mergedBy: UserSummary | null
  readonly mergeCommitSha: ObjectId | null
  readonly mergeMethod: MergeMethod | null
  readonly requestedReviewers: readonly UserSummary[]
}

export type MergeableState = 'clean' | 'dirty' | 'blocked' | 'behind' | 'draft' | 'unknown'

export type PullDetails = PullRequest & {
  readonly mergeable: boolean | null
  readonly rebaseable: boolean | null
  readonly mergeableState: MergeableState
  readonly conflicts: readonly MergeConflict[]
  readonly blockers: readonly string[]
  readonly mergeBase: ObjectId | null
  readonly commits: number
  readonly additions: number
  readonly deletions: number
  readonly changedFiles: number
}

const hydratePulls = async (scope: Scope, rows: readonly PullRow[]): Promise<PullRequest[]> => {
  const issues = await hydrateIssues(scope.db, rows)
  const requests = await allIn<{ issue_id: number; user_id: string }>(
    scope.db,
    (marks) => `SELECT issue_id, user_id FROM review_requests WHERE issue_id IN (${marks}) ORDER BY created_at, rowid`,
    rows.map((row) => row.id),
  )
  const users = await loadUsers(scope.db, [
    ...rows.map((row) => ({ kind: row.merged_by_kind, id: row.merged_by_id })),
    ...requests.map((request) => ({ kind: 'user', id: request.user_id })),
  ])
  return rows.map((row, index) => ({
    ...issues[index]!,
    headRef: branchName(row.head_ref),
    baseRef: branchName(row.base_ref),
    headSha: row.head_sha,
    baseSha: row.base_sha,
    draft: row.draft === 1,
    merged: row.merged_at !== null,
    mergedAt: row.merged_at,
    mergedBy: row.merged_by_kind ? users({ kind: row.merged_by_kind, id: row.merged_by_id }) : null,
    mergeCommitSha: row.merge_commit_sha,
    mergeMethod: row.merge_method,
    requestedReviewers: requests.filter((request) => request.issue_id === row.id).map((request) => users({ kind: 'user', id: request.user_id })),
  }))
}

const parseHead = (scope: Scope, head: unknown): string => {
  if (typeof head !== 'string' || head === '') throw invalid('head is required')
  const colon = head.indexOf(':')
  if (colon === -1) return head
  if (head.slice(0, colon).toLowerCase() !== scope.repository.owner.toLowerCase()) throw invalid('pull requests from forks are not supported yet')
  return head.slice(colon + 1)
}

const requireBranch = (state: RefsState, branch: unknown, field: string): { ref: string; tip: ObjectId } => {
  if (typeof branch !== 'string' || branch === '') throw invalid(`${field} is required`)
  const tip = branchTip(state, branch)
  if (!tip) throw new CollaborationError(422, 'Validation Failed', [{ resource: 'PullRequest', field, code: 'invalid' }])
  return { ref: branchRef(branch), tip }
}

export type PullInput = {
  readonly title?: unknown
  readonly body?: unknown
  readonly head?: unknown
  readonly base?: unknown
  readonly draft?: unknown
}

export const createPull = async (scope: Scope, input: PullInput): Promise<PullDetails> => {
  const author = requirePermission(scope, 'pull:create')
  const state = await currentRefs(scope)
  const head = requireBranch(state, parseHead(scope, input.head), 'head')
  const base = requireBranch(state, input.base, 'base')
  if (head.ref === base.ref) throw invalid('head and base must be different branches')
  if (input.draft !== undefined && typeof input.draft !== 'boolean') throw invalid('draft must be a boolean')
  const existing = await first(
    scope.db,
    sql(
      "SELECT p.issue_id FROM pull_requests p JOIN issues i ON i.id = p.issue_id WHERE p.repository_id = ? AND p.head_ref = ? AND p.base_ref = ? AND i.state = 'open'",
      scope.repository.id,
      head.ref,
      base.ref,
    ),
  )
  if (existing) throw invalid(`A pull request already exists for ${scope.repository.owner}:${branchName(head.ref)}.`)
  const odb = objectDatabase(scope)
  const bases = await mergeBases(odb, base.tip, head.tip)
  if (bases.length === 0) throw invalid(`The ${branchName(head.ref)} branch has no history in common with ${branchName(base.ref)}`)
  if (bases.includes(head.tip)) throw invalid(`No commits between ${branchName(base.ref)} and ${branchName(head.ref)}`)
  const node = nodeId('PR')
  const statements = await insertIssueStatements(scope, author, node, input, 'pull')
  statements.push(
    sql(
      'INSERT INTO pull_requests (issue_id, repository_id, head_ref, base_ref, head_sha, base_sha, draft, last_pusher_kind, last_pusher_id) SELECT id, ?, ?, ?, ?, ?, ?, ?, ? FROM issues WHERE node_id = ?',
      scope.repository.id,
      head.ref,
      base.ref,
      head.tip,
      base.tip,
      input.draft === true ? 1 : 0,
      author.kind,
      author.id,
      node,
    ),
  )
  await scope.db.batch(statements)
  const row = (await first<PullRow>(scope.db, sql(`${PULL_SELECT} WHERE i.node_id = ?`, node)))!
  const references = await crossReferenceStatements(scope, { number: row.number, isPull: true }, row.body, author)
  if (references.length > 0) await scope.db.batch(references)
  const created = await getPull(scope, row.number)
  await emitActivity(scope, { kind: 'pull_request', action: 'opened', number: created.number, actor: author })
  return created
}

export type PullFilters = {
  readonly state?: IssueState | 'all'
  readonly head?: string
  readonly base?: string
  readonly sort?: 'created' | 'updated'
  readonly direction?: 'asc' | 'desc'
}

export const listPulls = async (scope: Scope, filters: PullFilters = {}, page: Page = DEFAULT_PAGE): Promise<Paged<PullRequest>> => {
  const where = ['i.repository_id = ?']
  const params: (string | number)[] = [scope.repository.id]
  const state = filters.state ?? 'open'
  if (state !== 'all') {
    where.push('i.state = ?')
    params.push(state)
  }
  if (filters.head !== undefined) {
    where.push('p.head_ref = ?')
    params.push(branchRef(parseHead(scope, filters.head)))
  }
  if (filters.base !== undefined) {
    where.push('p.base_ref = ?')
    params.push(branchRef(filters.base))
  }
  const column = filters.sort === 'updated' ? 'i.updated_at' : 'i.created_at'
  const direction = filters.direction === 'asc' ? 'ASC' : 'DESC'
  const clause = where.join(' AND ')
  const total = (await first<{ count: number }>(scope.db, sql(`SELECT COUNT(*) AS count FROM issues i JOIN pull_requests p ON p.issue_id = i.id WHERE ${clause}`, ...params)))?.count ?? 0
  const rows = await scope.db.all<PullRow>(sql(`${PULL_SELECT} WHERE ${clause} ORDER BY ${column} ${direction}, i.number ${direction} LIMIT ? OFFSET ?`, ...params, page.perPage, offset(page)))
  return { items: await hydratePulls(scope, rows), total }
}

const compareBase = async (scope: Scope, row: PullRow, state: RefsState): Promise<ObjectId | null> => {
  const base = row.merged_at === null && row.state === 'open' ? (branchTip(state, row.base_ref) ?? row.base_sha) : row.base_sha
  return (await mergeBases(objectDatabase(scope), base, row.head_sha))[0] ?? null
}

const treeOf = async (scope: Scope, commit: ObjectId | null): Promise<ObjectId | null> => {
  if (commit === null) return null
  const object = await objectDatabase(scope).read(commit)
  return object?.type === 'commit' ? parseCommit(object.data).tree : null
}

const loadFresh = async (scope: Scope, number: number): Promise<{ row: PullRow; state: RefsState }> => {
  const state = await currentRefs(scope)
  return { row: await refreshPull(scope, await pullRow(scope, number), state, null), state }
}

export const pullFiles = async (scope: Scope, number: number): Promise<FileDiff[]> => {
  const { row, state } = await loadFresh(scope, number)
  return diffTreesWithContent(objectDatabase(scope), await treeOf(scope, await compareBase(scope, row, state)), await treeOf(scope, row.head_sha))
}

export const pullDiff = async (scope: Scope, number: number): Promise<string> => (await pullFiles(scope, number)).map(formatFileDiff).join('')

export type PullCommit = CommitDetails & { readonly sha: ObjectId }

export const MAX_PULL_COMMITS = 250

export const pullCommits = async (scope: Scope, number: number): Promise<PullCommit[]> => {
  const { row, state } = await loadFresh(scope, number)
  const base = row.merged_at === null && row.state === 'open' ? (branchTip(state, row.base_ref) ?? row.base_sha) : row.base_sha
  const odb = objectDatabase(scope)
  const ids = (await commitsBetween(odb, base, row.head_sha)).slice(0, MAX_PULL_COMMITS)
  return Promise.all(ids.map(async (sha) => ({ sha, ...(await readCommitDetails(odb, sha)) })))
}

type CachedCheck = Mergeability

const mergeability = async (scope: Scope, row: PullRow, base: ObjectId, head: ObjectId): Promise<CachedCheck> => {
  const key = `${base}:${head}`
  if (row.check_key === key && row.check_result) return JSON.parse(row.check_result) as CachedCheck
  const result = await checkMergeability(objectDatabase(scope), base, head)
  await scope.db.run(sql('UPDATE pull_requests SET check_key = ?, check_result = ? WHERE issue_id = ?', key, JSON.stringify(result), row.id))
  return result
}

const CODEOWNERS_PATHS = [['.github', 'CODEOWNERS'], ['CODEOWNERS'], ['docs', 'CODEOWNERS']]

const hasCodeOwners = async (scope: Scope, commit: ObjectId): Promise<boolean> => {
  const odb = objectDatabase(scope)
  for (const path of CODEOWNERS_PATHS) if (await resolvePath(odb, commit, path)) return true
  return false
}

const protectionProblems = async (scope: Scope, row: PullRow, base: ObjectId, head: ObjectId, upToDate: boolean, newId: ObjectId): Promise<readonly string[]> => {
  const rules = await scope.accounts.branchProtectionRules(scope.repository.id)
  const rule = selectProtectionRule(rules, branchName(row.base_ref))
  if (!rule) return []
  const reviews = await reviewEvidence(scope, row)
  const evidence: UpdateEvidence = {
    via: 'pull-request',
    approvals: reviews.approvals,
    changesRequested: reviews.changesRequested,
    codeOwnerApproved: !(await hasCodeOwners(scope, base)),
    lastPushApproved: reviews.lastPushApproved,
    upToDate,
    statuses: await checkStates(scope.db, scope.repository.id, head),
  }
  const actor = await protectionActor(scope.accounts, scope.actor.principal, scope.repository, scope.actor.access)
  return evaluateBranchUpdate(rule, actor, { ref: row.base_ref, oldId: base, newId, fastForward: true }, evidence)
}

const PLACEHOLDER = 'f'.repeat(40)

export const getPullSummary = async (scope: Scope, number: number): Promise<PullRequest> => (await hydratePulls(scope, [await pullRow(scope, number)]))[0]!

export const getPull = async (scope: Scope, number: number): Promise<PullDetails> => {
  const { row, state } = await loadFresh(scope, number)
  const [pull] = await hydratePulls(scope, [row])
  const base = branchTip(state, row.base_ref)
  const head = branchTip(state, row.head_ref)
  const mergeBase = await compareBase(scope, row, state)
  const odb = objectDatabase(scope)
  const files = await diffTreesWithContent(odb, await treeOf(scope, mergeBase), await treeOf(scope, row.head_sha), { maxBlobBytes: 256 * 1024 })
  const commits = (await commitsBetween(odb, row.merged_at === null ? (base ?? row.base_sha) : row.base_sha, row.head_sha)).length
  const stats = {
    mergeBase,
    commits,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    changedFiles: files.length,
  }
  if (row.state !== 'open' || base === null || head === null || head !== row.head_sha) {
    return { ...pull!, ...stats, mergeable: null, rebaseable: null, mergeableState: 'unknown', conflicts: [], blockers: [] }
  }
  const check = await mergeability(scope, row, base, head)
  const blockers = check.mergeable ? await protectionProblems(scope, row, base, head, check.upToDate, PLACEHOLDER) : []
  const mergeableState: MergeableState =
    row.draft === 1
      ? 'draft'
      : !check.mergeable
        ? 'dirty'
        : blockers.length === 0
          ? 'clean'
          : blockers.every((problem) => problem === 'branch must be up to date before merging')
            ? 'behind'
            : 'blocked'
  return { ...pull!, ...stats, mergeable: check.mergeable, rebaseable: check.rebaseable, mergeableState, conflicts: check.conflicts, blockers }
}

export type PullUpdate = IssueUpdate & { readonly base?: unknown; readonly draft?: unknown }

export const updatePull = async (scope: Scope, number: number, input: PullUpdate): Promise<PullDetails> => {
  const { row, state } = await loadFresh(scope, number)
  const [before] = await hydratePulls(scope, [row])
  const statements: Statement[] = await updateIssueStatements(scope, row, input)
  const author = refFromColumns(row.author_kind, row.author_id)
  const at = scope.now()
  if (input.base !== undefined) {
    const actor = requirePermission(scope, 'pull:edit', { author })
    if (row.merged_at !== null) throw invalid('Cannot change the base branch of a merged pull request')
    const base = requireBranch(state, input.base, 'base')
    if (base.ref === row.head_ref) throw invalid('head and base must be different branches')
    if (base.ref !== row.base_ref) {
      statements.push(
        sql('UPDATE pull_requests SET base_ref = ?, base_sha = ?, check_key = NULL, check_result = NULL WHERE issue_id = ?', base.ref, base.tip, row.id),
        eventStatement(row.id, actor, 'base_ref_changed', { from: branchName(row.base_ref), to: branchName(base.ref) }, at),
      )
    }
  }
  if (input.draft !== undefined) {
    const actor = requirePermission(scope, 'pull:edit', { author })
    if (typeof input.draft !== 'boolean') throw invalid('draft must be a boolean')
    if ((row.draft === 1) !== input.draft) {
      statements.push(
        sql('UPDATE pull_requests SET draft = ? WHERE issue_id = ?', input.draft ? 1 : 0, row.id),
        eventStatement(row.id, actor, input.draft ? 'convert_to_draft' : 'ready_for_review', {}, at),
      )
    }
  }
  if (statements.length === 0) return getPull(scope, number)
  await scope.db.batch(statements)
  const after = await getPull(scope, number)
  const actor = scope.actor.ref!
  await emitIssueChanges(scope, before!, after, actor)
  if (before!.draft !== after.draft) await emitActivity(scope, { kind: 'pull_request', action: after.draft ? 'converted_to_draft' : 'ready_for_review', number, actor })
  if (before!.baseRef !== after.baseRef) await emitActivity(scope, { kind: 'pull_request', action: 'edited', number, actor, changes: { base: { ref: { from: before!.baseRef } } } })
  return after
}

const METHOD_SETTING: Readonly<Record<MergeMethod, 'allowMergeCommit' | 'allowSquashMerge' | 'allowRebaseMerge'>> = {
  merge: 'allowMergeCommit',
  squash: 'allowSquashMerge',
  rebase: 'allowRebaseMerge',
}

const METHOD_NAME: Readonly<Record<MergeMethod, string>> = { merge: 'Merge commits', squash: 'Squash merges', rebase: 'Rebase merges' }

const signatureFor = async (scope: Scope, ref: ActorRef | null, at: number): Promise<Signature> => {
  const users = await loadUsers(scope.db, [ref])
  const user = users(ref)
  return signatureAt(user.name ?? user.login, user.email ?? `${user.login}@${scope.noreplyDomain}`, new Date(at))
}

export type MergeInput = {
  readonly method?: unknown
  readonly commitTitle?: unknown
  readonly commitMessage?: unknown
  readonly sha?: unknown
}

export type MergeResult = {
  readonly sha: ObjectId
  readonly merged: true
  readonly message: string
  readonly closedIssues: readonly number[]
}

const optionalString = (value: unknown, name: string): string | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw invalid(`${name} must be a string`)
  return value
}

const commitMessage = async (scope: Scope, row: PullRow, method: MergeMethod, base: ObjectId, head: ObjectId, title: string | null, message: string | null): Promise<string> => {
  if (method === 'merge') {
    const subject = title ?? `Merge pull request #${row.number} from ${scope.repository.owner}/${branchName(row.head_ref)}`
    const body = message ?? row.title
    return body === '' ? subject : `${subject}\n\n${body}`
  }
  const subject = title ?? `${row.title} (#${row.number})`
  if (message !== null) return message === '' ? subject : `${subject}\n\n${message}`
  const odb = objectDatabase(scope)
  const commits = await commitsBetween(odb, base, head)
  const messages = await Promise.all(commits.map(async (id) => (await readCommitDetails(odb, id)).message.trim()))
  const body = messages.length === 1 ? messages[0]!.split('\n').slice(1).join('\n').trim() : messages.map((entry) => `* ${entry.replace(/\n/g, '\n  ')}`).join('\n\n')
  return body === '' ? subject : `${subject}\n\n${body}`
}

export const mergePull = async (scope: Scope, number: number, input: MergeInput = {}): Promise<MergeResult> => {
  const merger = requirePermission(scope, 'pull:merge')
  const method = (input.method ?? 'merge') as MergeMethod
  if (!MERGE_METHODS.includes(method)) throw invalid('merge_method must be merge, squash or rebase')
  if (!scope.settings[METHOD_SETTING[method]]) throw new CollaborationError(405, `${METHOD_NAME[method]} are not allowed on this repository.`)
  const title = optionalString(input.commitTitle, 'commit_title')
  const message = optionalString(input.commitMessage, 'commit_message')
  for (let attempt = 0; attempt < 3; attempt++) {
    const { row, state } = await loadFresh(scope, number)
    if (row.merged_at !== null) throw new CollaborationError(405, 'Pull Request is already merged')
    if (row.state !== 'open') throw new CollaborationError(405, 'Pull Request is not mergeable')
    if (row.draft === 1) throw new CollaborationError(405, 'Pull Request is still a draft')
    const base = branchTip(state, row.base_ref)
    const head = branchTip(state, row.head_ref)
    if (!base) throw new CollaborationError(405, 'Base branch was deleted')
    if (!head) throw new CollaborationError(405, 'Head branch was deleted')
    if (input.sha !== undefined && input.sha !== null && input.sha !== head) throw new CollaborationError(409, 'Head branch was modified. Review and try the merge again.')
    const at = scope.now()
    const committer = await signatureFor(scope, merger, at)
    const author = method === 'squash' ? await signatureFor(scope, refFromColumns(row.author_kind, row.author_id), at) : committer
    const odb = objectDatabase(scope)
    const outcome = await mergeBranches(odb, {
      base,
      head,
      method,
      message: await commitMessage(scope, row, method, base, head, title, message),
      committer,
      author,
    })
    if (!outcome.ok) {
      if (outcome.reason === 'conflict') throw new CollaborationError(405, 'Pull Request is not mergeable', outcome.conflicts)
      if (outcome.reason === 'merge-commits') throw new CollaborationError(405, 'This branch contains merge commits and cannot be rebased')
      throw new CollaborationError(405, outcome.reason === 'up-to-date' ? 'Pull Request has no changes to merge' : 'Pull Request is not mergeable')
    }
    const upToDate = (await mergeBases(odb, base, head)).includes(base)
    const problems = await protectionProblems(scope, row, base, head, upToDate, outcome.commit)
    if (problems.length > 0) throw new CollaborationError(405, `Repository rule violations found: ${problems.join('; ')}`, problems)
    await storeObjects(odb, outcome.objects)
    const update = await updateRefs(scope.storage, scope.repo, [{ name: row.base_ref, oldId: base, newId: outcome.commit }], odb)
    if (!update.ok) {
      if (update.reason === 'stale') continue
      throw notFound()
    }
    const [kind, id] = actorColumns(merger)
    await scope.db.batch([
      sql(
        'UPDATE pull_requests SET merged_at = ?, merged_by_kind = ?, merged_by_id = ?, merge_commit_sha = ?, merge_method = ?, base_sha = ?, head_sha = ? WHERE issue_id = ?',
        at,
        kind,
        id,
        outcome.commit,
        method,
        base,
        head,
        row.id,
      ),
      sql("UPDATE issues SET state = 'closed', closed_at = ?, closed_by_kind = ?, closed_by_id = ?, updated_at = ? WHERE id = ?", at, kind, id, at, row.id),
      eventStatement(row.id, merger, 'merged', { commit_id: outcome.commit, merge_method: method }, at),
      eventStatement(row.id, merger, 'closed', { commit_id: outcome.commit }, at),
    ])
    await emitActivity(scope, { kind: 'pull_request', action: 'closed', number: row.number, actor: merger })
    let closedIssues: number[] = []
    if (branchName(row.base_ref) === defaultBranch(state)) {
      const messages = await Promise.all((await commitsBetween(odb, base, head)).slice(0, MAX_PULL_COMMITS).map(async (sha) => (await readCommitDetails(odb, sha)).message))
      closedIssues = await closeIssuesByReference(scope, [row.title, row.body, ...messages], merger, { commit_id: outcome.commit, source: { type: 'pull_request', number: row.number } })
    }
    await scope.onBranchUpdated?.({ repo: scope.repo, ref: row.base_ref, oldId: base, newId: outcome.commit, actor: merger })
    return { sha: outcome.commit, merged: true, message: 'Pull Request successfully merged', closedIssues }
  }
  throw new CollaborationError(409, 'Base branch was modified. Review and try the merge again.')
}

export type PushedRef = { readonly name: string; readonly oldId: ObjectId; readonly newId: ObjectId }

export const systemScope = async (options: CollaborationOptions, owner: string, name: string): Promise<Scope | null> => {
  const repository = await options.accounts.findRepository(owner, name)
  if (!repository) return null
  return {
    db: options.db,
    storage: options.storage,
    accounts: options.accounts,
    now: options.now ?? Date.now,
    onBranchUpdated: options.onBranchUpdated,
    onActivity: options.onActivity,
    noreplyDomain: options.noreplyDomain ?? 'users.noreply.invalid',
    repository,
    repo: { owner: repository.owner, name: repository.name },
    actor: { principal: { kind: 'anonymous' }, access: 'admin', writable: true, ref: null },
    settings: await readSettings(options.db, repository.id),
  }
}

export const handlePushedRefs = async (scope: Scope, updates: readonly PushedRef[], pusher: EventActor = SYSTEM_ACTOR): Promise<void> => {
  const branches = updates.filter((update) => update.name.startsWith('refs/heads/'))
  if (branches.length === 0) return
  const state = await currentRefs(scope)
  const affected: PullRow[] = []
  for (const names of chunked(branches.map((update) => update.name), 40)) {
    const marks = placeholders(names)
    affected.push(
      ...(await scope.db.all<PullRow>(
        sql(`${PULL_SELECT} WHERE i.repository_id = ? AND i.state = 'open' AND (p.head_ref IN (${marks}) OR p.base_ref IN (${marks}))`, scope.repository.id, ...names, ...names),
      )),
    )
  }
  for (const row of affected) await refreshPull(scope, row, state, pusher)
  const main = `refs/heads/${defaultBranch(state)}`
  const odb = objectDatabase(scope)
  for (const update of branches) {
    if (update.name !== main || update.oldId === ZERO_ID || update.newId === ZERO_ID) continue
    const commits = await recentCommits(odb, update.newId, update.oldId)
    for (const sha of commits) {
      const details = await readCommitDetails(odb, sha)
      await closeIssuesByReference(scope, [details.message], pusher, { commit_id: sha })
    }
  }
}
