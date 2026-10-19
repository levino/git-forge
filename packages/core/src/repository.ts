import { fromHex, fromUtf8, readAll, toHex, utf8 } from './bytes.ts'
import { ByteCursor } from './cursor.ts'
import { applyDelta, deltaResultSize } from './delta.ts'
import { type ObjectId, ZERO_ID } from './hash.ts'
import { ByteLru } from './lru.ts'
import { type GitObject, OFS_DELTA, type ObjectType, parseTag, REF_DELTA, typeFromCode } from './objects.ts'
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

export type MirrorView = {
  readonly remote: string
  readonly head?: string
}

export type RefsState = {
  readonly head: string
  readonly refs: Readonly<Record<string, ObjectId>>
  readonly mirrorView?: MirrorView
}

export type AdvertisedRefs = {
  readonly head: string
  readonly refs: Readonly<Record<string, ObjectId>>
}

const VIEWED = ['heads/', 'tags/']

export const mirrorViewRefs = (state: RefsState): Record<string, ObjectId> => {
  const view: Record<string, ObjectId> = {}
  if (!state.mirrorView) return view
  const prefix = `refs/upstream/${state.mirrorView.remote}/`
  for (const [name, id] of Object.entries(state.refs)) {
    if (!name.startsWith(prefix)) continue
    const rest = name.slice(prefix.length)
    if (!VIEWED.some((kind) => rest.startsWith(kind))) continue
    const virtual = `refs/${rest}`
    if (state.refs[virtual] === undefined) view[virtual] = id
  }
  return view
}

export const advertisedRefs = (state: RefsState): AdvertisedRefs => {
  if (!state.mirrorView) return { head: state.head, refs: state.refs }
  const refs = { ...state.refs, ...mirrorViewRefs(state) }
  const head = state.mirrorView.head !== undefined && refs[state.mirrorView.head] !== undefined ? state.mirrorView.head : state.head
  return { head, refs }
}

export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

export const isValidName = (value: string): boolean => NAME_PATTERN.test(value) && !value.endsWith('.git') && !value.includes('..')

export const repositoryPrefix = (repo: RepositoryName): string => `repos/${repo.owner}/${repo.name}/`

export const gitPrefix = (repo: RepositoryName): string => `${repositoryPrefix(repo)}git/`

const refsKey = (repo: RepositoryName) => `${repositoryPrefix(repo)}refs.json`
const packsKey = (repo: RepositoryName) => `${gitPrefix(repo)}objects/info/packs`
const infoRefsKey = (repo: RepositoryName) => `${gitPrefix(repo)}info/refs`
const headKey = (repo: RepositoryName) => `${gitPrefix(repo)}HEAD`
export const alternatesKey = (repo: RepositoryName) => `${gitPrefix(repo)}objects/info/alternates`
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

