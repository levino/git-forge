import { readAll, toHex, utf8, fromUtf8 } from './bytes.ts'
import { type ObjectId, ZERO_ID } from './hash.ts'
import { applyDelta } from './delta.ts'
import { type GitObject, OFS_DELTA, parseTag, REF_DELTA, typeFromCode } from './objects.ts'
import { readEntryHeader, readOfsDeltaOffset, type ResolvedObject } from './pack.ts'
import { PackIndex, writeIndex } from './pack-index.ts'
import type { Storage } from './storage.ts'
import { inflateAt } from './zlib.ts'

export type RepositoryName = {
  readonly owner: string
  readonly name: string
}

export type RefsState = {
  readonly head: string
  readonly refs: Readonly<Record<string, ObjectId>>
}

export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

export const isValidName = (value: string): boolean => NAME_PATTERN.test(value) && !value.endsWith('.git') && !value.includes('..')

export const repositoryPrefix = (repo: RepositoryName): string => `repos/${repo.owner}/${repo.name}/`

export const gitPrefix = (repo: RepositoryName): string => `${repositoryPrefix(repo)}git/`

const refsKey = (repo: RepositoryName) => `${repositoryPrefix(repo)}refs.json`
const packsKey = (repo: RepositoryName) => `${gitPrefix(repo)}objects/info/packs`
const infoRefsKey = (repo: RepositoryName) => `${gitPrefix(repo)}info/refs`
const headKey = (repo: RepositoryName) => `${gitPrefix(repo)}HEAD`
export const packKey = (repo: RepositoryName, name: string) => `${gitPrefix(repo)}objects/pack/${name}`

const putText = async (storage: Storage, key: string, text: string) => {
  const bytes = utf8(text)
  await storage.put(key, bytes, bytes.length, { contentType: 'text/plain' })
}

const getText = async (storage: Storage, key: string): Promise<{ text: string; etag: string } | null> => {
  const object = await storage.get(key)
  return object ? { text: fromUtf8(await readAll(object.body)), etag: object.etag } : null
}

export class RepositoryExistsError extends Error {}

export const createRepository = async (storage: Storage, repo: RepositoryName, defaultBranch = 'main'): Promise<void> => {
  if (!isValidName(repo.owner) || !isValidName(repo.name)) throw new Error('invalid repository name')
  const state: RefsState = { head: `refs/heads/${defaultBranch}`, refs: {} }
  const bytes = utf8(JSON.stringify(state))
  const result = await storage.put(refsKey(repo), bytes, bytes.length, { ifNoneMatch: '*', contentType: 'application/json' })
  if (!result.ok) throw new RepositoryExistsError(`${repo.owner}/${repo.name} exists`)
  await putText(storage, packsKey(repo), '\n')
  await putText(storage, headKey(repo), `ref: ${state.head}\n`)
  await putText(storage, infoRefsKey(repo), '')
}

export type VersionedRefs = {
  readonly state: RefsState
  readonly etag: string
}

export const readRefs = async (storage: Storage, repo: RepositoryName): Promise<VersionedRefs | null> => {
  const stored = await getText(storage, refsKey(repo))
  return stored ? { state: JSON.parse(stored.text) as RefsState, etag: stored.etag } : null
}

export const writeRefs = async (storage: Storage, repo: RepositoryName, state: RefsState, expectedEtag: string): Promise<boolean> => {
  const bytes = utf8(JSON.stringify(state))
  const result = await storage.put(refsKey(repo), bytes, bytes.length, { ifMatch: expectedEtag, contentType: 'application/json' })
  return result.ok
}

