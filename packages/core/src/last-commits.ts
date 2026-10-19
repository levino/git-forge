import { fromUtf8, readAll, utf8 } from './bytes.ts'
import { type CommitInfo, DEFAULT_MAX_LOG_WALK, readCommit } from './browse.ts'
import type { ObjectId } from './hash.ts'
import { ByteLru } from './lru.ts'
import { isTreeMode, parseTree, type TreeEntry } from './objects.ts'
import { type ObjectDatabase, type RepositoryName, repositoryPrefix } from './repository.ts'

export type LastCommits = ReadonlyMap<string, ObjectId | null>

export const MAX_LAST_COMMIT_PATHS = 20_000

export const lastCommitsKey = (repo: RepositoryName, commit: ObjectId): string => `${repositoryPrefix(repo)}cache/last-commits/${commit}.json`

const join = (prefix: string, name: string) => (prefix === '' ? name : `${prefix}/${name}`)

const readEntries = async (odb: ObjectDatabase, tree: ObjectId | null): Promise<TreeEntry[] | null> => {
  if (tree === null) return []
  const object = await odb.read(tree)
  return object?.type === 'tree' ? parseTree(object.data) : null
}

const listPaths = async (odb: ObjectDatabase, tree: ObjectId, prefix: string, out: string[]): Promise<boolean> => {
  for (const entry of (await readEntries(odb, tree)) ?? []) {
    const path = join(prefix, entry.name)
    out.push(path)
    if (out.length > MAX_LAST_COMMIT_PATHS) return false
    if (isTreeMode(entry.mode) && !(await listPaths(odb, entry.id, path, out))) return false
  }
  return true
}

const prefixes = (path: string): string[] => {
  const parts = path.split('/')
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
}

export const computeLastCommits = async (
  odb: ObjectDatabase,
  start: ObjectId,
  known: ReadonlyMap<ObjectId, LastCommits> = new Map(),
  maxWalk = DEFAULT_MAX_LOG_WALK,
): Promise<LastCommits | null> => {
  const first = await readCommit(odb, start)
  if (!first) return null
  const all: string[] = []
  if (!(await listPaths(odb, first.tree, '', all))) return null
  const unresolved = new Set(all)
  const below = new Map<string, number>([['', all.length]])
  for (const path of all) for (const prefix of prefixes(path)) below.set(prefix, (below.get(prefix) ?? 0) + 1)
  const result = new Map<string, ObjectId | null>()
  const resolve = (path: string, id: ObjectId | null) => {
    if (!unresolved.delete(path)) return
    result.set(path, id)
    for (const prefix of ['', ...prefixes(path)]) below.set(prefix, below.get(prefix)! - 1)
  }
  const differing = async (a: ObjectId | null, b: ObjectId | null, prefix: string, candidates: ReadonlySet<string>, out: Set<string>): Promise<boolean> => {
    const [left, right] = await Promise.all([readEntries(odb, a), readEntries(odb, b)])
    if (!left || !right) return false
    const theirs = new Map(right.map((entry) => [entry.name, entry]))
    const names = new Set([...left.map((entry) => entry.name), ...theirs.keys()])
    const ours = new Map(left.map((entry) => [entry.name, entry]))
    for (const name of names) {
      const x = ours.get(name)
      const y = theirs.get(name)
      if (x && y && x.id === y.id && x.mode === y.mode) continue
      const path = join(prefix, name)
      if (candidates.has(path)) out.add(path)
      if ((below.get(path) ?? 0) > 0) {
        const tree = (entry: TreeEntry | undefined) => (entry && isTreeMode(entry.mode) ? entry.id : null)
        if (!(await differing(tree(x), tree(y), path, candidates, out))) return false
      }
    }
    return true
  }
  const touched = async (commit: CommitInfo): Promise<Set<string>> => {
    let candidates: Set<string> = unresolved
    if (commit.parents.length === 0) {
      const out = new Set<string>()
      await differing(commit.tree, null, '', candidates, out)
      return out
    }
    for (const parent of commit.parents) {
      const details = await readCommit(odb, parent)
      if (!details) continue
      const out = new Set<string>()
      if (details.tree !== commit.tree && !(await differing(commit.tree, details.tree, '', candidates, out))) continue
      candidates = out
      if (candidates.size === 0) break
    }
    return candidates
  }
  const seen = new Set<ObjectId>([start])
  const queue: CommitInfo[] = [first]
  let walked = 0
  while (queue.length > 0 && unresolved.size > 0 && walked++ < maxWalk) {
    let best = 0
    for (let i = 1; i < queue.length; i++) if (queue[i]!.committer.timestamp > queue[best]!.committer.timestamp) best = i
    const commit = queue.splice(best, 1)[0]!
    const earlier = queue.length === 0 && commit.id !== start ? known.get(commit.id) : undefined
    if (earlier) {
      for (const path of [...unresolved]) resolve(path, earlier.get(path) ?? null)
      break
    }
    for (const path of await touched(commit)) resolve(path, commit.id)
    for (const parent of commit.parents) {
      if (seen.has(parent)) continue
      seen.add(parent)
      const details = await readCommit(odb, parent)
      if (details) queue.push(details)
    }
  }
  for (const path of [...unresolved]) resolve(path, null)
  return result
}

