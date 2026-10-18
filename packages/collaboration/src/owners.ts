import { sql, type Statement } from '@git-forge/accounts'
import { diffTrees, fromUtf8, isTreeMode, type ObjectId, type ObjectSource, parseCommit, parseTree } from '@git-forge/core'
import { loadUsers } from './actors.ts'
import { type CodeOwner, CODEOWNERS_LOCATIONS, type CodeOwners, MAX_CODEOWNERS_BYTES, ownerLabel, ownersOf, parseCodeOwners } from './codeowners.ts'
import { type ActorRef, emitActivity, type EventActor, refFromColumns, type Scope } from './context.ts'
import { eventStatement } from './issues.ts'

export const readBlobAtPath = async (source: ObjectSource, commit: ObjectId, path: string): Promise<Uint8Array | null> => {
  const object = await source.read(commit)
  if (object?.type !== 'commit') return null
  let tree = parseCommit(object.data).tree
  const segments = path.split('/')
  for (let i = 0; i < segments.length; i++) {
    const current = await source.read(tree)
    if (current?.type !== 'tree') return null
    const entry = parseTree(current.data).find((candidate) => candidate.name === segments[i])
    if (!entry) return null
    if (i === segments.length - 1) {
      if (isTreeMode(entry.mode) || entry.mode === '160000') return null
      const blob = await source.read(entry.id)
      return blob?.type === 'blob' ? blob.data : null
    }
    if (!isTreeMode(entry.mode)) return null
    tree = entry.id
  }
  return null
}

export const loadCodeOwners = async (source: ObjectSource, commit: ObjectId): Promise<CodeOwners | null> => {
  for (const path of CODEOWNERS_LOCATIONS) {
    const data = await readBlobAtPath(source, commit, path)
    if (data) return parseCodeOwners(data.length > MAX_CODEOWNERS_BYTES ? '' : fromUtf8(data), path)
  }
  return null
}

const treeOf = async (source: ObjectSource, commit: ObjectId | null): Promise<ObjectId | null> => {
  if (commit === null) return null
  const object = await source.read(commit)
  return object?.type === 'commit' ? parseCommit(object.data).tree : null
}

export const changedPaths = async (source: ObjectSource, from: ObjectId | null, to: ObjectId): Promise<string[]> => {
  const changes = await diffTrees(source, await treeOf(source, from), await treeOf(source, to), { renames: false })
  return [...new Set(changes.map((change) => change.path))]
}

export type OwnedFile = { readonly path: string; readonly owners: readonly string[]; readonly approvedBy: readonly string[] }

export type CodeOwnerReview = {
  readonly file: string | null
  readonly errors: CodeOwners['errors']
  readonly files: readonly OwnedFile[]
  readonly approved: boolean
}

type Candidate = { readonly ref: ActorRef; readonly login: string; readonly email: string | null }

const ownerMatches = async (scope: Pick<Scope, 'accounts'>, owner: CodeOwner, candidate: Candidate, teams: Map<string, string | null>): Promise<boolean> => {
  if (candidate.ref.kind !== 'user') return false
  if (owner.kind === 'user') return owner.login.toLowerCase() === candidate.login.toLowerCase()
  if (owner.kind === 'email') return candidate.email !== null && owner.email.toLowerCase() === candidate.email.toLowerCase()
  const key = `${owner.organization}/${owner.slug}`.toLowerCase()
  if (!teams.has(key)) {
    const organization = await scope.accounts.findAccount(owner.organization)
    const team = organization?.kind === 'organization' ? await scope.accounts.findTeam(organization.id, owner.slug) : null
    teams.set(key, team && organization ? `${organization.id}:${team.id}` : null)
  }
  const resolved = teams.get(key)
  if (!resolved) return false
  const [organizationId, teamId] = resolved.split(':') as [string, string]
  return (await scope.accounts.teamIdsFor(candidate.ref.id, organizationId)).includes(teamId)
}

