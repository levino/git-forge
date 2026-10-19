import { type Access, atLeast, base64UrlDecode, base64UrlEncode, evaluateBranchUpdate, protectionActor, type RepositorySubject, selectProtectionRule } from '@git-forge/accounts'
import {
  advertisedRefs,
  commitFileChanges,
  EditError,
  entryKind,
  fileAt,
  type FileChange,
  hashStream,
  hasLfsObject,
  isLfsOid,
  isLfsSize,
  type LfsObjectSpec,
  isLfsTracked,
  lfsObjectKey,
  lfsPointerText,
  MAX_WEB_FILE_BYTES,
  type ObjectDatabase,
  type ObjectId,
  parseTree,
  type RefsState,
  type RepositoryName,
  type Signature,
  storeLfsObject,
  storeObjects,
  streamOf,
  entryAt,
  treeOfCommit,
  validRefName,
  ZERO_ID,
  normalizePath,
} from '@git-forge/core'
import { type ActorRef, can, CollaborationError, type EventActor, invalid, notFound, openRepository, type Scope, scopeOptions } from './context.ts'
import { createFork } from './forks.ts'
import { BRANCH_PREFIX, branchName, branchRef, branchTip, currentRefs, defaultBranch, objectDatabase, resolveCommitish, updateBranches } from './git.ts'
import { createPull, handlePushedRefs, type PullDetails, signatureFor, systemScope } from './pulls.ts'

export type EditMode = 'direct' | 'branch' | 'fork'

export type EditPlan = { readonly mode: EditMode; readonly problems: readonly string[] }

const PLACEHOLDER = 'f'.repeat(40)

export const editErrors = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run()
  } catch (error) {
    if (error instanceof EditError) throw invalid(error.message)
    throw error
  }
}

export const branchProblems = async (scope: Scope, repository: RepositorySubject, access: Access, ref: string, oldId: ObjectId): Promise<readonly string[]> => {
  const rule = selectProtectionRule(await scope.accounts.branchProtectionRules(repository.id), branchName(ref))
  if (!rule) return []
  return evaluateBranchUpdate(rule, await protectionActor(scope.accounts, scope.actor.principal, repository, access), { ref, oldId, newId: PLACEHOLDER, fastForward: true })
}

export const editPlan = async (scope: Scope, branch: string): Promise<EditPlan | null> => {
  if (!scope.actor.ref || !scope.actor.writable) return null
  if (atLeast(scope.actor.access, 'write')) {
    const problems = await branchProblems(scope, scope.repository, scope.actor.access, branchRef(branch), branchTip(await currentRefs(scope), branch) ?? ZERO_ID)
    return { mode: problems.length === 0 ? 'direct' : 'branch', problems }
  }
  return scope.actor.principal.kind === 'user' && can(scope, 'pull:create') ? { mode: 'fork', problems: [] } : null
}

const requireBranchName = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.startsWith('-') || !validRefName(branchRef(value))) throw invalid(`${field} is not a valid branch name`)
  return value
}

const forkFor = async (scope: Scope): Promise<Scope> => {
  const principal = scope.actor.principal
  const existing = (await scope.accounts.listForks(scope.repository.id)).find((fork) => principal.kind === 'user' && fork.ownerId === principal.id)
  const fork = existing ?? (await createFork(scope, {}))
  return openRepository(scopeOptions(scope), principal, fork.owner, fork.name)
}

const patchBranch = (state: RefsState): string => {
  for (let n = 1; ; n++) if (!branchTip(state, `patch-${n}`)) return `patch-${n}`
}

export type FileContent = Uint8Array | Blob

export type FileInput = { readonly path: string; readonly content: FileContent | LfsObjectSpec | null; readonly sha?: ObjectId | null }

const isPointer = (content: FileContent | LfsObjectSpec): content is LfsObjectSpec => !(content instanceof Uint8Array) && !(content instanceof Blob)

const sizeOf = (content: FileContent): number => (content instanceof Uint8Array ? content.length : content.size)

const streamOfContent = (content: FileContent): ReadableStream<Uint8Array> => (content instanceof Uint8Array ? streamOf(content) : content.stream())

const prepare = async (scope: Scope, target: RepositoryName, odb: ObjectDatabase, parent: ObjectId | null, file: FileInput): Promise<FileChange> => {
  const path = normalizePath(file.path)
  if (file.sha !== undefined) {
    const current = (await fileAt(odb, parent, path))?.id ?? null
    if (current !== file.sha) throw new CollaborationError(409, current === null ? `${path} does not exist` : file.sha === null ? `${path} already exists` : `${path} does not match ${file.sha}`)
  }
  if (file.content === null) return { path, content: null }
  if (isPointer(file.content)) {
    const object = file.content
    if (!isLfsOid(object.oid) || !isLfsSize(object.size)) throw invalid(`${path}: invalid LFS object`)
    if (!(await hasLfsObject(scope.storage, target, object))) throw invalid(`${path}: LFS object ${object.oid} was not uploaded`)
    return { path, content: lfsPointerText(object) }
  }
  const size = sizeOf(file.content)
  if (!(await isLfsTracked(odb, parent, path))) {
    if (size > MAX_WEB_FILE_BYTES) throw invalid(`${path} is larger than ${MAX_WEB_FILE_BYTES} bytes; push it with git`)
    return { path, content: file.content instanceof Uint8Array ? file.content : new Uint8Array(await file.content.arrayBuffer()) }
  }
  const limit = scope.lfs?.maxObjectBytes
  if (limit !== undefined && size > limit) throw invalid(`${path} is larger than the Git LFS limit of ${limit} bytes; push it with git lfs`)
  const object = await hashStream(streamOfContent(file.content), scope.lfs?.digests)
  const stored = await storeLfsObject(scope.storage, target, object, streamOfContent(file.content))
  if (!stored.ok) throw new CollaborationError(422, stored.message)
  if (stored.created) await scope.lfs?.onStored?.(lfsObjectKey(target, object.oid), object.size)
  return { path, content: lfsPointerText(object) }
}

