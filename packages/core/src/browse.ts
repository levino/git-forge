import { fromUtf8 } from './bytes.ts'
import { looksLikeText } from './content.ts'
import { diffLines, type LineDiff, splitLines } from './diff.ts'
import type { ObjectId } from './hash.ts'
import { type LfsObjectSpec, parseLfsPointer } from './lfs.ts'
import { isSubmodule, isTreeMode, parseTag, parseTree, type TreeEntry } from './objects.ts'
import { advertisedRefs, type ObjectDatabase, type RefsState } from './repository.ts'

export type Signature = {
  readonly name: string
  readonly email: string
  readonly time: number
  readonly timezone: string
}

export type CommitDetails = {
  readonly id: ObjectId
  readonly tree: ObjectId
  readonly parents: readonly ObjectId[]
  readonly author: Signature
  readonly committer: Signature
  readonly message: string
  readonly summary: string
}

export type EntryKind = 'tree' | 'blob' | 'symlink' | 'submodule'

export type DirectoryEntry = TreeEntry & { readonly kind: EntryKind }

export type RefKind = 'branch' | 'tag'

export type NamedRef = { readonly kind: RefKind; readonly name: string; readonly ref: string; readonly id: ObjectId }

const SIGNATURE = /^(.*?) <([^>]*)> (-?\d+) ([+-]\d{4})$/

export const parseSignature = (value: string): Signature => {
  const match = SIGNATURE.exec(value)
  if (!match) return { name: value, email: '', time: 0, timezone: '+0000' }
  return { name: match[1]!, email: match[2]!, time: Number(match[3]), timezone: match[4]! }
}

export const parseCommitDetails = (id: ObjectId, data: Uint8Array): CommitDetails => {
  const text = fromUtf8(data)
  const end = text.indexOf('\n\n')
  const header = (end === -1 ? text : text.slice(0, end)).split('\n')
  const message = end === -1 ? '' : text.slice(end + 2)
  let tree: ObjectId | undefined
  const parents: ObjectId[] = []
  let author: Signature | undefined
  let committer: Signature | undefined
  for (const line of header) {
    if (line.startsWith('tree ')) tree = line.slice(5)
    else if (line.startsWith('parent ')) parents.push(line.slice(7))
    else if (line.startsWith('author ')) author = parseSignature(line.slice(7))
    else if (line.startsWith('committer ')) committer = parseSignature(line.slice(10))
  }
  if (!tree) throw new Error('commit without tree')
  const unknown = { name: '', email: '', time: 0, timezone: '+0000' }
  return {
    id,
    tree,
    parents,
    author: author ?? committer ?? unknown,
    committer: committer ?? author ?? unknown,
    message,
    summary: message.split('\n', 1)[0]!.trim(),
  }
}

export const readCommit = async (odb: ObjectDatabase, id: ObjectId): Promise<CommitDetails | null> => {
  const object = await odb.read(id)
  return object?.type === 'commit' ? parseCommitDetails(id, object.data) : null
}

export const entryKind = (entry: TreeEntry): EntryKind =>
  isTreeMode(entry.mode) ? 'tree' : isSubmodule(entry) ? 'submodule' : entry.mode === '120000' ? 'symlink' : 'blob'