export const evaluateCodeOwners = async (
  scope: Pick<Scope, 'db' | 'accounts'>,
  source: ObjectSource,
  base: ObjectId,
  mergeBase: ObjectId | null,
  head: ObjectId,
  approvers: readonly ActorRef[],
): Promise<CodeOwnerReview> => {
  const codeowners = await loadCodeOwners(source, base)
  if (!codeowners) return { file: null, errors: [], files: [], approved: true }
  const users = await loadUsers(scope.db, approvers)
  const candidates: Candidate[] = approvers.map((ref) => ({ ref, login: users(ref).login, email: users(ref).email }))
  const teams = new Map<string, string | null>()
  const files: OwnedFile[] = []
  for (const path of await changedPaths(source, mergeBase, head)) {
    const owners = ownersOf(codeowners, path)
    if (owners.length === 0) continue
    const approvedBy: string[] = []
    for (const candidate of candidates) {
      for (const owner of owners) {
        if (await ownerMatches(scope, owner, candidate, teams)) {
          approvedBy.push(candidate.login)
          break
        }
      }
    }
    files.push({ path, owners: owners.map(ownerLabel), approvedBy })
  }
  return { file: codeowners.path, errors: codeowners.errors, files, approved: files.every((file) => file.approvedBy.length > 0) }
}

export type ReviewRequester = (scope: Scope, ref: ActorRef) => Promise<boolean>

export const codeOwnerReviewers = async (
  scope: Scope,
  source: ObjectSource,
  base: ObjectId,
  mergeBase: ObjectId | null,
  head: ObjectId,
  author: ActorRef | null,
  eligible: ReviewRequester,
): Promise<{ readonly id: string; readonly login: string }[]> => {
  const codeowners = await loadCodeOwners(source, base)
  if (!codeowners) return []
  const logins = new Set<string>()
  for (const path of await changedPaths(source, mergeBase, head)) {
    for (const owner of ownersOf(codeowners, path)) if (owner.kind === 'user') logins.add(owner.login.toLowerCase())
  }
  const reviewers: { id: string; login: string }[] = []
  for (const login of logins) {
    const account = await scope.accounts.findAccount(login)
    if (!account || account.kind !== 'user') continue
    const ref: ActorRef = { kind: 'user', id: account.id }
    if (author && author.kind === 'user' && author.id === account.id) continue
    if (await eligible(scope, ref)) reviewers.push({ id: account.id, login: account.login })
  }
  return reviewers
}

export const requestCodeOwnerStatements = async (
  scope: Scope,
  pull: { readonly id: number; readonly author_kind: string; readonly author_id: string },
  reviewers: readonly { readonly id: string; readonly login: string }[],
  actor: EventActor,
  at: number,
): Promise<{ statements: Statement[]; logins: string[] }> => {
  const existing = new Set(
    (
      await scope.db.all<{ user_id: string }>(
        sql(
          `SELECT user_id FROM review_requests WHERE issue_id = ?
           UNION SELECT author_id AS user_id FROM pull_request_reviews WHERE issue_id = ? AND author_kind = 'user' AND state != 'PENDING'`,
          pull.id,
          pull.id,
        ),
      )
    ).map((row) => row.user_id),
  )
  const author = refFromColumns(pull.author_kind, pull.author_id)
  const statements: Statement[] = []
  const logins: string[] = []
  for (const reviewer of reviewers) {
    if (existing.has(reviewer.id) || (author?.kind === 'user' && author.id === reviewer.id)) continue
    statements.push(
      sql('INSERT OR IGNORE INTO review_requests (issue_id, user_id, created_at) VALUES (?, ?, ?)', pull.id, reviewer.id, at),
      eventStatement(pull.id, actor, 'review_requested', { requested_reviewer: { login: reviewer.login }, code_owner: true }, at),
    )
    logins.push(reviewer.login)
  }
  return { statements, logins }
}

export const requestCodeOwners = async (
  scope: Scope,
  pull: { readonly id: number; readonly number: number; readonly author_kind: string; readonly author_id: string },
  source: ObjectSource,
  base: ObjectId,
  mergeBase: ObjectId | null,
  head: ObjectId,
  eligible: ReviewRequester,
): Promise<string[]> => {
  const author = refFromColumns(pull.author_kind, pull.author_id)
  const reviewers = await codeOwnerReviewers(scope, source, base, mergeBase, head, author, eligible)
  if (reviewers.length === 0) return []
  const actor: EventActor = author ?? { kind: 'system', id: null }
  const { statements, logins } = await requestCodeOwnerStatements(scope, pull, reviewers, actor, scope.now())
  if (statements.length === 0) return []
  await scope.db.batch(statements)
  for (const login of logins) await emitActivity(scope, { kind: 'pull_request', action: 'review_requested', number: pull.number, actor, requestedReviewer: login })
  return logins
}
