import { concat } from './bytes.ts'
import { type CommitDetails, type NewCommit, parseCommitDetails, serializeCommit, serializeTree, StagedObjects } from './commit.ts'
import { isBinaryContent } from './diff.ts'
import type { ObjectId } from './hash.ts'
import { type GitObject, isSubmodule, type Signature, isTreeMode, parseCommit, parseTree, type TreeEntry } from './objects.ts'
import { MissingObjectError, type ObjectSource } from './walk.ts'
import { mergeLines, splitLines } from './xdiff.ts'

export type ConflictReason =
  | 'content'
  | 'binary'
  | 'mode'
  | 'modify/delete'
  | 'symlink'
  | 'submodule'
  | 'directory/file'
  | 'directory-rename'
  | 'rename'
  | 'merge-base'

export type MergeConflict = {
  readonly path: string
  readonly reason: ConflictReason
}

export type TreeMerge = {
  readonly tree: ObjectId
  readonly conflicts: readonly MergeConflict[]
}

const EMPTY_TREE_DATA = new Uint8Array(0)

const readObject = async (source: ObjectSource, id: ObjectId, type: GitObject['type']): Promise<Uint8Array> => {
  const object = await source.read(id)
  if (!object) throw new MissingObjectError(id)
  if (object.type !== type) throw new Error(`${id} is a ${object.type}, expected ${type}`)
  return object.data
}

export const readCommitDetails = async (source: ObjectSource, id: ObjectId): Promise<CommitDetails> => parseCommitDetails(await readObject(source, id, 'commit'))

const readEntries = async (source: ObjectSource, id: ObjectId | null): Promise<TreeEntry[]> => (id === null ? [] : parseTree(await readObject(source, id, 'tree')))

const ancestors = async (source: ObjectSource, tip: ObjectId): Promise<Set<ObjectId>> => {
  const seen = new Set<ObjectId>()
  const stack = [tip]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...parseCommit(await readObject(source, id, 'commit')).parents)
  }
  return seen
}

export const mergeBases = async (source: ObjectSource, a: ObjectId, b: ObjectId): Promise<ObjectId[]> => {
  if (a === b) return [a]
  const fromA = await ancestors(source, a)
  const candidates: ObjectId[] = []
  const seen = new Set<ObjectId>()
  const queue = [b]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    if (fromA.has(id)) {
      candidates.push(id)
      continue
    }
    queue.push(...parseCommit(await readObject(source, id, 'commit')).parents)
  }
  const best: ObjectId[] = []
  for (const candidate of candidates) {
    let dominated = false
    for (const other of candidates) {
      if (other !== candidate && (await ancestors(source, other)).has(candidate)) {
        dominated = true
        break
      }
    }
    if (!dominated) best.push(candidate)
  }
  return best
}

export const commitsBetween = async (source: ObjectSource, exclude: ObjectId | null, include: ObjectId): Promise<ObjectId[]> => {
  const excluded = exclude === null ? new Set<ObjectId>() : await ancestors(source, exclude)
  const order: ObjectId[] = []
  const visited = new Set<ObjectId>()
  const stack: { id: ObjectId; expanded: boolean }[] = [{ id: include, expanded: false }]
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!
    if (excluded.has(top.id) || (visited.has(top.id) && !top.expanded)) {
      stack.pop()
      continue
    }
    if (top.expanded) {
      stack.pop()
      order.push(top.id)
      continue
    }
    visited.add(top.id)
    top.expanded = true
    const parents = parseCommit(await readObject(source, top.id, 'commit')).parents
    for (let i = parents.length - 1; i >= 0; i--) if (!visited.has(parents[i]!) && !excluded.has(parents[i]!)) stack.push({ id: parents[i]!, expanded: false })
  }
  return order
}

type Slot = TreeEntry | undefined

const same = (x: Slot, y: Slot): boolean => (x === undefined ? y === undefined : y !== undefined && x.id === y.id && x.mode === y.mode)