const compareEntries = (a: DirectoryEntry, b: DirectoryEntry): number => {
  const rank = (entry: DirectoryEntry) => (entry.kind === 'tree' ? 0 : 1)
  return rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

export const readTreeEntries = async (odb: ObjectDatabase, tree: ObjectId): Promise<DirectoryEntry[] | null> => {
  const object = await odb.read(tree)
  if (object?.type !== 'tree') return null
  return parseTree(object.data)
    .map((entry) => ({ ...entry, kind: entryKind(entry) }))
    .sort(compareEntries)
}

export type PathTarget =
  | { readonly kind: 'tree'; readonly id: ObjectId; readonly entries: readonly DirectoryEntry[] }
  | { readonly kind: 'blob'; readonly entry: DirectoryEntry }
  | { readonly kind: 'submodule'; readonly entry: DirectoryEntry }

export const resolveTarget = async (odb: ObjectDatabase, commit: ObjectId, path: readonly string[]): Promise<PathTarget | null> => {
  const details = await readCommit(odb, commit)
  if (!details) return null
  let current: DirectoryEntry = { mode: '40000', name: '', id: details.tree, kind: 'tree' }
  for (const segment of path) {
    if (current.kind !== 'tree') return null
    const entries = await readTreeEntries(odb, current.id)
    const next = entries?.find((candidate) => candidate.name === segment)
    if (!next) return null
    current = next
  }
  if (current.kind === 'tree') {
    const entries = await readTreeEntries(odb, current.id)
    return entries ? { kind: 'tree', id: current.id, entries } : null
  }
  if (current.kind === 'submodule') return { kind: 'submodule', entry: current }
  return { kind: 'blob', entry: current }
}

const entryAt = async (odb: ObjectDatabase, tree: ObjectId, path: readonly string[]): Promise<TreeEntry | null> => {
  let current: TreeEntry = { mode: '40000', name: '', id: tree }
  for (const segment of path) {
    if (!isTreeMode(current.mode)) return null
    const object = await odb.read(current.id)
    if (object?.type !== 'tree') return null
    const next = parseTree(object.data).find((candidate) => candidate.name === segment)
    if (!next) return null
    current = next
  }
  return current
}

export type BlobContent =
  | { readonly kind: 'text'; readonly text: string; readonly size: number }
  | { readonly kind: 'binary'; readonly size: number }
  | { readonly kind: 'lfs'; readonly pointer: LfsObjectSpec }

export const readBlobContent = async (odb: ObjectDatabase, entry: TreeEntry): Promise<BlobContent | null> => {
  const object = await odb.read(entry.id)
  if (object?.type !== 'blob') return null
  const pointer = entry.mode === '120000' ? null : parseLfsPointer(object.data)
  if (pointer) return { kind: 'lfs', pointer }
  if (!looksLikeText(object.data)) return { kind: 'binary', size: object.data.length }
  return { kind: 'text', text: fromUtf8(object.data), size: object.data.length }
}

export type LogOptions = {
  readonly limit: number
  readonly skip?: number
  readonly path?: readonly string[]
  readonly maxWalk?: number
}

export const DEFAULT_MAX_LOG_WALK = 10_000

export type LogPage = { readonly commits: readonly CommitDetails[]; readonly more: boolean }

const touchesPath = async (odb: ObjectDatabase, commit: CommitDetails, path: readonly string[]): Promise<boolean> => {
  const own = await entryAt(odb, commit.tree, path)
  if (commit.parents.length === 0) return own !== null
  for (const parent of commit.parents) {
    const details = await readCommit(odb, parent)
    if (!details) return true
    const theirs = await entryAt(odb, details.tree, path)
    if (own?.id === theirs?.id && own?.mode === theirs?.mode) return false
  }
  return true
}

export const commitLog = async (odb: ObjectDatabase, start: ObjectId, options: LogOptions): Promise<LogPage> => {
  const skip = options.skip ?? 0
  const path = options.path ?? []
  const wanted = skip + options.limit + 1
  const seen = new Set<ObjectId>([start])
  const first = await readCommit(odb, start)
  const queue: CommitDetails[] = first ? [first] : []
  const matched: CommitDetails[] = []
  const maxWalk = options.maxWalk ?? DEFAULT_MAX_LOG_WALK
  let walked = 0
  while (queue.length > 0 && matched.length < wanted && walked++ < maxWalk) {
    let best = 0
    for (let i = 1; i < queue.length; i++) if (queue[i]!.committer.time > queue[best]!.committer.time) best = i
    const commit = queue.splice(best, 1)[0]!
    if (path.length === 0 || (await touchesPath(odb, commit, path))) matched.push(commit)
    for (const parent of commit.parents) {
      if (seen.has(parent)) continue
      seen.add(parent)
      const details = await readCommit(odb, parent)
      if (details) queue.push(details)
    }
  }
  return { commits: matched.slice(skip, skip + options.limit), more: matched.length > skip + options.limit }
}

export const lastCommitFor = async (odb: ObjectDatabase, start: ObjectId, path: readonly string[]): Promise<CommitDetails | null> =>
  (await commitLog(odb, start, { limit: 1, path })).commits[0] ?? null

export type ChangeStatus = 'added' | 'deleted' | 'modified'

export type FileChange = {
  readonly status: ChangeStatus
  readonly path: string
  readonly oldId: ObjectId | null
  readonly newId: ObjectId | null
  readonly oldMode: string | null
  readonly newMode: string | null
}

const treeMap = async (odb: ObjectDatabase, tree: ObjectId | null): Promise<Map<string, TreeEntry>> => {
  if (tree === null) return new Map()
  const object = await odb.read(tree)
  if (object?.type !== 'tree') return new Map()
  return new Map(parseTree(object.data).map((entry) => [entry.name, entry]))
}

export const diffTrees = async (odb: ObjectDatabase, oldTree: ObjectId | null, newTree: ObjectId | null, prefix = ''): Promise<FileChange[]> => {
  if (oldTree === newTree) return []
  const [before, after] = await Promise.all([treeMap(odb, oldTree), treeMap(odb, newTree)])
  const names = [...new Set([...before.keys(), ...after.keys()])].sort()
  const changes: FileChange[] = []
  for (const name of names) {
    const a = before.get(name) ?? null
    const b = after.get(name) ?? null
    if (a && b && a.id === b.id && a.mode === b.mode) continue
    const path = `${prefix}${name}`
    const aTree = a !== null && isTreeMode(a.mode)
    const bTree = b !== null && isTreeMode(b.mode)
    if (aTree || bTree) {
      changes.push(...(await diffTrees(odb, aTree ? a.id : null, bTree ? b.id : null, `${path}/`)))
      if (a && !aTree) changes.push({ status: 'deleted', path, oldId: a.id, newId: null, oldMode: a.mode, newMode: null })
      if (b && !bTree) changes.push({ status: 'added', path, oldId: null, newId: b.id, oldMode: null, newMode: b.mode })
      continue
    }
    changes.push({
      status: a && b ? 'modified' : a ? 'deleted' : 'added',
      path,
      oldId: a?.id ?? null,
      newId: b?.id ?? null,
      oldMode: a?.mode ?? null,
      newMode: b?.mode ?? null,
    })
  }
  return changes.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
}

export type FileDiff =
  | { readonly kind: 'text'; readonly diff: LineDiff }
  | { readonly kind: 'binary' }
  | { readonly kind: 'lfs'; readonly before: LfsObjectSpec | null; readonly after: LfsObjectSpec | null }
  | { readonly kind: 'submodule' }

export const MAX_DIFF_BLOB_BYTES = 512 * 1024

const blobSide = async (odb: ObjectDatabase, id: ObjectId | null, mode: string | null) => {
  if (id === null || mode === null) return { kind: 'none' as const }
  if (mode === '160000') return { kind: 'submodule' as const }
  const object = await odb.read(id)
  if (object?.type !== 'blob') return { kind: 'none' as const }
  const pointer = mode === '120000' ? null : parseLfsPointer(object.data)
  if (pointer) return { kind: 'lfs' as const, pointer }
  if (object.data.length > MAX_DIFF_BLOB_BYTES || !looksLikeText(object.data)) return { kind: 'binary' as const }
  return { kind: 'text' as const, lines: splitLines(fromUtf8(object.data)) }
}

export const diffFile = async (odb: ObjectDatabase, change: FileChange): Promise<FileDiff> => {
  const [before, after] = await Promise.all([blobSide(odb, change.oldId, change.oldMode), blobSide(odb, change.newId, change.newMode)])
  if (before.kind === 'submodule' || after.kind === 'submodule') return { kind: 'submodule' }
  if (before.kind === 'lfs' || after.kind === 'lfs') {
    return { kind: 'lfs', before: before.kind === 'lfs' ? before.pointer : null, after: after.kind === 'lfs' ? after.pointer : null }
  }
  if (before.kind === 'binary' || after.kind === 'binary') return { kind: 'binary' }
  return { kind: 'text', diff: diffLines(before.kind === 'text' ? before.lines : [], after.kind === 'text' ? after.lines : []) }
}

export const commitChanges = async (odb: ObjectDatabase, commit: CommitDetails): Promise<FileChange[]> => {
  const parent = commit.parents[0] ? await readCommit(odb, commit.parents[0]) : null
  return diffTrees(odb, parent?.tree ?? null, commit.tree)
}

export const namedRefs = (state: RefsState): { readonly head: string; readonly branches: NamedRef[]; readonly tags: NamedRef[] } => {
  const { head, refs } = advertisedRefs(state)
  const branches: NamedRef[] = []
  const tags: NamedRef[] = []
  for (const [ref, id] of Object.entries(refs)) {
    if (ref.startsWith('refs/heads/')) branches.push({ kind: 'branch', name: ref.slice(11), ref, id })
    else if (ref.startsWith('refs/tags/')) tags.push({ kind: 'tag', name: ref.slice(10), ref, id })
  }
  const byName = (a: NamedRef, b: NamedRef) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  return { head, branches: branches.sort(byName), tags: tags.sort(byName) }
}

export const defaultBranch = (state: RefsState): string | null => {
  const { head, refs } = advertisedRefs(state)
  return head.startsWith('refs/heads/') && refs[head] !== undefined ? head.slice(11) : null
}

export const peelToCommitId = async (odb: ObjectDatabase, id: ObjectId): Promise<ObjectId | null> => {
  let current = id
  for (let depth = 0; depth < 10; depth++) {
    const object = await odb.read(current)
    if (!object) return null
    if (object.type === 'commit') return current
    if (object.type !== 'tag') return null
    current = parseTag(object.data).object
  }
  return null
}

export type RefTarget = { readonly commit: ObjectId; readonly ref: string; readonly immutable: boolean; readonly path: readonly string[] }

export const resolveRefAndPath = async (odb: ObjectDatabase, state: RefsState, segments: readonly string[]): Promise<RefTarget | null> => {
  const { head, refs } = advertisedRefs(state)
  const [first] = segments
  if (first !== undefined && /^[0-9a-f]{40}$/.test(first)) {
    const commit = await peelToCommitId(odb, first)
    if (commit) return { commit, ref: first, immutable: true, path: segments.slice(1) }
  }
  for (let length = segments.length; length >= 1; length--) {
    const name = segments.slice(0, length).join('/')
    const id = name === 'HEAD' ? refs[head] : (refs[`refs/heads/${name}`] ?? refs[`refs/tags/${name}`])
    if (id === undefined) continue
    const commit = await peelToCommitId(odb, id)
    return commit ? { commit, ref: name, immutable: false, path: segments.slice(length) } : null
  }
  return null
}
