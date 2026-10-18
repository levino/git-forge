import { concat, fromHex, fromUtf8, readUint32, SizeLimitError, toHex, uint32, utf8 } from './bytes.ts'
import type { ByteCursor } from './cursor.ts'
import { applyDelta, deltaResultSize } from './delta.ts'
import { crc32, createSha1, hashObject, type ObjectId } from './hash.ts'
import { ID_BYTES, IdIndex, IdSet } from './id-table.ts'
import { LFS_POINTER_MAX_SIZE, type LfsObjectSpec, parseLfsPointer } from './lfs.ts'
import { type GitObject, OFS_DELTA, type ObjectType, PACK_TYPE_CODES, parseCommit, parseTag, REF_DELTA, typeFromCode } from './objects.ts'
import { encodeEntryHeader, PackError, readEntryHeader, readOfsDeltaOffset } from './pack.ts'
import { writeIndexColumns } from './pack-index.ts'
import { StagingWriter } from './pack-source.ts'
import type { Storage } from './storage.ts'
import { deflate, inflateExact } from './zlib.ts'
import { ByteLru } from './lru.ts'

export type ObjectLookup = {
  read(id: ObjectId): Promise<GitObject | null>
  has(id: ObjectId): Promise<boolean>
}

export type IndexPackOptions = {
  readonly storage: Storage
  readonly stagingPrefix: string
  readonly objects: ObjectLookup
  readonly checkReferences?: boolean
  readonly memoryBudget?: number
  readonly chunkSize?: number
  readonly maxObjectBytes?: number
  readonly onObject?: (id: ObjectId, type: ObjectType, data: Uint8Array) => void
}

export const DEFAULT_MAX_OBJECT_BYTES = 64 * 1024 * 1024
export const DEFAULT_MEMORY_BUDGET = 16 * 1024 * 1024
export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024

class Entries {
  count = 0
  offsets = new Float64Array(1024)
  headerLengths = new Uint8Array(1024)
  kinds = new Uint8Array(1024)
  types = new Uint8Array(1024)
  sizes = new Float64Array(1024)
  bases = new Int32Array(1024)
  crcs = new Uint32Array(1024)
  ids = new Uint8Array(1024 * ID_BYTES)

  add(offset: number, headerLength: number, kind: number, size: number, base: number): number {
    if (this.count === this.offsets.length) this.#grow()
    const index = this.count++
    this.offsets[index] = offset
    this.headerLengths[index] = headerLength
    this.kinds[index] = kind
    this.sizes[index] = size
    this.bases[index] = base
    return index
  }

  #grow(): void {
    const capacity = this.offsets.length * 2
    const grow = <T extends Float64Array | Uint8Array | Int32Array | Uint32Array>(old: T, make: (n: number) => T, factor = 1): T => {
      const next = make(capacity * factor)
      next.set(old as never)
      return next
    }
    this.offsets = grow(this.offsets, (n) => new Float64Array(n))
    this.headerLengths = grow(this.headerLengths, (n) => new Uint8Array(n))
    this.kinds = grow(this.kinds, (n) => new Uint8Array(n))
    this.types = grow(this.types, (n) => new Uint8Array(n))
    this.sizes = grow(this.sizes, (n) => new Float64Array(n))
    this.bases = grow(this.bases, (n) => new Int32Array(n))
    this.crcs = grow(this.crcs, (n) => new Uint32Array(n))
    this.ids = grow(this.ids, (n) => new Uint8Array(n), ID_BYTES)
  }

  indexOfOffset(offset: number): number {
    let low = 0
    let high = this.count
    while (low < high) {
      const middle = (low + high) >>> 1
      const value = this.offsets[middle] as number
      if (value === offset) return middle
      if (value < offset) low = middle + 1
      else high = middle
    }
    return -1
  }
}

const isGitlink = (data: Uint8Array, start: number, space: number): boolean =>
  space - start === 6 && data[start] === 0x31 && data[start + 1] === 0x36 && data[start + 2] === 0x30 && data[start + 3] === 0x30 && data[start + 4] === 0x30 && data[start + 5] === 0x30

export const forEachTreeEntryId = (data: Uint8Array, visit: (bytes: Uint8Array, offset: number) => void): void => {
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    const nul = space === -1 ? -1 : data.indexOf(0x00, space)
    if (space === -1 || nul === -1 || nul + 21 > data.length) throw new PackError('invalid tree')
    if (!isGitlink(data, offset, space)) visit(data, nul + 1)
    offset = nul + 21
  }
}

type Appended = { readonly id: Uint8Array; readonly type: ObjectType; readonly length: number; readonly crc: number; bytes: Uint8Array | null }

