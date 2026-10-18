import { fromHex, fromUtf8, readAll, toHex, utf8 } from './bytes.ts'
import { ByteCursor } from './cursor.ts'
import { applyDelta } from './delta.ts'
import { type ObjectId, ZERO_ID } from './hash.ts'
import { ByteLru } from './lru.ts'
import { type GitObject, OFS_DELTA, parseTag, REF_DELTA, typeFromCode } from './objects.ts'
import { readEntryHeader, readOfsDeltaOffset } from './pack.ts'
import { PackIndex } from './pack-index.ts'
import { type IndexedPack, indexPack } from './pack-indexer.ts'
import { BlockCache, readStorageRange } from './pack-source.ts'
import type { Storage } from './storage.ts'
import { inflateExact } from './zlib.ts'

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

export type LoadedPack = {
  readonly name: string
  readonly key: string
  readonly index: PackIndex
  size?: number
  blocks?: BlockCache
}

export type ObjectDatabaseOptions = {
  readonly cacheBytes?: number
  readonly blockSize?: number
  readonly blockCacheBytes?: number
}

export type IngestOptions = {
  readonly checkReferences?: boolean
  readonly memoryBudget?: number
  readonly chunkSize?: number
}

export const stagingPrefix = (repo: RepositoryName, at = new Date()): string =>
  `tmp/${repositoryPrefix(repo)}${at.toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}/`

const parseInfoPacks = (text: string): string[] =>
  text
    .split('\n')
    .filter((line) => line.startsWith('P '))
    .map((line) => line.slice(2).trim())

export class ObjectDatabase {
  readonly #storage: Storage
  readonly #repo: RepositoryName
  readonly #options: ObjectDatabaseOptions
  #packs: LoadedPack[] | undefined
  readonly #indexes = new Map<string, PackIndex>()
  readonly #cache: ByteLru<string, GitObject>

  constructor(storage: Storage, repo: RepositoryName, options: ObjectDatabaseOptions = {}) {
    this.#storage = storage
    this.#repo = repo
    this.#options = options
    this.#cache = new ByteLru(options.cacheBytes ?? 16 * 1024 * 1024)
  }

  get storage(): Storage {
    return this.#storage
  }

  get repo(): RepositoryName {
    return this.#repo
  }

  async packNames(): Promise<string[]> {
    const stored = await getText(this.#storage, packsKey(this.#repo))
    return parseInfoPacks(stored?.text ?? '')
  }

  async #loadIndex(name: string): Promise<PackIndex> {
    const known = this.#indexes.get(name)
    if (known) return known
    const stored = await this.#storage.get(packKey(this.#repo, name.replace(/\.pack$/, '.idx')))
    if (!stored) throw new Error(`missing index for ${name}`)
    const index = new PackIndex(await readAll(stored.body))
    this.#indexes.set(name, index)
    return index
  }