const isRegular = (mode: string): boolean => mode === '100644' || mode === '100755'

type FileSide = { readonly path: string; readonly entry: TreeEntry }

type Context = {
  readonly source: ObjectSource
  readonly staged: StagedObjects
  readonly conflicts: MergeConflict[]
  readonly deleted: { readonly path: string; readonly entry: TreeEntry }[]
  readonly addedOurs: FileSide[]
  readonly addedTheirs: FileSide[]
}

const mergeFile = async (context: Context, path: string, base: Slot, ours: TreeEntry, theirs: TreeEntry): Promise<TreeEntry | null> => {
  const conflict = (reason: ConflictReason) => {
    context.conflicts.push({ path, reason })
    return null
  }
  const kind = (entry: TreeEntry) => (isSubmodule(entry) ? 'submodule' : entry.mode === '120000' ? 'symlink' : 'file')
  if (kind(ours) !== kind(theirs)) return conflict('directory/file')
  let mode: string
  if (ours.mode === theirs.mode || ours.mode === base?.mode) mode = theirs.mode
  else if (theirs.mode === base?.mode) mode = ours.mode
  else return conflict('mode')
  let id: ObjectId
  if (ours.id === theirs.id || ours.id === base?.id) id = theirs.id
  else if (theirs.id === base?.id) id = ours.id
  else if (kind(ours) === 'submodule') return conflict('submodule')
  else if (kind(ours) === 'symlink') return conflict('symlink')
  else {
    const baseData = base && isRegular(base.mode) ? await readObject(context.source, base.id, 'blob') : EMPTY_TREE_DATA
    const oursData = await readObject(context.source, ours.id, 'blob')
    const theirsData = await readObject(context.source, theirs.id, 'blob')
    if (isBinaryContent(baseData) || isBinaryContent(oursData) || isBinaryContent(theirsData)) return conflict('binary')
    const merged = mergeLines(splitLines(baseData), splitLines(oursData), splitLines(theirsData))
    if (!merged.clean) return conflict('content')
    id = context.staged.add('blob', concat(merged.lines))
  }
  return { mode, name: ours.name, id }
}

const mergeLevel = async (
  context: Context,
  prefix: string,
  base: ObjectId | null,
  ours: ObjectId | null,
  theirs: ObjectId | null,
  gone: { readonly ours: boolean; readonly theirs: boolean },
): Promise<ObjectId | null> => {
  const [b, o, t] = await Promise.all([readEntries(context.source, base), readEntries(context.source, ours), readEntries(context.source, theirs)])
  const names = [...new Set([...b, ...o, ...t].map((entry) => entry.name))]
  const result: TreeEntry[] = []
  for (const name of names) {
    const path = `${prefix}${name}`
    const pick = (entries: readonly TreeEntry[], tree: boolean) => entries.find((entry) => entry.name === name && isTreeMode(entry.mode) === tree)
    const [bFile, oFile, tFile] = [pick(b, false), pick(o, false), pick(t, false)]
    const [bDir, oDir, tDir] = [pick(b, true), pick(o, true), pick(t, true)]
    if ((gone.ours && !bFile && tFile) || (gone.theirs && !bFile && oFile) || (gone.ours && !bDir && tDir) || (gone.theirs && !bDir && oDir)) {
      context.conflicts.push({ path, reason: 'directory-rename' })
    }
    let file: TreeEntry | null = null
    if (same(oFile, tFile)) file = oFile ?? null
    else if (same(bFile, oFile)) file = tFile ?? null
    else if (same(bFile, tFile)) file = oFile ?? null
    else if (oFile && tFile) file = await mergeFile(context, path, bFile, oFile, tFile)
    else context.conflicts.push({ path, reason: 'modify/delete' })
    if (bFile && !oFile && !tFile) context.deleted.push({ path, entry: bFile })
    if (!bFile && oFile && !same(oFile, tFile)) context.addedOurs.push({ path, entry: oFile })
    if (!bFile && tFile && !same(oFile, tFile)) context.addedTheirs.push({ path, entry: tFile })
    const dir =
      same(bDir, oDir) && same(bDir, tDir)
        ? (bDir?.id ?? null)
        : await mergeLevel(context, `${path}/`, bDir?.id ?? null, oDir?.id ?? null, tDir?.id ?? null, {
            ours: gone.ours || (bDir !== undefined && oDir === undefined),
            theirs: gone.theirs || (bDir !== undefined && tDir === undefined),
          })
    if (file && dir) context.conflicts.push({ path, reason: 'directory/file' })
    if (file) result.push(file)
    if (dir) result.push({ mode: '40000', name, id: dir })
  }
  if (result.length === 0) return null
  return context.staged.add('tree', serializeTree(result))
}