export type IndexedPack = {
  readonly objectCount: number
  readonly byteLength: number
  readonly checksum: Uint8Array
  readonly lfsPointers: readonly LfsObjectSpec[]
  readonly thinBases: number
  readonly deferred: number
  typeOf(id: ObjectId): ObjectType | null
  read(id: ObjectId): Promise<GitObject | null>
  finalize(storage: Storage, packKey: (name: string) => string): Promise<string | null>
}

export const indexPack = async (cursor: ByteCursor, options: IndexPackOptions): Promise<IndexedPack> => {
  const budget = options.memoryBudget ?? DEFAULT_MEMORY_BUDGET
  const keepLimit = Math.max(LFS_POINTER_MAX_SIZE, Math.floor(budget / 16))
  const checkReferences = options.checkReferences ?? true
  const maxObject = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES
  const tooLarge = (size: number): PackError =>
    new PackError(`object of ${size} bytes is too large to resolve in memory (limit ${maxObject}); store large files in Git LFS`)
  const entries = new Entries()
  const idIndex = new IdIndex(() => entries.ids)
  const cache = new ByteLru<number, Uint8Array>(budget)
  const pending = new IdSet()
  const refBases = new Map<number, Uint8Array>()
  const lfs = new Map<string, LfsObjectSpec>()
  const sink = new StagingWriter(options.storage, options.stagingPrefix, options.chunkSize ?? DEFAULT_CHUNK_SIZE)
  const packHash = createSha1()
  const scratch = new Uint8Array(64 * 1024)
  let hashing = true
  let crc = 0

  cursor.onConsume = (bytes) => {
    if (hashing) packHash.update(bytes)
    crc = crc32(bytes, crc)
    sink.write(bytes)
  }
  cursor.beforeRead = () => sink.drain()

  const resolved = (index: number, typeCode: number, id: Uint8Array, data: Uint8Array | null): void => {
    entries.types[index] = typeCode
    entries.ids.set(id, index * ID_BYTES)
    idIndex.add(index)
    if (!data) return
    options.onObject?.(toHex(id), typeFromCode(typeCode), data)
    if (data.length <= keepLimit) cache.set(index, data, data.length)
    if (typeCode === 3) {
      if (data.length <= LFS_POINTER_MAX_SIZE) {
        const pointer = parseLfsPointer(data)
        if (pointer) lfs.set(`${pointer.oid}:${pointer.size}`, pointer)
      }
      return
    }
    if (!checkReferences) return
    const note = (bytes: Uint8Array, offset: number) => {
      if (idIndex.getBytes(bytes, offset) === -1) pending.addBytes(bytes, offset)
    }
    if (typeCode === 2) forEachTreeEntryId(data, note)
    else if (typeCode === 1) {
      const commit = parseCommit(data)
      for (const id of [commit.tree, ...commit.parents]) note(fromHex(id), 0)
    } else if (typeCode === 4) note(fromHex(parseTag(data).object), 0)
  }

  const resolveWithData = (index: number, typeCode: number, data: Uint8Array): void => {
    resolved(index, typeCode, fromHex(hashObject(typeFromCode(typeCode), data)), data)
  }

  let count: number
  const start = cursor.offset
  let checksum = new Uint8Array(20)
  try {
    if ((await cursor.fill(12)) < 12) throw new PackError('not a pack file')
    const header = cursor.peek()
    if (fromUtf8(header.subarray(0, 4)) !== 'PACK') throw new PackError('not a pack file')
    const version = readUint32(header, 4)
    if (version !== 2 && version !== 3) throw new PackError(`unsupported pack version ${version}`)
    count = readUint32(header, 8)
    cursor.skip(12)

    for (let i = 0; i < count; i++) {
      const offset = cursor.offset - start
      crc = 0
      await cursor.fill(32)
      const head = cursor.peek()
      const entry = readEntryHeader(head, 0)
      let headerLength = entry.headerLength
      let base = -1
      let baseId: Uint8Array | null = null
      if (entry.typeCode === OFS_DELTA) {
        const ofs = readOfsDeltaOffset(head, headerLength)
        base = entries.indexOfOffset(offset - ofs.distance)
        if (base === -1) throw new PackError('ofs-delta base out of range')
        headerLength += ofs.length
      } else if (entry.typeCode === REF_DELTA) {
        if (head.length < headerLength + 20) throw new PackError('truncated pack entry')
        baseId = head.slice(headerLength, headerLength + 20)
        headerLength += 20
      } else {
        typeFromCode(entry.typeCode)
      }
      cursor.skip(headerLength)
      const index = entries.add(offset, headerLength, entry.typeCode, entry.size, base)
      if (baseId) refBases.set(index, baseId)
      if (entry.typeCode !== OFS_DELTA && entry.typeCode !== REF_DELTA) {
        const type = typeFromCode(entry.typeCode)
        if (entry.size <= keepLimit || entry.typeCode !== 3) {
          if (entry.size > maxObject) throw tooLarge(entry.size)
          const data = (await cursor.inflate(entry.size, { keep: true, scratch })) as Uint8Array
          resolveWithData(index, entry.typeCode, data)
        } else {
          const hash = createSha1()
          hash.update(utf8(`${type} ${entry.size}\0`))
          await cursor.inflate(entry.size, { sink: (chunk) => hash.update(chunk), scratch })
          resolved(index, entry.typeCode, hash.digest(), null)
        }
      } else {
        const baseIndex = baseId ? idIndex.getBytes(baseId) : base
        const baseData = baseIndex === -1 || entries.types[baseIndex] === 0 ? undefined : cache.get(baseIndex)
        if (baseData && entry.size <= budget / 2) {
          const delta = (await cursor.inflate(entry.size, { keep: true, scratch })) as Uint8Array
          if (deltaResultSize(delta) > maxObject) throw tooLarge(deltaResultSize(delta))
          resolveWithData(index, entries.types[baseIndex] as number, applyDelta(baseData, delta))
        } else {
          await cursor.inflate(entry.size, { scratch })
        }
      }
      entries.crcs[index] = crc
    }
    checksum = packHash.digest()
    hashing = false
    const trailer = await cursor.read(20)
    if (toHex(trailer) !== toHex(checksum)) throw new PackError('pack checksum mismatch')
    if (!(await cursor.atEnd())) throw new PackError('unexpected data after pack entries')
  } catch (error) {
    if (error instanceof PackError || error instanceof SizeLimitError) throw error
    throw new PackError((error as Error).message)
  } finally {
    cursor.onConsume = null
    cursor.beforeRead = null
  }
  const source = await sink.finish()
  const packEnd = source.size - 20
  const externals = new Map<string, ObjectType>()
  const discovered: Uint8Array[] = []

  const dataStart = (index: number) => (entries.offsets[index] as number) + (entries.headerLengths[index] as number)
  const entryEnd = (index: number) => (index + 1 < entries.count ? (entries.offsets[index + 1] as number) : packEnd)

  const external = async (id: Uint8Array): Promise<GitObject> => {
    const hex = toHex(id)
    const object = await options.objects.read(hex)
    if (!object) throw new PackError(`unresolvable delta base ${hex}`)
    if (!externals.has(hex)) {
      externals.set(hex, object.type)
      discovered.push(id)
    }
    return object
  }

  const materialize = async (index: number): Promise<Uint8Array> => {
    const cached = cache.get(index)
    if (cached) return cached
    const start = dataStart(index)
    if ((entries.sizes[index] as number) > maxObject) throw tooLarge(entries.sizes[index] as number)
    const raw = inflateExact(await source.read(start, entryEnd(index) - start), entries.sizes[index] as number)
    const kind = entries.kinds[index] as number
    if ((kind === OFS_DELTA || kind === REF_DELTA) && deltaResultSize(raw) > maxObject) throw tooLarge(deltaResultSize(raw))
    let data = raw
    if (kind === OFS_DELTA) data = applyDelta(await materialize(entries.bases[index] as number), raw)
    else if (kind === REF_DELTA) {
      const id = refBases.get(index) as Uint8Array
      const inPack = idIndex.getBytes(id)
      data = applyDelta(inPack === -1 ? (await external(id)).data : await materialize(inPack), raw)
    }
    cache.set(index, data, data.length)
    return data
  }

  let unresolved: number[] = []
  for (let i = 0; i < entries.count; i++) if (entries.types[i] === 0) unresolved.push(i)
  const deferred = unresolved.length
  while (unresolved.length > 0) {
    const waiting: number[] = []
    for (const index of unresolved) {
      const kind = entries.kinds[index] as number
      let baseType = 0
      if (kind === OFS_DELTA) baseType = entries.types[entries.bases[index] as number] as number
      else {
        const inPack = idIndex.getBytes(refBases.get(index) as Uint8Array)
        if (inPack !== -1) baseType = entries.types[inPack] as number
        else {
          const type = externals.get(toHex(refBases.get(index) as Uint8Array))
          if (type) baseType = PACK_TYPE_CODES[type]
        }
      }
      if (baseType === 0) {
        waiting.push(index)
        continue
      }
      resolveWithData(index, baseType, await materialize(index))
    }
    if (waiting.length === unresolved.length) {
      let progressed = false
      for (const index of waiting) {
        if (entries.kinds[index] !== REF_DELTA) continue
        const id = refBases.get(index) as Uint8Array
        if (idIndex.getBytes(id) !== -1 || externals.has(toHex(id))) continue
        const object = await options.objects.read(toHex(id))
        if (!object) continue
        await external(id)
        progressed = true
      }
      if (!progressed) throw new PackError('unresolvable delta base')
    }
    unresolved = waiting
  }

  if (checkReferences) {
    for (const id of pending.values()) {
      if (idIndex.get(id) !== -1 || externals.has(id)) continue
      if (!(await options.objects.has(id))) throw new PackError(`missing object ${id}`)
    }
  }

  const read = async (id: ObjectId): Promise<GitObject | null> => {
    const index = idIndex.get(id)
    if (index === -1) return null
    return { type: typeFromCode(entries.types[index] as number), data: await materialize(index) }
  }

  const finalize = async (storage: Storage, packKey: (name: string) => string): Promise<string | null> => {
    if (entries.count === 0) return null
    const thin = discovered.filter((id) => idIndex.getBytes(id) === -1)
    if (thin.length === 0) {
      const name = `pack-${toHex(checksum)}.pack`
      await storage.put(packKey(name), streamFrom(source.stream(0, source.size)), source.size, { contentType: 'application/x-git-packed-objects' })
      const index = writeIndexColumns(
        { count: entries.count, ids: entries.ids, offsets: entries.offsets, crcs: entries.crcs },
        checksum,
      )
      await storage.put(packKey(name.replace(/\.pack$/, '.idx')), index, index.length, { contentType: 'application/x-git-packed-objects-toc' })
      return name
    }
    const appended: Appended[] = []
    let appendedBytes = 0
    let keptBytes = 0
    const appendedEntry = async (id: Uint8Array): Promise<Uint8Array> => {
      const object = await external(id)
      return concat([encodeEntryHeader(PACK_TYPE_CODES[object.type], object.data.length), deflate(object.data)])
    }
    for (const id of thin) {
      const bytes = await appendedEntry(id)
      const keep = keptBytes + bytes.length <= budget / 4
      if (keep) keptBytes += bytes.length
      appended.push({ id, type: externals.get(toHex(id)) as ObjectType, length: bytes.length, crc: crc32(bytes), bytes: keep ? bytes : null })
      appendedBytes += bytes.length
    }
    const total = entries.count + appended.length
    const size = source.size + appendedBytes
    async function* content(): AsyncGenerator<Uint8Array> {
      yield concat([utf8('PACK'), uint32(2), uint32(total)])
      yield* source.stream(12, packEnd)
      for (const entry of appended) yield entry.bytes ?? (await appendedEntry(entry.id))
    }
    const hash = createSha1()
    for await (const piece of content()) hash.update(piece)
    const newChecksum = hash.digest()
    const name = `pack-${toHex(newChecksum)}.pack`
    async function* withTrailer(): AsyncGenerator<Uint8Array> {
      yield* content()
      yield newChecksum
    }
    await storage.put(packKey(name), streamFrom(withTrailer()), size, { contentType: 'application/x-git-packed-objects' })
    const ids = new Uint8Array(total * ID_BYTES)
    ids.set(entries.ids.subarray(0, entries.count * ID_BYTES))
    const offsets = new Float64Array(total)
    offsets.set(entries.offsets.subarray(0, entries.count))
    const crcs = new Uint32Array(total)
    crcs.set(entries.crcs.subarray(0, entries.count))
    let position = packEnd
    appended.forEach((entry, i) => {
      ids.set(entry.id, (entries.count + i) * ID_BYTES)
      offsets[entries.count + i] = position
      crcs[entries.count + i] = entry.crc
      position += entry.length
    })
    const index = writeIndexColumns({ count: total, ids, offsets, crcs }, newChecksum)
    await storage.put(packKey(name.replace(/\.pack$/, '.idx')), index, index.length, { contentType: 'application/x-git-packed-objects-toc' })
    return name
  }

  return {
    objectCount: entries.count,
    byteLength: source.size,
    checksum,
    lfsPointers: [...lfs.values()],
    thinBases: discovered.filter((id) => idIndex.getBytes(id) === -1).length,
    deferred,
    typeOf: (id) => {
      const index = idIndex.get(id)
      return index === -1 ? null : typeFromCode(entries.types[index] as number)
    },
    read,
    finalize,
  }
}

export const streamFrom = (source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> => {
  const iterator = source[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next()
        if (done) controller.close()
        else controller.enqueue(value)
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel(reason) {
      await iterator.return?.(reason)
    },
  })
}