type Stored = { readonly commits: readonly ObjectId[]; readonly paths: Readonly<Record<string, number>> }

const encode = (map: LastCommits): Uint8Array => {
  const commits: ObjectId[] = []
  const index = new Map<ObjectId, number>()
  const paths = Object.fromEntries(
    [...map].map(([path, id]) => {
      if (id !== null && !index.has(id)) index.set(id, commits.push(id) - 1)
      return [path, id === null ? -1 : index.get(id)!]
    }),
  )
  return utf8(JSON.stringify({ commits, paths } satisfies Stored))
}

const parsed = new ByteLru<ObjectId, LastCommits>(16 * 1024 * 1024)

export const storeLastCommits = async (odb: ObjectDatabase, commit: ObjectId, map: LastCommits): Promise<void> => {
  const bytes = encode(map)
  const result = await odb.storage.put(lastCommitsKey(odb.repo, commit), bytes, bytes.length, { ifNoneMatch: '*', contentType: 'application/json' })
  if (result.ok) parsed.set(commit, map, bytes.length)
}

export const hasLastCommits = async (odb: ObjectDatabase, commit: ObjectId): Promise<boolean> =>
  parsed.has(commit) || (await odb.storage.head(lastCommitsKey(odb.repo, commit))) !== null

export const readLastCommits = async (odb: ObjectDatabase, commit: ObjectId): Promise<LastCommits | null> => {
  const known = parsed.get(commit)
  if (known) return known
  const object = await odb.storage.get(lastCommitsKey(odb.repo, commit))
  if (!object) return null
  const bytes = await readAll(object.body)
  const stored = JSON.parse(fromUtf8(bytes)) as Stored
  const map = new Map(Object.entries(stored.paths).map(([path, i]) => [path, i < 0 ? null : stored.commits[i]!]))
  parsed.set(commit, map, bytes.length)
  return map
}

export type LastCommitsUpdate = { readonly id: ObjectId; readonly previous: ObjectId | null }

export const precomputeLastCommits = async (odb: ObjectDatabase, updates: readonly LastCommitsUpdate[]): Promise<number> => {
  let stored = 0
  for (const { id, previous } of updates) {
    if (await hasLastCommits(odb, id)) continue
    const earlier = previous ? await readLastCommits(odb, previous) : null
    const map = await computeLastCommits(odb, id, previous && earlier ? new Map([[previous, earlier]]) : undefined)
    if (map) {
      await storeLastCommits(odb, id, map)
      stored++
    }
  }
  return stored
}
