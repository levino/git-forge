import type { ObjectId } from './hash.ts'
import { type GitObject, isSubmodule, isTreeMode, parseCommit, parseTag, parseTree } from './objects.ts'

export type ObjectSource = {
  read(id: ObjectId): Promise<GitObject | null>
}

export class MissingObjectError extends Error {
  constructor(readonly id: ObjectId) {
    super(`missing object ${id}`)
  }
}

const mustRead = async (source: ObjectSource, id: ObjectId): Promise<GitObject> => {
  const object = await source.read(id)
  if (!object) throw new MissingObjectError(id)
  return object
}

export const isAncestor = async (source: ObjectSource, ancestor: ObjectId, descendant: ObjectId): Promise<boolean> => {
  const seen = new Set<ObjectId>()
  const queue = [descendant]
  while (queue.length > 0) {
    const id = queue.shift() as ObjectId
    if (id === ancestor) return true
    if (seen.has(id)) continue
    seen.add(id)
    const object = await source.read(id)
    if (!object || object.type !== 'commit') continue
    queue.push(...parseCommit(object.data).parents)
  }
  return false
}

const peelToCommit = async (source: ObjectSource, id: ObjectId): Promise<ObjectId | null> => {
  let current = id
  for (let depth = 0; depth < 10; depth++) {
    const object = await source.read(current)
    if (!object) return null
    if (object.type === 'commit') return current
    if (object.type !== 'tag') return null
    current = parseTag(object.data).object
  }
  return null
}

export const commitsReachable = async (source: ObjectSource, tips: Iterable<ObjectId>): Promise<Set<ObjectId>> => {
  const closure = new Set<ObjectId>()
  const stack: ObjectId[] = []
  for (const tip of new Set(tips)) {
    const commit = await peelToCommit(source, tip)
    if (commit) stack.push(commit)
  }
  while (stack.length > 0) {
    const id = stack.pop() as ObjectId
    if (closure.has(id)) continue
    closure.add(id)
    const object = await mustRead(source, id)
    stack.push(...parseCommit(object.data).parents)
  }
  return closure
}

const treeClosure = async (source: ObjectSource, roots: Iterable<ObjectId>, into: Set<ObjectId>): Promise<void> => {
  const stack = [...roots]
  while (stack.length > 0) {
    const id = stack.pop() as ObjectId
    if (into.has(id)) continue
    into.add(id)
    const object = await mustRead(source, id)
    for (const entry of parseTree(object.data)) {
      if (isSubmodule(entry)) continue
      if (isTreeMode(entry.mode)) stack.push(entry.id)
      else into.add(entry.id)
    }
  }
}

export type FetchSet = {
  readonly ids: readonly ObjectId[]
  readonly clientHas: ReadonlySet<ObjectId>
}

export const objectsToSend = async (source: ObjectSource, wants: Iterable<ObjectId>, haves: Iterable<ObjectId>): Promise<FetchSet> => {
  const haveCommits = await commitsReachable(source, haves)
  const ids: ObjectId[] = []
  const seen = new Set<ObjectId>()
  const trees: ObjectId[] = []
  const boundary = new Set<ObjectId>()
  const stack = [...wants]
  while (stack.length > 0) {
    const id = stack.pop() as ObjectId
    if (seen.has(id) || haveCommits.has(id)) continue
    seen.add(id)
    const object = await mustRead(source, id)
    if (object.type === 'tree') {
      seen.delete(id)
      trees.push(id)
      continue
    }
    ids.push(id)
    if (object.type === 'tag') stack.push(parseTag(object.data).object)
    else if (object.type === 'commit') {
      const commit = parseCommit(object.data)
      trees.push(commit.tree)
      for (const parent of commit.parents) {
        if (haveCommits.has(parent)) boundary.add(parent)
        else stack.push(parent)
      }
    }
  }
  const clientHas = new Set<ObjectId>(haveCommits)
  const boundaryTrees: ObjectId[] = []
  for (const id of boundary) boundaryTrees.push(parseCommit((await mustRead(source, id)).data).tree)
  await treeClosure(source, boundaryTrees, clientHas)
  const treeStack = [...trees]
  while (treeStack.length > 0) {
    const id = treeStack.pop() as ObjectId
    if (seen.has(id) || clientHas.has(id)) continue
    seen.add(id)
    ids.push(id)
    const object = await mustRead(source, id)
    for (const entry of parseTree(object.data)) {
      if (isSubmodule(entry) || seen.has(entry.id) || clientHas.has(entry.id)) continue
      if (isTreeMode(entry.mode)) treeStack.push(entry.id)
      else {
        seen.add(entry.id)
        ids.push(entry.id)
      }
    }
  }
  return { ids, clientHas }
}
