import { fromUtf8, toHex } from './bytes.ts'
import type { ObjectId } from './hash.ts'

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag'

export type GitObject = {
  readonly type: ObjectType
  readonly data: Uint8Array
}

export const PACK_TYPE_CODES: Readonly<Record<ObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 }

export const OFS_DELTA = 6
export const REF_DELTA = 7

export const typeFromCode = (code: number): ObjectType => {
  switch (code) {
    case 1:
      return 'commit'
    case 2:
      return 'tree'
    case 3:
      return 'blob'
    case 4:
      return 'tag'
    default:
      throw new Error(`unknown object type code ${code}`)
  }
}

export type Commit = {
  readonly tree: ObjectId
  readonly parents: readonly ObjectId[]
}

const headerLines = (data: Uint8Array): string[] => {
  const text = fromUtf8(data)
  const end = text.indexOf('\n\n')
  return (end === -1 ? text : text.slice(0, end)).split('\n')
}

export const parseCommit = (data: Uint8Array): Commit => {
  let tree: ObjectId | undefined
  const parents: ObjectId[] = []
  for (const line of headerLines(data)) {
    if (line.startsWith('tree ')) tree = line.slice(5)
    else if (line.startsWith('parent ')) parents.push(line.slice(7))
  }
  if (!tree) throw new Error('commit without tree')
  return { tree, parents }
}

export type Tag = {
  readonly object: ObjectId
  readonly type: ObjectType
}

export const parseTag = (data: Uint8Array): Tag => {
  let object: ObjectId | undefined
  let type: ObjectType | undefined
  for (const line of headerLines(data)) {
    if (line.startsWith('object ')) object = line.slice(7)
    else if (line.startsWith('type ')) type = line.slice(5) as ObjectType
  }
  if (!object || !type) throw new Error('invalid tag')
  return { object, type }
}

export type TreeEntry = {
  readonly mode: string
  readonly name: string
  readonly id: ObjectId
}

export const parseTree = (data: Uint8Array): TreeEntry[] => {
  const entries: TreeEntry[] = []
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    const nul = data.indexOf(0x00, space)
    if (space === -1 || nul === -1 || nul + 21 > data.length) throw new Error('invalid tree')
    entries.push({
      mode: fromUtf8(data.subarray(offset, space)),
      name: fromUtf8(data.subarray(space + 1, nul)),
      id: toHex(data.subarray(nul + 1, nul + 21)),
    })
    offset = nul + 21
  }
  return entries
}

export const isSubmodule = (entry: TreeEntry): boolean => entry.mode === '160000'

export const isTreeMode = (mode: string): boolean => mode === '40000' || mode === '040000'

export const references = (object: GitObject): ObjectId[] => {
  switch (object.type) {
    case 'commit': {
      const commit = parseCommit(object.data)
      return [commit.tree, ...commit.parents]
    }
    case 'tree':
      return parseTree(object.data)
        .filter((entry) => !isSubmodule(entry))
        .map((entry) => entry.id)
    case 'tag':
      return [parseTag(object.data).object]
    case 'blob':
      return []
  }
}