const RENAME_SIMILARITY = 0.3

const similarity = (a: Uint8Array, b: Uint8Array): number => {
  if (a.length === 0 && b.length === 0) return 1
  const counts = new Map<string, number>()
  const decoder = new TextDecoder('latin1')
  for (const line of splitLines(a)) {
    const key = decoder.decode(line)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let common = 0
  for (const line of splitLines(b)) {
    const key = decoder.decode(line)
    const left = counts.get(key) ?? 0
    if (left > 0) {
      counts.set(key, left - 1)
      common += line.length
    }
  }
  return common / Math.max(a.length, b.length)
}

const renameCandidates = async (context: Context, deleted: TreeEntry, added: readonly FileSide[]): Promise<FileSide[]> => {
  if (!isRegular(deleted.mode)) return added.filter((side) => side.entry.id === deleted.id)
  const original = await readObject(context.source, deleted.id, 'blob')
  const similar: FileSide[] = []
  for (const side of added) {
    if (side.entry.id === deleted.id) similar.push(side)
    else if (isRegular(side.entry.mode) && similarity(original, await readObject(context.source, side.entry.id, 'blob')) >= RENAME_SIMILARITY) similar.push(side)
  }
  return similar
}

const checkRenames = async (context: Context) => {
  if (context.deleted.length === 0 || (context.addedOurs.length === 0 && context.addedTheirs.length === 0)) return
  for (const { path, entry } of context.deleted) {
    const ours = await renameCandidates(context, entry, context.addedOurs)
    const theirs = await renameCandidates(context, entry, context.addedTheirs)
    const key = (sides: readonly FileSide[]) => sides.map((side) => `${side.path}\0${side.entry.mode}\0${side.entry.id}`).sort().join('\n')
    if (key(ours) !== key(theirs)) context.conflicts.push({ path, reason: 'rename' })
  }
}

export const mergeTrees = async (staged: StagedObjects, base: ObjectId | null, ours: ObjectId, theirs: ObjectId): Promise<TreeMerge> => {
  const context: Context = { source: staged, staged, conflicts: [], deleted: [], addedOurs: [], addedTheirs: [] }
  const tree = (await mergeLevel(context, '', base, ours, theirs, { ours: false, theirs: false })) ?? staged.add('tree', EMPTY_TREE_DATA)
  await checkRenames(context)
  const conflicts = [...new Map(context.conflicts.map((conflict) => [`${conflict.path}\0${conflict.reason}`, conflict])).values()]
  return { tree, conflicts }
}

const treeOf = async (source: ObjectSource, commit: ObjectId): Promise<ObjectId> => parseCommit(await readObject(source, commit, 'commit')).tree

export type CommitMerge =
  | { readonly ok: true; readonly tree: ObjectId; readonly bases: readonly ObjectId[] }
  | { readonly ok: false; readonly reason: 'conflict'; readonly conflicts: readonly MergeConflict[] }
  | { readonly ok: false; readonly reason: 'unrelated' }

const VIRTUAL_SIGNATURE: Signature = { name: 'git-forge', email: 'git-forge', timestamp: 0, timezone: '+0000' }

export const mergeCommitTrees = async (staged: StagedObjects, ours: ObjectId, theirs: ObjectId, depth = 0): Promise<CommitMerge> => {
  const bases = await mergeBases(staged, ours, theirs)
  if (bases.length === 0) return { ok: false, reason: 'unrelated' }
  let base = bases[bases.length - 1]!
  for (let i = bases.length - 2; i >= 0; i--) {
    if (depth > 8) return { ok: false, reason: 'conflict', conflicts: [{ path: '', reason: 'merge-base' }] }
    const inner = await mergeCommitTrees(staged, base, bases[i]!, depth + 1)
    if (!inner.ok) return { ok: false, reason: 'conflict', conflicts: [{ path: '', reason: 'merge-base' }] }
    base = staged.add('commit', serializeCommit({ tree: inner.tree, parents: [base, bases[i]!], author: VIRTUAL_SIGNATURE, committer: VIRTUAL_SIGNATURE, message: 'merged tree' }))
  }
  const merged = await mergeTrees(staged, await treeOf(staged, base), await treeOf(staged, ours), await treeOf(staged, theirs))
  if (merged.conflicts.length > 0) return { ok: false, reason: 'conflict', conflicts: merged.conflicts }
  return { ok: true, tree: merged.tree, bases }
}

export type MergeMethod = 'merge' | 'squash' | 'rebase'

export const MERGE_METHODS: readonly MergeMethod[] = ['merge', 'squash', 'rebase']

export type MergeRequest = {
  readonly base: ObjectId
  readonly head: ObjectId
  readonly method: MergeMethod
  readonly message: string
  readonly committer: Signature
  readonly author?: Signature
}

export type RebasedCommit = { readonly original: ObjectId; readonly rewritten: ObjectId }

export type MergeOutcome =
  | {
      readonly ok: true
      readonly commit: ObjectId
      readonly tree: ObjectId
      readonly objects: readonly (GitObject & { readonly id: ObjectId })[]
      readonly rebased: readonly RebasedCommit[]
    }
  | { readonly ok: false; readonly reason: 'conflict'; readonly conflicts: readonly MergeConflict[] }
  | { readonly ok: false; readonly reason: 'up-to-date' | 'unrelated' | 'merge-commits' }

const reachableObjects = (staged: StagedObjects, tip: ObjectId): (GitObject & { readonly id: ObjectId })[] => {
  const all = new Map(staged.objects().map((object) => [object.id, object]))
  const keep = new Map<ObjectId, GitObject & { readonly id: ObjectId }>()
  const stack = [tip]
  while (stack.length > 0) {
    const id = stack.pop()!
    const object = all.get(id)
    if (!object || keep.has(id)) continue
    keep.set(id, object)
    if (object.type === 'commit') {
      const commit = parseCommit(object.data)
      stack.push(commit.tree, ...commit.parents)
    } else if (object.type === 'tree') stack.push(...parseTree(object.data).filter((entry) => !isSubmodule(entry)).map((entry) => entry.id))
  }
  return [...keep.values()]
}

const isAncestorOf = async (source: ObjectSource, ancestor: ObjectId, descendant: ObjectId): Promise<boolean> => (await ancestors(source, descendant)).has(ancestor)

const SIGNATURE_HEADERS = new Set(['gpgsig', 'gpgsig-sha256'])

export const rebaseCommits = async (
  staged: StagedObjects,
  onto: ObjectId,
  commits: readonly ObjectId[],
  committer: Signature,
): Promise<{ readonly ok: true; readonly tip: ObjectId; readonly rebased: readonly RebasedCommit[] } | { readonly ok: false; readonly reason: 'conflict'; readonly conflicts: readonly MergeConflict[] } | { readonly ok: false; readonly reason: 'merge-commits' }> => {
  let tip = onto
  let tipTree = await treeOf(staged, onto)
  const rebased: RebasedCommit[] = []
  for (const id of commits) {
    const details = await readCommitDetails(staged, id)
    if (details.parents.length > 1) return { ok: false, reason: 'merge-commits' }
    const parentTree = details.parents.length === 0 ? null : await treeOf(staged, details.parents[0]!)
    if (parentTree === details.tree) {
      tip = staged.add('commit', serializeCommit(rewrite(details, tipTree, tip, committer)))
      rebased.push({ original: id, rewritten: tip })
      continue
    }
    const merged = await mergeTrees(staged, parentTree, tipTree, details.tree)
    if (merged.conflicts.length > 0) return { ok: false, reason: 'conflict', conflicts: merged.conflicts }
    if (merged.tree === tipTree) continue
    tipTree = merged.tree
    tip = staged.add('commit', serializeCommit(rewrite(details, tipTree, tip, committer)))
    rebased.push({ original: id, rewritten: tip })
  }
  return { ok: true, tip, rebased }
}

const rewrite = (details: CommitDetails, tree: ObjectId, parent: ObjectId, committer: Signature): NewCommit => ({
  tree,
  parents: [parent],
  author: details.author,
  committer,
  message: details.message,
  extraHeaders: details.extraHeaders.filter(([key]) => !SIGNATURE_HEADERS.has(key)),
})

export const mergeBranches = async (source: ObjectSource, request: MergeRequest): Promise<MergeOutcome> => {
  const staged = new StagedObjects(source)
  if (await isAncestorOf(staged, request.head, request.base)) return { ok: false, reason: 'up-to-date' }
  const author = request.author ?? request.committer
  if (request.method === 'rebase') {
    const bases = await mergeBases(staged, request.base, request.head)
    if (bases.length === 0) return { ok: false, reason: 'unrelated' }
    const commits = await commitsBetween(staged, request.base, request.head)
    const result = await rebaseCommits(staged, request.base, commits, request.committer)
    if (!result.ok) return result
    if (result.tip === request.base) return { ok: false, reason: 'up-to-date' }
    return { ok: true, commit: result.tip, tree: await treeOf(staged, result.tip), objects: reachableObjects(staged, result.tip), rebased: result.rebased }
  }
  const merged = await mergeCommitTrees(staged, request.base, request.head)
  if (!merged.ok) return merged
  const parents = request.method === 'merge' ? [request.base, request.head] : [request.base]
  const commit = staged.add('commit', serializeCommit({ tree: merged.tree, parents, author, committer: request.committer, message: request.message }))
  return { ok: true, commit, tree: merged.tree, objects: reachableObjects(staged, commit), rebased: [] }
}

export type Mergeability = {
  readonly mergeable: boolean
  readonly rebaseable: boolean
  readonly upToDate: boolean
  readonly conflicts: readonly MergeConflict[]
  readonly reason: 'clean' | 'conflict' | 'up-to-date' | 'unrelated'
}

const PROBE_SIGNATURE: Signature = { name: 'git-forge', email: 'git-forge@localhost', timestamp: 0, timezone: '+0000' }

export const checkMergeability = async (source: ObjectSource, base: ObjectId, head: ObjectId): Promise<Mergeability> => {
  const staged = new StagedObjects(source)
  if (await isAncestorOf(staged, head, base)) return { mergeable: false, rebaseable: false, upToDate: true, conflicts: [], reason: 'up-to-date' }
  const merged = await mergeCommitTrees(staged, base, head)
  if (!merged.ok && merged.reason === 'unrelated') return { mergeable: false, rebaseable: false, upToDate: false, conflicts: [], reason: 'unrelated' }
  const upToDate = await isAncestorOf(staged, base, head)
  const rebase = await rebaseCommits(staged, base, await commitsBetween(staged, base, head), PROBE_SIGNATURE)
  return {
    mergeable: merged.ok,
    rebaseable: rebase.ok,
    upToDate,
    conflicts: merged.ok ? [] : merged.conflicts,
    reason: merged.ok ? 'clean' : 'conflict',
  }
}