export const afterBranchUpdate = async (scope: Scope, ref: string, oldId: ObjectId, newId: ObjectId, actor: EventActor): Promise<void> => {
  const system = await systemScope(scopeOptions(scope), scope.repo.owner, scope.repo.name)
  if (system) await handlePushedRefs(system, [{ name: ref, oldId, newId }], actor)
  await scope.onBranchUpdated?.({ repo: scope.repo, ref, oldId, newId, actor })
}

export const uploadTarget = async (scope: Scope, branch: string, paths: readonly string[]): Promise<{ readonly repository: RepositoryName; readonly lfs: readonly string[] }> => {
  const plan = await editPlan(scope, branch)
  if (!plan) throw new CollaborationError(403, 'Resource not accessible by integration')
  const target = plan.mode === 'fork' ? await forkFor(scope) : scope
  const odb = objectDatabase(scope)
  const parent = branchTip(await currentRefs(scope), branch)
  const lfs = await editErrors(async () => {
    const tracked: string[] = []
    for (const path of paths) if (await isLfsTracked(odb, parent, path)) tracked.push(path)
    return tracked
  })
  return { repository: target.repo, lfs }
}

export type CommitInput = {
  readonly branch: unknown
  readonly message: unknown
  readonly files: readonly FileInput[]
  readonly newBranch?: unknown
  readonly propose?: boolean
  readonly pull?: { readonly title?: unknown; readonly body?: unknown } | null
}

export type CommitOutcome = {
  readonly sha: ObjectId
  readonly tree: ObjectId
  readonly parent: ObjectId | null
  readonly signature: Signature
  readonly message: string
  readonly repository: RepositoryName
  readonly branch: string
  readonly pull: PullDetails | null
}

export const commitChanges = async (scope: Scope, input: CommitInput): Promise<CommitOutcome> => {
  const actor: ActorRef | null = scope.actor.ref
  if (!actor) throw new CollaborationError(401, 'Requires authentication')
  const branch = requireBranchName(input.branch, 'branch')
  if (typeof input.message !== 'string' || input.message.trim() === '') throw invalid('message is required')
  const message = input.message
  const state = await currentRefs(scope)
  const parent = branchTip(state, branch)
  if (!parent && (Object.keys(advertisedRefs(state).refs).some((ref) => ref.startsWith(BRANCH_PREFIX)) || branch !== defaultBranch(state))) throw notFound('Branch not found')
  const plan = await editPlan(scope, branch)
  if (!plan || (plan.mode === 'fork' && input.propose !== true)) throw new CollaborationError(403, 'Resource not accessible by integration')
  let newBranch = input.newBranch === undefined || input.newBranch === null || input.newBranch === '' ? null : requireBranchName(input.newBranch, 'new_branch')
  if (plan.mode === 'branch' && newBranch === null) throw new CollaborationError(409, `protected branch: ${plan.problems[0]}; commit to a new branch and open a pull request`)
  const target = plan.mode === 'fork' ? await forkFor(scope) : scope
  if (plan.mode === 'fork') newBranch ??= patchBranch(await currentRefs(target))
  const ref = branchRef(newBranch ?? branch)
  const oldId = newBranch === null ? (parent ?? ZERO_ID) : ZERO_ID
  if (newBranch !== null) {
    if (branchTip(await currentRefs(target), newBranch)) throw invalid(`Branch ${newBranch} already exists`)
    const problems = await branchProblems(target, target.repository, target.actor.access, ref, ZERO_ID)
    if (problems.length > 0) throw new CollaborationError(409, `protected branch: ${problems[0]}`)
  }
  const odb = objectDatabase(target)
  const signature = await signatureFor(scope, actor, scope.now())
  const built = await editErrors(async () => {
    const changes: FileChange[] = []
    for (const file of input.files) changes.push(await prepare(scope, target.repo, odb, parent, file))
    return commitFileChanges(odb, { parent, changes, message, author: signature, committer: signature })
  })
  await storeObjects(odb, built.objects)
  const update = await updateBranches(target, target.repo, [{ name: ref, oldId, newId: built.commit }], odb)
  if (!update.ok) throw new CollaborationError(409, `${branchName(ref)} was modified; reload and try again`)
  await afterBranchUpdate(target, ref, oldId, built.commit, actor)
  const wantsPull = plan.mode === 'fork' || (newBranch !== null && input.pull)
  const title = typeof input.pull?.title === 'string' && input.pull.title.trim() !== '' ? input.pull.title : message.trim().split('\n')[0]!
  const pull = wantsPull
    ? await createPull(scope, {
        title,
        body: input.pull?.body,
        head: plan.mode === 'fork' ? `${target.repo.owner}:${newBranch}` : newBranch,
        ...(plan.mode === 'fork' ? { headRepo: target.repo.name } : {}),
        base: branch,
      })
    : null
  return { sha: built.commit, tree: built.tree, parent, signature, message, repository: target.repo, branch: branchName(ref), pull }
}

