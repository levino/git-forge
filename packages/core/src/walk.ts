import type { ObjectId } from './hash.ts'
import { type GitObject, parseCommit, references } from './objects.ts'

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

export const reachable = async (source: ObjectSource, tips: Iterable<ObjectId>, stop: (id: ObjectId) => boolean = () => false): Promise<ObjectId[]> => {
  const seen = new Set<ObjectId>()
  const order: ObjectId[] = []
  const stack = [...tips]
  while (stack.length > 0) {
    const id = stack.pop() as ObjectId
    if (seen.has(id) || stop(id)) continue
    seen.add(id)
    order.push(id)
    const object = await mustRead(source, id)
    const refs = references(object)
    for (let i = refs.length - 1; i >= 0; i--) stack.push(refs[i] as ObjectId)
  }
  return order
}

export const checkConnectivity = async (
  source: ObjectSource,
  tip: ObjectId,
  isNew: (id: ObjectId) => boolean,
  exists: (id: ObjectId) => Promise<boolean>,
): Promise<ObjectId | null> => {
  const seen = new Set<ObjectId>()
  const stack = [tip]
  while (stack.length > 0) {
    const id = stack.pop() as ObjectId
    if (seen.has(id)) continue
    seen.add(id)
    if (!isNew(id)) {
      if (await exists(id)) continue
      return id
    }
    const object = await mustRead(source, id)
    stack.push(...references(object))
  }
  return null
}
