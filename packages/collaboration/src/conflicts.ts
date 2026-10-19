import { type Access, atLeast } from '@git-forge/accounts'
import { type ConflictFile, copyLfsObjects, mergeConflictFiles, ObjectDatabase, type ObjectId, resolveMergeConflicts, storeObjects, transferObjects } from '@git-forge/core'
import { afterBranchUpdate, branchProblems, editErrors } from './contents.ts'
import { CollaborationError, resolveActor, type Scope, scopeOptions } from './context.ts'
import { branchName, branchTip, currentRefs, objectDatabase, updateBranches } from './git.ts'
import { headRefsState, headRepositoryName, type PullRow, pullRow, refreshPull } from './pull-rows.ts'
import { signatureFor, systemScope } from './pulls.ts'

export type PullConflicts = {
  readonly files: readonly ConflictFile[]
  readonly head: ObjectId
  readonly base: ObjectId
  readonly headBranch: string
  readonly baseBranch: string
  readonly writable: boolean
  readonly problems: readonly string[]
}

const openPull = async (scope: Scope, number: number): Promise<{ row: PullRow; base: ObjectId; head: ObjectId }> => {
  const state = await currentRefs(scope)
  const row = await refreshPull(scope, await pullRow(scope, number), state, null)
  if (row.state !== 'open' || row.merged_at !== null) throw new CollaborationError(422, 'Pull Request is closed')
  const base = branchTip(state, row.base_ref)
  const headState = await headRefsState(scope, row, state)
  const head = headState ? branchTip(headState, row.head_ref) : null
  if (!base || !head || head !== row.head_sha) throw new CollaborationError(405, 'Head or base branch was deleted')
  return { row, base, head }
}

const headWrite = async (scope: Scope, row: PullRow, head: ObjectId): Promise<{ readonly problems: readonly string[] } | null> => {
  if (!scope.actor.ref || !scope.actor.writable) return null
  const repository = row.head_repository_id === null ? scope.repository : await scope.accounts.findRepositoryById(row.head_repository_id)
  if (!repository || repository.archived) return null
  const own = row.head_repository_id === null ? scope.actor : await resolveActor(scope.accounts, scope.actor.principal, repository)
  const access: Access | null = own.writable && atLeast(own.access, 'write') ? own.access : row.maintainer_can_modify === 1 && atLeast(scope.actor.access, 'write') ? 'write' : null
  return access ? { problems: await branchProblems(scope, repository, access, row.head_ref, head) } : null
}

export const pullConflicts = async (scope: Scope, number: number): Promise<PullConflicts> => {
  const { row, base, head } = await openPull(scope, number)
  const [headBranch, baseBranch] = [branchName(row.head_ref), branchName(row.base_ref)]
  const files = (await mergeConflictFiles(objectDatabase(scope), head, base, [headBranch, baseBranch])) ?? []
  const write = await headWrite(scope, row, head)
  return { files, head, base, headBranch, baseBranch, writable: write !== null && write.problems.length === 0, problems: write?.problems ?? [] }
}

export type ResolveInput = { readonly resolutions: ReadonlyMap<string, string>; readonly sha?: unknown; readonly message?: unknown }

export const resolvePullConflicts = async (scope: Scope, number: number, input: ResolveInput): Promise<ObjectId> => {
  const actor = scope.actor.ref
  if (!actor) throw new CollaborationError(401, 'Requires authentication')
  const { row, base, head } = await openPull(scope, number)
  if (input.sha !== undefined && input.sha !== head) throw new CollaborationError(409, 'Head branch was modified. Review and try again.')
  const write = await headWrite(scope, row, head)
  if (!write) throw new CollaborationError(403, 'You cannot push to the head branch of this pull request')
  if (write.problems.length > 0) throw new CollaborationError(409, `protected branch: ${write.problems[0]}`)
  const signature = await signatureFor(scope, actor, scope.now())
  const message = typeof input.message === 'string' && input.message.trim() !== '' ? input.message : `Merge branch '${branchName(row.base_ref)}' into ${branchName(row.head_ref)}`
  const odb = objectDatabase(scope)
  const built = await editErrors(() => resolveMergeConflicts(odb, { ours: head, theirs: base, resolutions: input.resolutions, message, author: signature, committer: signature }))
  const headName = headRepositoryName(scope, row)
  const headOdb = new ObjectDatabase(scope.storage, headName)
  if (row.head_repository_id !== null) {
    const { lfsPointers } = await transferObjects(odb, headOdb, [base], [head])
    await copyLfsObjects(scope.storage, scope.repo, headName, lfsPointers)
  }
  await storeObjects(headOdb, built.objects)
  const update = await updateBranches(scope, headName, [{ name: row.head_ref, oldId: head, newId: built.commit }], headOdb)
  if (!update.ok) throw new CollaborationError(409, 'Head branch was modified. Review and try again.')
  const headScope = row.head_repository_id === null ? scope : await systemScope(scopeOptions(scope), headName.owner, headName.name)
  if (headScope) await afterBranchUpdate(headScope, row.head_ref, head, built.commit, actor)
  return built.commit
}