export type ContentItem = {
  readonly type: 'file' | 'dir' | 'symlink' | 'submodule'
  readonly name: string
  readonly path: string
  readonly sha: ObjectId
  readonly size: number
  readonly content?: Uint8Array
}

export const MAX_CONTENT_BYTES = 1024 * 1024

const KINDS = { tree: 'dir', blob: 'file', symlink: 'symlink', submodule: 'submodule' } as const

export const getContents = async (scope: Scope, path: string, ref: string | null): Promise<{ readonly ref: string; readonly item: ContentItem | readonly ContentItem[] }> => {
  const name = ref ?? defaultBranch(await currentRefs(scope))
  const odb = objectDatabase(scope)
  const commit = await resolveCommitish(scope, name, odb)
  const tree = commit ? await treeOfCommit(odb, commit) : null
  if (!tree) throw notFound()
  const segments = path === '' ? [] : await editErrors(async () => normalizePath(path).split('/'))
  const entry = segments.length === 0 ? { mode: '40000', name: '', id: tree } : await entryAt(odb, tree, segments)
  if (!entry) throw notFound()
  const describe = async (item: { readonly mode: string; readonly name: string; readonly id: ObjectId }, full: string, withContent: boolean): Promise<ContentItem> => {
    const kind = KINDS[entryKind(item)]
    const object = kind === 'file' || kind === 'symlink' ? await odb.read(item.id) : null
    const size = object?.data.length ?? 0
    return { type: kind, name: item.name, path: full, sha: item.id, size, ...(withContent && object && size <= MAX_CONTENT_BYTES ? { content: object.data } : {}) }
  }
  const full = segments.join('/')
  if (entryKind(entry) !== 'tree') return { ref: name, item: await describe(entry, full, true) }
  const object = await odb.read(entry.id)
  const entries = object?.type === 'tree' ? parseTree(object.data) : []
  return { ref: name, item: await Promise.all(entries.map((child) => describe(child, full === '' ? child.name : `${full}/${child.name}`, false))) }
}

export const encodeBase64 = (bytes: Uint8Array): string => {
  const text = base64UrlEncode(bytes).replace(/-/g, '+').replace(/_/g, '/')
  return text + '='.repeat((4 - (text.length % 4)) % 4)
}

const decodeBase64 = (text: string): Uint8Array => {
  try {
    return base64UrlDecode(text.replace(/\s+/g, '').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'))
  } catch {
    throw invalid('content is not valid Base64')
  }
}

export type ContentsBody = Readonly<Record<string, unknown>>

const optionalSha = (value: unknown): ObjectId | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw invalid('sha must be a string')
  return value
}

export const putContents = async (scope: Scope, path: string, body: ContentsBody): Promise<{ readonly outcome: CommitOutcome; readonly item: ContentItem; readonly created: boolean }> => {
  if (typeof body.content !== 'string') throw invalid('content is required')
  const branch = body.branch ?? defaultBranch(await currentRefs(scope))
  const tip = typeof branch === 'string' ? branchTip(await currentRefs(scope), branch) : null
  const existing = await editErrors(() => fileAt(objectDatabase(scope), tip, path))
  const sha = optionalSha(body.sha)
  if (existing && sha === undefined) throw invalid('"sha" wasn\'t supplied.')
  const outcome = await commitChanges(scope, { branch, message: body.message, files: [{ path, content: decodeBase64(body.content), sha: sha ?? null }] })
  const odb = objectDatabase(scope)
  const entry = (await fileAt(odb, outcome.sha, path))!
  const name = normalizePath(path)
  return { outcome, item: { type: 'file', name: name.slice(name.lastIndexOf('/') + 1), path: name, sha: entry.id, size: (await odb.read(entry.id))?.data.length ?? 0 }, created: !existing }
}

export const deleteContents = async (scope: Scope, path: string, body: ContentsBody): Promise<CommitOutcome> => {
  const sha = optionalSha(body.sha)
  if (sha === undefined) throw invalid('"sha" wasn\'t supplied.')
  const branch = body.branch ?? defaultBranch(await currentRefs(scope))
  const tip = typeof branch === 'string' ? branchTip(await currentRefs(scope), branch) : null
  if (!(await editErrors(() => fileAt(objectDatabase(scope), tip, path)))) throw notFound()
  return commitChanges(scope, { branch, message: body.message, files: [{ path, content: null, sha }] })
}