export const sortedRefs = (state: Pick<RefsState, 'refs'>): [string, ObjectId][] =>
  Object.entries(state.refs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

export const writeServerInfo = async (storage: Storage, repo: RepositoryName, stored: RefsState, odb: ObjectDatabase): Promise<void> => {
  const state = advertisedRefs(stored)
  const lines: string[] = []
  for (const [name, id] of sortedRefs(state)) {
    lines.push(`${id}\t${name}\n`)
    const peeled = await odb.peel(id)
    if (peeled !== id) lines.push(`${peeled}\t${name}^{}\n`)
  }
  await putText(storage, infoRefsKey(repo), lines.join(''))
  await putText(storage, headKey(repo), `ref: ${state.head}\n`)
}

const BLOB_CODE = 3

export type LoadedPack = {
  readonly name: string
  readonly key: string
  readonly repo: RepositoryName
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
  readonly maxObjectBytes?: number
  readonly onObject?: (id: ObjectId, type: ObjectType, data: Uint8Array) => void
}

export const stagingPrefix = (repo: RepositoryName, at = new Date()): string =>
  `tmp/${repositoryPrefix(repo)}${at.toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}/`

const parseInfoPacks = (text: string): string[] =>
  text
    .split('\n')
    .filter((line) => line.startsWith('P '))
    .map((line) => line.slice(2).trim())

const packNamesOf = async (storage: Storage, repo: RepositoryName): Promise<string[]> => parseInfoPacks((await getText(storage, packsKey(repo)))?.text ?? '')

export const formatInfoPacks = (names: readonly string[]): string => `${names.map((name) => `P ${name}`).join('\n')}\n\n`

export const MAX_ALTERNATE_DEPTH = 5

export const alternatePath = (target: RepositoryName): string => `../../../../${target.owner}/${target.name}/git/objects`

const ALTERNATE_LINE = /^\.\.\/\.\.\/\.\.\/\.\.\/([^/]+)\/([^/]+)\/git\/objects\/?$/

export const parseAlternates = (text: string): RepositoryName[] =>
  text
    .split('\n')
    .map((line) => ALTERNATE_LINE.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null && isValidName(match[1]!) && isValidName(match[2]!))
    .map((match) => ({ owner: match[1]!, name: match[2]! }))

export const writeAlternates = async (storage: Storage, repo: RepositoryName, targets: readonly RepositoryName[]): Promise<void> =>
  putText(storage, alternatesKey(repo), targets.map((target) => `${alternatePath(target)}\n`).join(''))

export const alternateRepositories = async (storage: Storage, repo: RepositoryName): Promise<RepositoryName[]> => {
  const key = (name: RepositoryName) => `${name.owner}/${name.name}`
  const seen = new Set([key(repo)])
  const order: RepositoryName[] = []
  let frontier = [repo]
  for (let depth = 0; depth < MAX_ALTERNATE_DEPTH && frontier.length > 0; depth++) {
    const next: RepositoryName[] = []
    for (const current of frontier) {
      const stored = await getText(storage, alternatesKey(current))
      for (const target of parseAlternates(stored?.text ?? '')) {
        if (seen.has(key(target))) continue
        seen.add(key(target))
        order.push(target)
        next.push(target)
      }
    }
    frontier = next
  }
  return order
}

const sameRepository = (a: RepositoryName, b: RepositoryName): boolean => a.owner === b.owner && a.name === b.name

export class ObjectDatabase {
  readonly #storage: Storage
  readonly #repo: RepositoryName
  readonly #options: ObjectDatabaseOptions
  #packs: LoadedPack[] | undefined
  readonly #indexes = new Map<string, PackIndex>()
  readonly #cache: ByteLru<string, GitObject>
  readonly #blocks: ByteLru<string, Uint8Array>

  constructor(storage: Storage, repo: RepositoryName, options: ObjectDatabaseOptions = {}) {
    this.#storage = storage
    this.#repo = repo
    this.#options = options
    this.#cache = new ByteLru(options.cacheBytes ?? 8 * 1024 * 1024)
    this.#blocks = new ByteLru(options.blockCacheBytes ?? 4 * 1024 * 1024)
  }

  get storage(): Storage {
    return this.#storage
  }

  get repo(): RepositoryName {
    return this.#repo
  }

  async packNames(): Promise<string[]> {
    return packNamesOf(this.#storage, this.#repo)
  }

  async #loadIndex(repo: RepositoryName, name: string): Promise<PackIndex> {
    const known = this.#indexes.get(name)
    if (known) return known
    const stored = await this.#storage.get(packKey(repo, name.replace(/\.pack$/, '.idx')))
    if (!stored) throw new Error(`missing index for ${name}`)
    const index = new PackIndex(await readAll(stored.body))
    this.#indexes.set(name, index)
    return index
  }

  async packs(): Promise<readonly LoadedPack[]> {
    if (this.#packs) return this.#packs
    const packs: LoadedPack[] = []
    const names = new Set<string>()
    for (const repo of [this.#repo, ...(await alternateRepositories(this.#storage, this.#repo))]) {
      for (const name of await packNamesOf(this.#storage, repo)) {
        if (names.has(name)) continue
        names.add(name)
        packs.push({ name, key: packKey(repo, name), repo, index: await this.#loadIndex(repo, name) })
      }
    }
    this.#packs = packs
    return packs
  }

  async borrows(): Promise<boolean> {
    return (await this.packs()).some((pack) => !sameRepository(pack.repo, this.#repo))
  }

  async ownPacks(): Promise<readonly LoadedPack[]> {
    return (await this.packs()).filter((pack) => sameRepository(pack.repo, this.#repo))
  }

  async smallBlobs(name: string, maxSize: number): Promise<{ readonly id: ObjectId; readonly data: Uint8Array }[]> {
    const pack = (await this.packs()).find((candidate) => candidate.name === name)
    if (!pack) throw new Error(`pack ${name} is not registered`)
    const blobs: { id: ObjectId; data: Uint8Array }[] = []
    for (const position of pack.index.positionsByOffset) {
      const data = await this.#smallBlobAt(pack, pack.index.offsetAt(position), maxSize)
      if (data) blobs.push({ id: pack.index.idAt(position), data })
    }
    return blobs
  }

  async smallBlob(id: ObjectId, maxSize: number): Promise<Uint8Array | null> {
    const location = await this.locate(id)
    return location ? this.#smallBlobAt(location.pack, location.offset, maxSize) : null
  }

  async #smallBlobAt(pack: LoadedPack, offset: number, maxSize: number): Promise<Uint8Array | null> {
    const header = readEntryHeader(await this.#range(pack, offset, 32), 0)
    let candidate = header.typeCode === BLOB_CODE && header.size <= maxSize
    if ((header.typeCode === OFS_DELTA || header.typeCode === REF_DELTA) && header.size <= 2 * maxSize + 64) {
      const raw = await this.readRaw(pack, offset)
      const start = header.headerLength + (header.typeCode === OFS_DELTA ? readOfsDeltaOffset(raw, header.headerLength).length : 20)
      candidate = deltaResultSize(inflateExact(raw.subarray(start), header.size)) <= maxSize
    }
    if (!candidate) return null
    const object = await this.#readAt(pack, offset)
    return object.type === 'blob' ? object.data : null
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
        this.#blocks,
        `${pack.name}:`,
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
      const bytes = utf8(formatInfoPacks(next))
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

  writePack(pack: IndexedPack): Promise<string | null> {
    return pack.finalize(this.#storage, (file) => packKey(this.#repo, file))
  }

  async storePack(pack: IndexedPack): Promise<string | null> {
    const name = await this.writePack(pack)
    if (name) await this.registerPack(name)
    return name
  }

  async ingest(
    stream: ReadableStream<Uint8Array>,
    options: IngestOptions & { readonly register?: boolean } = {},
  ): Promise<{ readonly name: string | null; readonly pack: IndexedPack }> {
    const { register = true, ...rest } = options
    const pack = await this.index(new ByteCursor(stream), rest)
    return { name: register ? await this.storePack(pack) : await this.writePack(pack), pack }
  }
}

export const registerPacks = async (storage: Storage, repo: RepositoryName, added: readonly string[]): Promise<void> => {
  await new ObjectDatabase(storage, repo).updatePackList((names) => [...names, ...added.filter((name) => !names.includes(name))])
}

export const isZero = (id: ObjectId): boolean => id === ZERO_ID