export const sortedRefs = (state: RefsState): [string, ObjectId][] =>
  Object.entries(state.refs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

export const writeServerInfo = async (storage: Storage, repo: RepositoryName, state: RefsState, odb: ObjectDatabase): Promise<void> => {
  const lines: string[] = []
  for (const [name, id] of sortedRefs(state)) {
    lines.push(`${id}\t${name}\n`)
    const peeled = await odb.peel(id)
    if (peeled !== id) lines.push(`${peeled}\t${name}^{}\n`)
  }
  await putText(storage, infoRefsKey(repo), lines.join(''))
  await putText(storage, headKey(repo), `ref: ${state.head}\n`)
}

type LoadedPack = { readonly name: string; readonly index: PackIndex; bytes?: Uint8Array }

export class ObjectDatabase {
  readonly #storage: Storage
  readonly #repo: RepositoryName
  #packs: LoadedPack[] | undefined
  readonly #cache = new Map<ObjectId, GitObject>()

  constructor(storage: Storage, repo: RepositoryName) {
    this.#storage = storage
    this.#repo = repo
  }

  async packNames(): Promise<string[]> {
    const stored = await getText(this.#storage, packsKey(this.#repo))
    return (stored?.text ?? '')
      .split('\n')
      .filter((line) => line.startsWith('P '))
      .map((line) => line.slice(2).trim())
  }

  async #loadPacks(): Promise<LoadedPack[]> {
    if (this.#packs) return this.#packs
    const names = await this.packNames()
    const packs: LoadedPack[] = []
    for (const name of names) {
      const stored = await this.#storage.get(packKey(this.#repo, name.replace(/\.pack$/, '.idx')))
      if (!stored) throw new Error(`missing index for ${name}`)
      packs.push({ name, index: new PackIndex(await readAll(stored.body)) })
    }
    this.#packs = packs
    return packs
  }

  async packFiles(name: string): Promise<{ readonly bytes: Uint8Array; readonly index: Uint8Array }> {
    const index = await this.#storage.get(packKey(this.#repo, name.replace(/\.pack$/, '.idx')))
    if (!index) throw new Error(`missing index for ${name}`)
    const pack = (await this.#loadPacks()).find((candidate) => candidate.name === name)
    if (!pack) throw new Error(`pack ${name} is not registered`)
    return { bytes: await this.#packBytes(pack), index: await readAll(index.body) }
  }

  async smallBlobs(name: string, maxSize: number): Promise<{ readonly id: ObjectId; readonly data: Uint8Array }[]> {
    const pack = (await this.#loadPacks()).find((candidate) => candidate.name === name)
    if (!pack) throw new Error(`pack ${name} is not registered`)
    const bytes = await this.#packBytes(pack)
    const blobs: { id: ObjectId; data: Uint8Array }[] = []
    for (const { id, offset } of pack.index.entries()) {
      const header = readEntryHeader(bytes, offset)
      let candidate = header.typeCode === BLOB_CODE && header.size <= maxSize
      if (header.typeCode === OFS_DELTA || header.typeCode === REF_DELTA) {
        const start = offset + header.headerLength
        const position = header.typeCode === OFS_DELTA ? start + readOfsDeltaOffset(bytes, start).length : start + 20
        candidate = deltaResultSize(inflateAt(bytes, position).data) <= maxSize
      }
      if (!candidate) continue
      const object = await this.read(id)
      if (object?.type === 'blob') blobs.push({ id, data: object.data })
    }
    return blobs
  }

  invalidate(): void {
    this.#packs = undefined
  }

  async #packBytes(pack: LoadedPack): Promise<Uint8Array> {
    if (!pack.bytes) {
      const stored = await this.#storage.get(packKey(this.#repo, pack.name))
      if (!stored) throw new Error(`missing pack ${pack.name}`)
      pack.bytes = await readAll(stored.body)
    }
    return pack.bytes
  }

  async #readAt(pack: LoadedPack, offset: number): Promise<GitObject> {
    const bytes = await this.#packBytes(pack)
    const header = readEntryHeader(bytes, offset)
    let position = offset + header.headerLength
    if (header.typeCode === OFS_DELTA) {
      const ofs = readOfsDeltaOffset(bytes, position)
      position += ofs.length
      const base = await this.#readAt(pack, offset - ofs.distance)
      return { type: base.type, data: applyDelta(base.data, inflateAt(bytes, position).data) }
    }
    if (header.typeCode === REF_DELTA) {
      const baseId = toHex(bytes.subarray(position, position + 20))
      position += 20
      const base = await this.read(baseId)
      if (!base) throw new Error(`missing delta base ${baseId}`)
      return { type: base.type, data: applyDelta(base.data, inflateAt(bytes, position).data) }
    }
    return { type: typeFromCode(header.typeCode), data: inflateAt(bytes, position).data }
  }

  async read(id: ObjectId): Promise<GitObject | null> {
    const cached = this.#cache.get(id)
    if (cached) return cached
    for (const pack of await this.#loadPacks()) {
      const offset = pack.index.find(id)
      if (offset === null) continue
      const object = await this.#readAt(pack, offset)
      this.#cache.set(id, object)
      return object
    }
    return null
  }

  async has(id: ObjectId): Promise<boolean> {
    if (this.#cache.has(id)) return true
    for (const pack of await this.#loadPacks()) if (pack.index.find(id) !== null) return true
    return false
  }

  async peel(id: ObjectId): Promise<ObjectId> {
    let current = id
    for (let depth = 0; depth < 10; depth++) {
      const object = await this.read(current)
      if (!object || object.type !== 'tag') return current
      current = parseTag(object.data).object
    }
    return current
  }

  async addPack(bytes: Uint8Array, objects: readonly ResolvedObject[], checksum: Uint8Array): Promise<string> {
    const name = `pack-${toHex(checksum)}.pack`
    const index = writeIndex(objects, checksum)
    await this.#storage.put(packKey(this.#repo, name), bytes, bytes.length, { contentType: 'application/x-git-packed-objects' })
    await this.#storage.put(packKey(this.#repo, name.replace(/\.pack$/, '.idx')), index, index.length, {
      contentType: 'application/x-git-packed-objects-toc',
    })
    await registerPacks(this.#storage, this.#repo, [name])
    for (const object of objects) this.#cache.set(object.id, { type: object.type, data: object.data })
    this.invalidate()
    return name
  }
}

const BLOB_CODE = 3

const deltaResultSize = (delta: Uint8Array): number => {
  let position = 0
  for (let skip = 0; skip < 2; skip++) {
    let size = 0
    let shift = 0
    let byte: number
    do {
      byte = delta[position++] ?? 0
      size += (byte & 0x7f) * 2 ** shift
      shift += 7
    } while (byte & 0x80 && position < delta.length)
    if (skip === 1) return size
  }
  return Number.POSITIVE_INFINITY
}

export const registerPacks = async (storage: Storage, repo: RepositoryName, added: readonly string[]): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const stored = await getText(storage, packsKey(repo))
    const names = (stored?.text ?? '').split('\n').filter((line) => line.startsWith('P '))
    const missing = added.filter((name) => !names.includes(`P ${name}`))
    if (missing.length === 0) return
    const next = utf8(`${[...names, ...missing.map((name) => `P ${name}`)].join('\n')}\n\n`)
    const result = await storage.put(packsKey(repo), next, next.length, {
      contentType: 'text/plain',
      ...(stored ? { ifMatch: stored.etag } : { ifNoneMatch: '*' as const }),
    })
    if (result.ok) return
  }
  throw new Error('could not register pack')
}

export const isZero = (id: ObjectId): boolean => id === ZERO_ID
