import { concat } from './bytes.ts'
import { type CommitDetails, type NewCommit, parseCommitDetails, serializeCommit, serializeTree, StagedObjects } from './commit.ts'
import { diffTrees, isBinaryContent } from './diff.ts'
import type { ObjectId } from './hash.ts'
import { type GitObject, isSubmodule, type Signature, isTreeMode, parseCommit, parseTree, type TreeEntry } from './objects.ts'
import { MissingObjectError, type ObjectSource } from './walk.ts'
import { basename, detectRenames, type RenameSource, type RenameTarget } from './rename.ts'
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

type Slot = (TreeEntry & { readonly node?: Node }) | undefined

type Node = { readonly id: ObjectId | null; readonly path: string }

type Overlay = Map<string, TreeEntry | null>

const same = (x: Slot, y: Slot): boolean => (x === undefined ? y === undefined : y !== undefined && x.id === y.id && x.mode === y.mode)

const isRegular = (mode: string): boolean => mode === '100644' || mode === '100755'

type Context = {
  readonly source: ObjectSource
  readonly staged: StagedObjects
  readonly conflicts: MergeConflict[]
  readonly overlays: readonly [Overlay, Overlay, Overlay]
  readonly dirty: readonly [Set<string>, Set<string>, Set<string>]
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

const childPath = (parent: string, name: string): string => (parent === '' ? name : `${parent}/${name}`)

const parentPath = (path: string): string => {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

type Listing = { readonly entries: readonly NonNullable<Slot>[]; readonly real: readonly TreeEntry[] }

const listing = async (context: Context, side: 0 | 1 | 2, node: Node | null): Promise<Listing> => {
  if (node === null) return { entries: [], real: [] }
  const real = await readEntries(context.source, node.id)
  if (!context.dirty[side].has(node.path)) return { entries: real.map((entry) => (isTreeMode(entry.mode) ? { ...entry, node: { id: entry.id, path: childPath(node.path, entry.name) } } : entry)), real }
  const overlay = context.overlays[side]
  const entries: NonNullable<Slot>[] = []
  const dirs = new Set<string>()
  for (const entry of real) {
    const path = childPath(node.path, entry.name)
    if (isTreeMode(entry.mode)) {
      dirs.add(entry.name)
      entries.push({ ...entry, id: context.dirty[side].has(path) ? `virtual:${side}:${path}` : entry.id, node: { id: entry.id, path } })
    } else if (!overlay.has(path)) entries.push(entry)
  }
  for (const [path, entry] of overlay) if (entry && parentPath(path) === node.path) entries.push(entry)
  for (const path of context.dirty[side]) {
    if (path === '' || parentPath(path) !== node.path) continue
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (!dirs.has(name)) entries.push({ mode: '40000', name, id: `virtual:${side}:${path}`, node: { id: null, path } })
  }
  return { entries, real }
}

const mergeLevel = async (
  context: Context,
  path: string,
  base: Node | null,
  ours: Node | null,
  theirs: Node | null,
): Promise<ObjectId | null> => {
  const [b, o, t] = await Promise.all([listing(context, 0, base), listing(context, 1, ours), listing(context, 2, theirs)])
  const names = [...new Set([...b.entries, ...o.entries, ...t.entries].map((entry) => entry.name))]
  const result: TreeEntry[] = []
  for (const name of names) {
    const full = childPath(path, name)
    const pick = (entries: readonly NonNullable<Slot>[], tree: boolean) => entries.find((entry) => entry.name === name && isTreeMode(entry.mode) === tree)
    const [bFile, oFile, tFile] = [pick(b.entries, false), pick(o.entries, false), pick(t.entries, false)]
    const [bDir, oDir, tDir] = [pick(b.entries, true), pick(o.entries, true), pick(t.entries, true)]
    let file: TreeEntry | null = null
    if (same(oFile, tFile)) file = oFile ?? null
    else if (same(bFile, oFile)) file = tFile ?? null
    else if (same(bFile, tFile)) file = oFile ?? null
    else if (oFile && tFile) file = await mergeFile(context, full, bFile, oFile, tFile)
    else context.conflicts.push({ path: full, reason: 'modify/delete' })
    const dir =
      same(bDir, oDir) && same(bDir, tDir)
        ? (bDir?.id ?? null)
        : await mergeLevel(context, full, bDir?.node ?? null, oDir?.node ?? null, tDir?.node ?? null)
    if (file && dir) context.conflicts.push({ path: full, reason: 'directory/file' })
    if (file) result.push({ mode: file.mode, name, id: file.id })
    if (dir) result.push({ mode: '40000', name, id: dir })
  }
  if (result.length === 0) return null
  return context.staged.add('tree', serializeTree(result))
}

const entryAt = async (source: ObjectSource, tree: ObjectId | null, path: string): Promise<TreeEntry | null> => {
  let current = tree
  const segments = path.split('/')
  for (let i = 0; i < segments.length; i++) {
    if (current === null) return null
    const entry = (await readEntries(source, current)).find((candidate) => candidate.name === segments[i])
    if (!entry) return null
    if (i === segments.length - 1) return entry
    if (!isTreeMode(entry.mode)) return null
    current = entry.id
  }
  return null
}

const fileAt = async (source: ObjectSource, tree: ObjectId | null, path: string): Promise<TreeEntry | null> => {
  const entry = await entryAt(source, tree, path)
  return entry && !isTreeMode(entry.mode) ? entry : null
}

type SideRenames = { readonly renames: ReadonlyMap<string, string>; readonly sources: ReadonlyMap<string, TreeEntry>; readonly relevant: readonly string[]; readonly ok: boolean }

const ancestorsOf = (path: string): string[] => {
  const found: string[] = []
  for (let current = parentPath(path); current !== ''; current = parentPath(current)) found.push(current)
  return found
}

const sideRenames = async (context: Context, base: ObjectId | null, side: ObjectId, other: ObjectId): Promise<SideRenames> => {
  const { source } = context
  const changes = await diffTrees(source, base, side, { renames: false })
  const removed = new Set(changes.filter((change) => change.status === 'removed').map((change) => change.path))
  const added = new Set(changes.filter((change) => change.status === 'added').map((change) => change.path))
  const removedDirectories = new Map<string, boolean>()
  const isDirectoryRemoved = async (directory: string) => {
    if (directory === '') return false
    if (!removedDirectories.has(directory)) {
      const entry = await entryAt(source, side, directory)
      const before = await entryAt(source, base, directory)
      removedDirectories.set(directory, before !== null && isTreeMode(before.mode) && (!entry || !isTreeMode(entry.mode)))
    }
    return removedDirectories.get(directory)!
  }
  const otherAdded = (await diffTrees(source, base, other, { renames: false })).filter((change) => change.status === 'added').map((change) => change.path)
  const landing = new Map<string, string[]>()
  for (const path of otherAdded) {
    const directories: string[] = []
    for (const directory of ancestorsOf(path)) if (await isDirectoryRemoved(directory)) directories.push(directory)
    if (directories.length > 0) landing.set(path, directories)
  }
  const landingDirectories = new Set([...landing.values()].flat())
  const sources: RenameSource[] = []
  const entries = new Map<string, TreeEntry>()
  for (const change of changes) {
    if (change.status !== 'removed' || added.has(change.path)) continue
    const entry = { mode: change.oldMode!, name: basename(change.path), id: change.oldId! }
    const theirs = await fileAt(source, other, change.path)
    const relevant = !theirs || theirs.id !== entry.id || theirs.mode !== entry.mode || ancestorsOf(change.path).some((directory) => landingDirectories.has(directory))
    sources.push({ path: change.path, entry, relevant })
    entries.set(change.path, entry)
  }
  const targets: RenameTarget[] = changes
    .filter((change) => change.status === 'added' && !removed.has(change.path))
    .map((change) => ({ path: change.path, entry: { mode: change.newMode!, name: basename(change.path), id: change.newId! } }))
  const detection = await detectRenames(sources, targets, { read: (id) => readObject(source, id, 'blob'), isDirectoryRemoved })
  const relevant = sources.filter((candidate) => candidate.relevant).map((candidate) => candidate.path)
  if (!detection.ok) return { renames: new Map(), sources: entries, relevant, ok: false }
  const renamedFrom = new Set([...detection.renames.keys()].flatMap(ancestorsOf))
  for (const [path, directories] of landing) if (directories.some((directory) => renamedFrom.has(directory))) context.conflicts.push({ path, reason: 'directory-rename' })
  const kept = new Map([...detection.renames].filter(([path]) => sources.find((candidate) => candidate.path === path)!.relevant))
  return { renames: kept, sources: entries, relevant, ok: true }
}

const markDirty = (dirty: Set<string>, path: string) => {
  let current = parentPath(path)
  while (true) {
    dirty.add(current)
    if (current === '') return
    current = parentPath(current)
  }
}

const applyRenames = async (context: Context, base: ObjectId | null, ours: ObjectId, theirs: ObjectId): Promise<void> => {
  const sides = [await sideRenames(context, base, ours, theirs), await sideRenames(context, base, theirs, ours)] as const
  if (!sides[0].ok || !sides[1].ok) {
    for (const side of sides) if (!side.ok) for (const path of side.relevant) context.conflicts.push({ path, reason: 'rename' })
    return
  }
  const trees = [ours, theirs] as const
  const move = (side: 0 | 1 | 2, from: string, to: string, entry: TreeEntry) => {
    context.overlays[side].set(from, null)
    context.overlays[side].set(to, { ...entry, name: basename(to) })
    markDirty(context.dirty[side], from)
    markDirty(context.dirty[side], to)
  }
  for (const index of [0, 1] as const) {
    const mine = sides[index]
    const other = sides[1 - index]!
    const otherSide = (2 - index) as 1 | 2
    const otherTargets = new Set(other.renames.values())
    for (const [from, to] of mine.renames) {
      const baseEntry = mine.sources.get(from)!
      if (other.renames.has(from)) {
        if (index === 1) continue
        if (other.renames.get(from) !== to) context.conflicts.push({ path: from, reason: 'rename' })
        else move(0, from, to, baseEntry)
        continue
      }
      const otherEntry = await fileAt(context.source, trees[1 - index]!, from)
      if (!otherEntry) {
        context.conflicts.push({ path: from, reason: 'rename' })
        continue
      }
      if (otherTargets.has(to) || (await fileAt(context.source, trees[1 - index]!, to))) {
        context.conflicts.push({ path: to, reason: 'rename' })
        continue
      }
      move(0, from, to, baseEntry)
      move(otherSide, from, to, otherEntry)
    }
  }
}

export const mergeTrees = async (staged: StagedObjects, base: ObjectId | null, ours: ObjectId, theirs: ObjectId): Promise<TreeMerge> => {
  const context: Context = { source: staged, staged, conflicts: [], overlays: [new Map(), new Map(), new Map()], dirty: [new Set(), new Set(), new Set()] }
  await applyRenames(context, base, ours, theirs)
  const tree =
    (await mergeLevel(context, '', base === null ? null : { id: base, path: '' }, { id: ours, path: '' }, { id: theirs, path: '' })) ??
    staged.add('tree', EMPTY_TREE_DATA)
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
