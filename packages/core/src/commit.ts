import { concat, fromHex, fromUtf8, streamOf, utf8 } from './bytes.ts'
import { hashObject, type ObjectId } from './hash.ts'
import { type GitObject, isTreeMode, type ObjectType, type TreeEntry } from './objects.ts'
import { writePack } from './pack.ts'
import type { ObjectDatabase } from './repository.ts'
import type { ObjectSource } from './walk.ts'

export type Signature = {
  readonly name: string
  readonly email: string
  readonly timestamp: number
  readonly timezone: string
}

export type CommitDetails = {
  readonly tree: ObjectId
  readonly parents: readonly ObjectId[]
  readonly author: Signature
  readonly committer: Signature
  readonly extraHeaders: readonly (readonly [string, string])[]
  readonly message: string
}

const SIGNATURE = /^(.*?) ?<([^<>]*)> (-?\d+) ([+-]\d{4})$/

export const parseSignature = (text: string): Signature => {
  const match = SIGNATURE.exec(text)
  if (!match) return { name: text, email: '', timestamp: 0, timezone: '+0000' }
  return { name: match[1]!, email: match[2]!, timestamp: Number(match[3]), timezone: match[4]! }
}

export const formatSignature = (signature: Signature): string =>
  `${signature.name} <${signature.email}> ${signature.timestamp} ${signature.timezone}`

export const signatureDate = (signature: Signature): string => {
  const sign = signature.timezone.startsWith('-') ? -1 : 1
  const offsetMinutes = sign * (Number(signature.timezone.slice(1, 3)) * 60 + Number(signature.timezone.slice(3, 5)))
  const local = new Date((signature.timestamp + offsetMinutes * 60) * 1000).toISOString().replace(/\.\d{3}Z$/, '')
  return offsetMinutes === 0 ? `${local}Z` : `${local}${signature.timezone.slice(0, 3)}:${signature.timezone.slice(3)}`
}

export const signatureAt = (name: string, email: string, at: Date): Signature => ({
  name: name.replace(/[<>\n]/g, ''),
  email: email.replace(/[<>\n]/g, ''),
  timestamp: Math.floor(at.getTime() / 1000),
  timezone: '+0000',
})

export const parseCommitDetails = (data: Uint8Array): CommitDetails => {
  const text = fromUtf8(data)
  const end = text.indexOf('\n\n')
  const header = end === -1 ? text : text.slice(0, end)
  const message = end === -1 ? '' : text.slice(end + 2)
  let tree: ObjectId | undefined
  const parents: ObjectId[] = []
  let author: Signature | undefined
  let committer: Signature | undefined
  const extraHeaders: [string, string][] = []
  for (const line of header.split('\n')) {
    if (line.startsWith(' ') && extraHeaders.length > 0) {
      const last = extraHeaders[extraHeaders.length - 1]!
      last[1] = `${last[1]}\n${line.slice(1)}`
      continue
    }
    const space = line.indexOf(' ')
    const key = space === -1 ? line : line.slice(0, space)
    const value = space === -1 ? '' : line.slice(space + 1)
    if (key === 'tree') tree = value
    else if (key === 'parent') parents.push(value)
    else if (key === 'author') author = parseSignature(value)
    else if (key === 'committer') committer = parseSignature(value)
    else extraHeaders.push([key, value])
  }
  if (!tree || !author || !committer) throw new Error('invalid commit')
  return { tree, parents, author, committer, extraHeaders, message }
}

export type NewCommit = {
  readonly tree: ObjectId
  readonly parents: readonly ObjectId[]
  readonly author: Signature
  readonly committer: Signature
  readonly message: string
  readonly extraHeaders?: readonly (readonly [string, string])[]
}

export const serializeCommit = (commit: NewCommit): Uint8Array => {
  const lines = [`tree ${commit.tree}`, ...commit.parents.map((parent) => `parent ${parent}`)]
  lines.push(`author ${formatSignature(commit.author)}`, `committer ${formatSignature(commit.committer)}`)
  for (const [key, value] of commit.extraHeaders ?? []) lines.push(`${key} ${value.replace(/\n/g, '\n ')}`)
  const message = commit.message.endsWith('\n') || commit.message === '' ? commit.message : `${commit.message}\n`
  return utf8(`${lines.join('\n')}\n\n${message}`)
}

const sortKey = (entry: TreeEntry): Uint8Array => utf8(isTreeMode(entry.mode) ? `${entry.name}/` : entry.name)

const compareKeys = (a: Uint8Array, b: Uint8Array): number => {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!
  return a.length - b.length
}

export const sortTreeEntries = (entries: readonly TreeEntry[]): TreeEntry[] =>
  [...entries].sort((a, b) => compareKeys(sortKey(a), sortKey(b)))

export const serializeTree = (entries: readonly TreeEntry[]): Uint8Array =>
  concat(
    sortTreeEntries(entries).flatMap((entry) => [utf8(`${isTreeMode(entry.mode) ? '40000' : entry.mode} ${entry.name}\0`), fromHex(entry.id)]),
  )

export class StagedObjects implements ObjectSource {
  readonly #base: ObjectSource
  readonly #added = new Map<ObjectId, GitObject>()

  constructor(base: ObjectSource) {
    this.#base = base
  }

  add(type: ObjectType, data: Uint8Array): ObjectId {
    const id = hashObject(type, data)
    if (!this.#added.has(id)) this.#added.set(id, { type, data })
    return id
  }

  async read(id: ObjectId): Promise<GitObject | null> {
    return this.#added.get(id) ?? (await this.#base.read(id))
  }

  objects(): (GitObject & { readonly id: ObjectId })[] {
    return [...this.#added.entries()].map(([id, object]) => ({ id, ...object }))
  }

  get size(): number {
    return this.#added.size
  }
}

export const storeObjects = async (odb: ObjectDatabase, objects: readonly (GitObject & { readonly id: ObjectId })[]): Promise<string | null> => {
  const missing: (GitObject & { readonly id: ObjectId })[] = []
  for (const object of objects) if (!(await odb.has(object.id))) missing.push(object)
  if (missing.length === 0) return null
  const { name } = await odb.ingest(streamOf(writePack(missing).bytes), { checkReferences: false })
  return name
}