  async packs(): Promise<readonly LoadedPack[]> {
    if (this.#packs) return this.#packs
    const packs: LoadedPack[] = []
    for (const name of await this.packNames()) packs.push({ name, key: packKey(this.#repo, name), index: await this.#loadIndex(name) })
    this.#packs = packs
    return packs
  }

  invalidate(): void {
    this.#packs = undefined
  }

  async packSize(pack: LoadedPack): Promise<number> {
    if (pack.size === undefined) {
      const info = await this.#storage.head(pack.key)
      if (!info) throw new Error(`missing pack ${pack.name}`)
      pack.size = info.size
    }
    return pack.size
  }

  async #range(pack: LoadedPack, offset: number, length: number): Promise<Uint8Array> {
    if (!pack.blocks) {
      const size = await this.packSize(pack)
      pack.blocks = new BlockCache(
        (from, count) => readStorageRange(this.#storage, pack.key, from, count),
        size,
        this.#options.blockSize ?? 64 * 1024,
        this.#options.blockCacheBytes ?? 2 * 1024 * 1024,
      )
    }
    return pack.blocks.read(offset, length)
  }

  async entryEnd(pack: LoadedPack, offset: number): Promise<number> {
    return pack.index.nextOffset(offset) ?? (await this.packSize(pack)) - 20
  }

  async readRaw(pack: LoadedPack, offset: number): Promise<Uint8Array> {
    return this.#range(pack, offset, (await this.entryEnd(pack, offset)) - offset)
  }

  async #readAt(pack: LoadedPack, offset: number): Promise<GitObject> {
    const key = `${pack.name}:${offset}`
    const cached = this.#cache.get(key)
    if (cached) return cached
    const raw = await this.readRaw(pack, offset)
    const header = readEntryHeader(raw, 0)
    let position = header.headerLength
    let object: GitObject
    if (header.typeCode === OFS_DELTA) {
      const ofs = readOfsDeltaOffset(raw, position)
      position += ofs.length
      const base = await this.#readAt(pack, offset - ofs.distance)
      object = { type: base.type, data: applyDelta(base.data, inflateExact(raw.subarray(position), header.size)) }
    } else if (header.typeCode === REF_DELTA) {
      const baseId = toHex(raw.subarray(position, position + 20))
      position += 20
      const base = await this.read(baseId)
      if (!base) throw new Error(`missing delta base ${baseId}`)
      object = { type: base.type, data: applyDelta(base.data, inflateExact(raw.subarray(position), header.size)) }
    } else {
      object = { type: typeFromCode(header.typeCode), data: inflateExact(raw.subarray(position), header.size) }
    }
    this.#cache.set(key, object, object.data.length)
    return object
  }

  async locate(id: ObjectId): Promise<{ readonly pack: LoadedPack; readonly offset: number } | null> {
    const raw = fromHex(id)
    for (const pack of await this.packs()) {
      const position = pack.index.positionOfBytes(raw)
      if (position !== -1) return { pack, offset: pack.index.offsetAt(position) }
    }
    return null
  }

  async read(id: ObjectId): Promise<GitObject | null> {
    const location = await this.locate(id)
    return location ? this.#readAt(location.pack, location.offset) : null
  }

  async has(id: ObjectId): Promise<boolean> {
    return (await this.locate(id)) !== null
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

  async updatePackList(change: (names: readonly string[]) => readonly string[] | null): Promise<boolean> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const stored = await getText(this.#storage, packsKey(this.#repo))
      const names = parseInfoPacks(stored?.text ?? '')
      const next = change(names)
      if (next === null) return false
      if (next.length === names.length && next.every((name, i) => name === names[i])) return true
      const bytes = utf8(`${next.map((name) => `P ${name}`).join('\n')}\n\n`)
      const result = await this.#storage.put(packsKey(this.#repo), bytes, bytes.length, {
        contentType: 'text/plain',
        ...(stored ? { ifMatch: stored.etag } : { ifNoneMatch: '*' as const }),
      })
      if (result.ok) {
        this.invalidate()
        return true
      }
    }
    throw new Error('could not update the pack list')
  }

  async registerPack(name: string): Promise<void> {
    await this.updatePackList((names) => (names.includes(name) ? names : [...names, name]))
  }

  async index(cursor: ByteCursor, options: IngestOptions = {}): Promise<IndexedPack> {
    return indexPack(cursor, {
      storage: this.#storage,
      stagingPrefix: stagingPrefix(this.#repo),
      objects: this,
      ...options,
    })
  }

  async storePack(pack: IndexedPack): Promise<string | null> {
    const name = await pack.finalize(this.#storage, (file) => packKey(this.#repo, file))
    if (name) await this.registerPack(name)
    return name
  }

  async ingest(stream: ReadableStream<Uint8Array>, options: IngestOptions = {}): Promise<{ readonly name: string | null; readonly pack: IndexedPack }> {
    const pack = await this.index(new ByteCursor(stream), options)
    return { name: await this.storePack(pack), pack }
  }
}

export const isZero = (id: ObjectId): boolean => id === ZERO_ID
