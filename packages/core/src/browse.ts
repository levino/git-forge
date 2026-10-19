import { fromUtf8 } from './bytes.ts'
import { looksLikeText } from './content.ts'
import { diffTrees, type TreeChange } from './diff.ts'
import type { ObjectId } from './hash.ts'
import { type LfsObjectSpec, parseLfsPointer } from './lfs.ts'
import { isSubmodule, isTreeMode, parseCommitMetadata, parseTag, parseTree, type Signature, type TreeEntry } from './objects.ts'
import { advertisedRefs, ObjectDatabase, readRefs, type RefsState, type RepositoryName } from './repository.ts'
import type { Storage } from './storage.ts'
import type { ObjectSource } from './walk.ts'

export type CommitInfo = {
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

const UNKNOWN: Signature = { name: '', email: '', timestamp: 0, timezone: '+0000' }

export const parseCommitInfo = (id: ObjectId, data: Uint8Array): CommitInfo => {
  const metadata = parseCommitMetadata(data)
  return {
    id,
    tree: metadata.tree,
    parents: metadata.parents,
    author: metadata.author ?? metadata.committer ?? UNKNOWN,
    committer: metadata.committer ?? metadata.author ?? UNKNOWN,
    message: metadata.message,
    summary: metadata.message.split('\n', 1)[0]!.trim(),
  }
}

export const readCommit = async (odb: ObjectDatabase, id: ObjectId): Promise<CommitInfo | null> => {
  const object = await odb.read(id)
  return object?.type === 'commit' ? parseCommitInfo(id, object.data) : null
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

export const entryAt = async (odb: ObjectSource, tree: ObjectId, path: readonly string[]): Promise<TreeEntry | null> => {
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

export type LogPage = { readonly commits: readonly CommitInfo[]; readonly more: boolean }

const touchesPath = async (odb: ObjectDatabase, commit: CommitInfo, path: readonly string[]): Promise<boolean> => {
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
  const queue: CommitInfo[] = first ? [first] : []
  const matched: CommitInfo[] = []
  const maxWalk = options.maxWalk ?? DEFAULT_MAX_LOG_WALK
  let walked = 0
  while (queue.length > 0 && matched.length < wanted && walked++ < maxWalk) {
    let best = 0
    for (let i = 1; i < queue.length; i++) if (queue[i]!.committer.timestamp > queue[best]!.committer.timestamp) best = i
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

export const lastCommitFor = async (odb: ObjectDatabase, start: ObjectId, path: readonly string[]): Promise<CommitInfo | null> =>
  (await commitLog(odb, start, { limit: 1, path })).commits[0] ?? null

export const commitChanges = async (odb: ObjectDatabase, commit: CommitInfo): Promise<TreeChange[]> => {
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

export const repositoryStats = async (storage: Storage, repo: RepositoryName): Promise<{ readonly defaultBranch: string | null; readonly lastCommitAt: number | null }> => {
  const state = (await readRefs(storage, repo))?.state
  if (!state) return { defaultBranch: null, lastCommitAt: null }
  const { head, refs } = advertisedRefs(state)
  const commit = refs[head] ? await readCommit(new ObjectDatabase(storage, repo), refs[head]).catch(() => null) : null
  return { defaultBranch: defaultBranch(state), lastCommitAt: commit ? commit.committer.timestamp * 1000 : null }
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

export const pathIdAt = async (odb: ObjectDatabase, commit: ObjectId, path: readonly string[]): Promise<ObjectId | null> => {
  const info = await readCommit(odb, commit)
  return info ? ((await entryAt(odb, info.tree, path))?.id ?? null) : null
}
