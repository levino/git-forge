import { concat, utf8 } from './bytes.ts'
import { isObjectId, type ObjectId } from './hash.ts'
import { isTreeMode, parseCommit, parseTree } from './objects.ts'
import { advertisedRefs, ObjectDatabase, type RepositoryName, readRefs } from './repository.ts'
import type { Storage } from './storage.ts'

const BLOCK = 512

const encoder = new TextEncoder()

const octal = (value: number, width: number): string => value.toString(8).padStart(width - 1, '0') + '\0'

const field = (target: Uint8Array, offset: number, width: number, text: string): void => {
  target.set(encoder.encode(text).subarray(0, width), offset)
}

type Entry = {
  readonly path: string
  readonly type: '0' | '2' | '5' | 'x' | 'g'
  readonly mode: number
  readonly size: number
  readonly linkName?: string
  readonly mtime: number
}

const header = (entry: Entry): Uint8Array => {
  const block = new Uint8Array(BLOCK)
  field(block, 0, 100, entry.path)
  field(block, 100, 8, octal(entry.mode, 8))
  field(block, 108, 8, octal(0, 8))
  field(block, 116, 8, octal(0, 8))
  field(block, 124, 12, octal(entry.size, 12))
  field(block, 136, 12, octal(entry.mtime, 12))
  block.fill(0x20, 148, 156)
  field(block, 156, 1, entry.type)
  if (entry.linkName) field(block, 157, 100, entry.linkName)
  field(block, 257, 6, 'ustar\0')
  field(block, 263, 2, '00')
  field(block, 265, 32, 'root')
  field(block, 297, 32, 'root')
  let sum = 0
  for (const byte of block) sum += byte
  field(block, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ')
  return block
}

const padding = (size: number): Uint8Array => new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK)

const paxRecord = (key: string, value: string): string => {
  const body = ` ${key}=${value}\n`
  const bodyLength = encoder.encode(body).length
  let total = bodyLength + 1
  for (;;) {
    const candidate = bodyLength + String(total).length
    if (candidate === total) break
    total = candidate
  }
  return `${total}${body}`
}

const pax = (records: string, type: 'x' | 'g', name: string, mtime: number): Uint8Array => {
  const data = utf8(records)
  return concat([header({ path: name, type, mode: 0o644, size: data.length, mtime }), data, padding(data.length)])
}

const fits = (text: string): boolean => encoder.encode(text).length <= 100

const entryBlocks = (entry: Entry, data?: Uint8Array): Uint8Array => {
  const records = (fits(entry.path) ? '' : paxRecord('path', entry.path)) + (entry.linkName && !fits(entry.linkName) ? paxRecord('linkpath', entry.linkName) : '')
  const parts: Uint8Array[] = []
  if (records) parts.push(pax(records, 'x', 'PaxHeader', entry.mtime))
  parts.push(header({ ...entry, path: fits(entry.path) ? entry.path : entry.path.slice(0, 99) }))
  if (data) parts.push(data, padding(data.length))
  return concat(parts)
}

export type TarballOptions = {
  readonly prefix: string
}

export const commitTarball = (odb: ObjectDatabase, commitId: ObjectId, options: TarballOptions): ReadableStream<Uint8Array> => {
  type Pending = { readonly tree: ObjectId; readonly path: string }
  let stack: Pending[] | undefined
  let mtime = 0
  const prefix = options.prefix.replace(/\/*$/, '/')
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!stack) {
        const commit = await odb.read(commitId)
        if (!commit || commit.type !== 'commit') throw new Error(`${commitId} is not a commit`)
        const parsed = parseCommit(commit.data)
        mtime = Number(/^committer .* (\d+) [+-]\d{4}$/m.exec(new TextDecoder().decode(commit.data).split('\n\n')[0] ?? '')?.[1] ?? 0)
        controller.enqueue(pax(paxRecord('comment', commitId), 'g', 'pax_global_header', mtime))
        controller.enqueue(entryBlocks({ path: prefix, type: '5', mode: 0o775, size: 0, mtime }))
        stack = [{ tree: parsed.tree, path: prefix }]
        return
      }
      const next = stack.pop()
      if (!next) {
        controller.enqueue(new Uint8Array(BLOCK * 2))
        controller.close()
        return
      }
      const tree = await odb.read(next.tree)
      if (!tree || tree.type !== 'tree') throw new Error(`missing tree ${next.tree}`)
      const subtrees: Pending[] = []
      for (const entry of parseTree(tree.data)) {
        const path = `${next.path}${entry.name}`
        if (isTreeMode(entry.mode)) {
          controller.enqueue(entryBlocks({ path: `${path}/`, type: '5', mode: 0o775, size: 0, mtime }))
          subtrees.push({ tree: entry.id, path: `${path}/` })
          continue
        }
        if (entry.mode === '160000') {
          controller.enqueue(entryBlocks({ path: `${path}/`, type: '5', mode: 0o775, size: 0, mtime }))
          continue
        }
        const blob = await odb.read(entry.id)
        if (!blob || blob.type !== 'blob') throw new Error(`missing blob ${entry.id}`)
        if (entry.mode === '120000') {
          controller.enqueue(entryBlocks({ path, type: '2', mode: 0o777, size: 0, linkName: new TextDecoder().decode(blob.data), mtime }))
        } else {
          controller.enqueue(entryBlocks({ path, type: '0', mode: entry.mode === '100755' ? 0o775 : 0o664, size: blob.data.length, mtime }, blob.data))
        }
      }
      stack.push(...subtrees.reverse())
    },
  })
}

export const gzipStream = (stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> =>
  stream.pipeThrough(new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>)

export const resolveCommitish = async (storage: Storage, repo: RepositoryName, ref: string): Promise<ObjectId | null> => {
  const stored = await readRefs(storage, repo)
  if (!stored) return null
  const odb = new ObjectDatabase(storage, repo)
  const peelToCommit = async (id: ObjectId): Promise<ObjectId | null> => {
    const peeled = await odb.peel(id)
    return (await odb.read(peeled))?.type === 'commit' ? peeled : null
  }
  if (isObjectId(ref.toLowerCase()) && (await odb.has(ref.toLowerCase()))) return peelToCommit(ref.toLowerCase())
  const { refs } = advertisedRefs(stored.state)
  const candidates = ref.startsWith('refs/') ? [ref] : [`refs/tags/${ref}`, `refs/heads/${ref}`]
  for (const name of candidates) {
    const id = refs[name]
    if (id) return peelToCommit(id)
  }
  for (const [name, id] of Object.entries(stored.state.refs)) {
    if (/^refs\/upstream\/[^/]+\/(tags|heads)\//.test(name) && name.replace(/^refs\/upstream\/[^/]+\/(tags|heads)\//, '') === ref) return peelToCommit(id)
  }
  return null
}
