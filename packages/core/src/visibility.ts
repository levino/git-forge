import { peelToCommitId } from './browse.ts'
import type { ObjectId } from './hash.ts'
import { LFS_POINTER_MAX_SIZE, parseLfsPointer } from './lfs.ts'
import { isSubmodule, isTreeMode, parseCommit, parseTree } from './objects.ts'
import { type AdvertisedRefs, advertisedRefs, ObjectDatabase, readRefs, type RefsState, type RepositoryName } from './repository.ts'
import type { Storage } from './storage.ts'
import { isAncestor } from './walk.ts'

export type Reach = 'none' | 'above' | 'inside'

export type ReadView = { readonly reach: (ref: string, path: string) => Reach }

export type PathReach = (path: string) => Reach

const RANK: Record<Reach, number> = { none: 0, above: 1, inside: 2 }

export const widest = (reaches: Iterable<Reach>): Reach => {
  let best: Reach = 'none'
  for (const reach of reaches) if (RANK[reach] > RANK[best]) best = reach
  return best
}

export const pathReach = (allowed: string | null, path: string): Reach => {
  if (allowed === null || allowed === path || path.startsWith(`${allowed}/`)) return 'inside'
  return path === '' || allowed.startsWith(`${path}/`) ? 'above' : 'none'
}

export const visibleRefs = (state: RefsState, view: ReadView, git = false): AdvertisedRefs => {
  const all = advertisedRefs(state)
  const refs = Object.fromEntries(Object.entries(all.refs).filter(([name]) => (git ? view.reach(name, '') === 'inside' : view.reach(name, '') !== 'none')))
  const names = Object.keys(refs).sort()
  const head = refs[all.head] ? all.head : (names.find((name) => name.startsWith('refs/heads/')) ?? names[0] ?? 'refs/heads/main')
  return { head, refs }
}

export const commitReach = async (odb: ObjectDatabase, state: RefsState, view: ReadView, commit: ObjectId): Promise<PathReach | null> => {
  const tips = await Promise.all(Object.entries(visibleRefs(state, view).refs).map(async ([name, id]) => [name, await peelToCommitId(odb, id)] as const))
  const names = tips.filter(([, tip]) => tip === commit).map(([name]) => name)
  if (names.length === 0) for (const [name, tip] of tips) if (tip && (await isAncestor(odb, commit, tip))) names.push(name)
  return names.length > 0 ? (path) => widest(names.map((name) => view.reach(name, path))) : null
}

export const visibleLfsObjects = async (odb: ObjectDatabase, state: RefsState, view: ReadView, wanted: ReadonlySet<string>): Promise<Set<string>> => {
  const found = new Set<string>()
  const scan = async (tree: ObjectId, path: string, reach: PathReach, seen: Set<string>): Promise<void> => {
    const key = reach(path) === 'inside' ? tree : `${tree}:${path}`
    if (seen.has(key) || found.size === wanted.size) return
    seen.add(key)
    const object = await odb.read(tree)
    if (object?.type !== 'tree') return
    for (const entry of parseTree(object.data)) {
      const full = path ? `${path}/${entry.name}` : entry.name
      const entryReach = reach(full)
      if (isSubmodule(entry) || entryReach === 'none') continue
      if (isTreeMode(entry.mode)) await scan(entry.id, full, reach, seen)
      else if (entryReach === 'inside' && entry.mode !== '120000' && !seen.has(entry.id)) {
        seen.add(entry.id)
        const data = await odb.smallBlob(entry.id, LFS_POINTER_MAX_SIZE)
        const pointer = data ? parseLfsPointer(data) : null
        if (pointer && wanted.has(pointer.oid)) found.add(pointer.oid)
      }
    }
  }
  for (const [name, id] of Object.entries(visibleRefs(state, view).refs)) {
    const reach: PathReach = (path) => view.reach(name, path)
    const seen = new Set<string>()
    const commits = [await peelToCommitId(odb, id)]
    while (commits.length > 0 && found.size < wanted.size) {
      const commit = commits.pop()
      if (!commit || seen.has(commit)) continue
      seen.add(commit)
      const object = await odb.read(commit)
      if (object?.type !== 'commit') continue
      const { tree, parents } = parseCommit(object.data)
      await scan(tree, '', reach, seen)
      commits.push(...parents)
    }
  }
  return found
}

export const readableLfsObjects = async (storage: Storage, repo: RepositoryName, view: ReadView, oids: Iterable<string>): Promise<Set<string>> => {
  const refs = await readRefs(storage, repo)
  return refs ? visibleLfsObjects(new ObjectDatabase(storage, repo), refs.state, view, new Set(oids)) : new Set()
}

export const refusal = (granted: Response | ReadView | null | undefined): Response | null =>
  granted instanceof Response ? granted : granted ? new Response('permission denied\n', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }) : null
