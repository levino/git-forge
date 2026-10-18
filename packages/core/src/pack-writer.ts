import { concat, fromHex, toHex, uint32, utf8 } from './bytes.ts'
import { ByteCursor } from './cursor.ts'
import { createSha1, crc32, type ObjectId } from './hash.ts'
import { ID_BYTES } from './id-table.ts'
import { OFS_DELTA, PACK_TYPE_CODES, REF_DELTA } from './objects.ts'
import { encodeEntryHeader, readEntryHeader, readOfsDeltaOffset } from './pack.ts'
import { streamFrom } from './pack-indexer.ts'
import { streamStorageRange } from './pack-source.ts'
import type { LoadedPack, ObjectDatabase } from './repository.ts'
import { deflate } from './zlib.ts'

export const packHeader = (count: number): Uint8Array => concat([utf8('PACK'), uint32(2), uint32(count)])

export const encodeOfsDistance = (distance: number): Uint8Array => {
  const bytes = [distance & 0x7f]
  let rest = Math.floor(distance / 128)
  while (rest > 0) {
    rest -= 1
    bytes.unshift(0x80 | (rest & 0x7f))
    rest = Math.floor(rest / 128)
  }
  return new Uint8Array(bytes)
}

export async function* withTrailer(source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  const hash = createSha1()
  for await (const chunk of source) {
    hash.update(chunk)
    yield chunk
  }
  yield hash.digest()
}

export const emptyPack = (): Uint8Array => {
  const header = packHeader(0)
  const hash = createSha1()
  hash.update(header)
  return concat([header, hash.digest()])
}

export type ConcatenationPlan = {
  readonly packs: readonly LoadedPack[]
  readonly count: number
  readonly dropped: number
  readonly drop: readonly Uint8Array[]
}

export const planConcatenation = (packs: readonly LoadedPack[]): ConcatenationPlan => {
  let count = 0
  let dropped = 0
  const drop = packs.map((pack, p) => {
    const flags = new Uint8Array(pack.index.count)
    for (let position = 0; position < pack.index.count; position++) {
      const raw = pack.index.idBytesAt(position)
      let duplicate = position > 0 && toHex(pack.index.idBytesAt(position - 1)) === toHex(raw)
      for (let earlier = 0; earlier < p && !duplicate; earlier++) {
        duplicate = (packs[earlier] as LoadedPack).index.positionOfBytes(raw) !== -1
      }
      if (duplicate) {
        flags[position] = 1
        dropped++
      } else count++
    }
    return flags
  })
  return { packs, count, dropped, drop }
}

export type ConcatenatedEntry = {
  readonly id: Uint8Array
  readonly offset: number
  readonly crc: number
}

export async function* concatenatePacks(
  odb: ObjectDatabase,
  plan: ConcatenationPlan,
  onEntry?: (entry: ConcatenatedEntry) => void,
): AsyncGenerator<Uint8Array> {
  yield packHeader(plan.count)
  let written = 12
  const newOffsets = plan.packs.map((pack) => new Float64Array(pack.index.count).fill(Number.NaN))
  const winnerOffset = (raw: Uint8Array, before: number): number => {
    for (let p = 0; p <= before; p++) {
      const pack = plan.packs[p] as LoadedPack
      const position = pack.index.positionOfBytes(raw)
      if (position === -1 || (plan.drop[p] as Uint8Array)[position] !== 0) continue
      const offset = (newOffsets[p] as Float64Array)[position] as number
      if (!Number.isNaN(offset)) return offset
    }
    throw new Error(`no surviving copy of ${toHex(raw)}`)
  }
  for (const [p, pack] of plan.packs.entries()) {
    const size = await odb.packSize(pack)
    const drop = plan.drop[p] as Uint8Array
    const order = pack.index.positionsByOffset
    const cursor = new ByteCursor(streamFrom(streamStorageRange(odb.storage, pack.key, 12, size - 20)))
    for (let rank = 0; rank < order.length; rank++) {
      const position = order[rank] as number
      const offset = pack.index.offsetAt(position)
      const end = rank + 1 < order.length ? pack.index.offsetAt(order[rank + 1] as number) : size - 20
      const length = end - offset
      if (drop[position]) {
        for await (const _ of cursor.take(length)) void _
        continue
      }
      await cursor.fill(Math.min(length, 32))
      const head = cursor.peek()
      const header = readEntryHeader(head, 0)
      let rewritten: Uint8Array | null = null
      let skip = 0
      if (header.typeCode === OFS_DELTA) {
        const ofs = readOfsDeltaOffset(head, header.headerLength)
        const basePosition = pack.index.positionAtOffset(offset - ofs.distance)
        if (basePosition === -1) throw new Error(`ofs-delta base missing in ${pack.name}`)
        const baseOffset = drop[basePosition]
          ? winnerOffset(pack.index.idBytesAt(basePosition), p)
          : ((newOffsets[p] as Float64Array)[basePosition] as number)
        if (Number.isNaN(baseOffset)) throw new Error(`ofs-delta base not yet written in ${pack.name}`)
        const distance = written - baseOffset
        if (distance !== ofs.distance) {
          rewritten = concat([head.slice(0, header.headerLength), encodeOfsDistance(distance)])
          skip = header.headerLength + ofs.length
        }
      }
      ;(newOffsets[p] as Float64Array)[position] = written
      if (rewritten) {
        cursor.skip(skip)
        let crc = crc32(rewritten)
        yield rewritten
        for await (const chunk of cursor.take(length - skip)) {
          crc = crc32(chunk, crc)
          yield chunk
        }
        onEntry?.({ id: pack.index.idBytesAt(position), offset: written, crc })
        written += rewritten.length + length - skip
      } else {
        for await (const chunk of cursor.take(length)) yield chunk
        onEntry?.({ id: pack.index.idBytesAt(position), offset: written, crc: pack.index.crcAt(position) })
        written += length
      }
    }
    await cursor.cancel()
  }
}

export async function* storedPacks(odb: ObjectDatabase, packs: readonly LoadedPack[]): AsyncGenerator<Uint8Array> {
  if (packs.length === 1) {
    const pack = packs[0] as LoadedPack
    yield* streamStorageRange(odb.storage, pack.key, 0, await odb.packSize(pack))
    return
  }
  yield* withTrailer(concatenatePacks(odb, planConcatenation(packs)))
}

export type GenerateOptions = {
  readonly sending: ReadonlySet<ObjectId>
  readonly clientHas?: ReadonlySet<ObjectId>
}

export async function* generatePack(odb: ObjectDatabase, ids: readonly ObjectId[], options: GenerateOptions): AsyncGenerator<Uint8Array> {
  yield packHeader(ids.length)
  for (const id of ids) {
    const location = await odb.locate(id)
    if (!location) throw new Error(`missing object ${id}`)
    const raw = await odb.readRaw(location.pack, location.offset)
    const header = readEntryHeader(raw, 0)
    if (header.typeCode !== OFS_DELTA && header.typeCode !== REF_DELTA) {
      yield raw
      continue
    }
    let baseId: ObjectId
    let dataStart: number
    if (header.typeCode === OFS_DELTA) {
      const ofs = readOfsDeltaOffset(raw, header.headerLength)
      const basePosition = location.pack.index.positionAtOffset(location.offset - ofs.distance)
      if (basePosition === -1) throw new Error(`ofs-delta base missing in ${location.pack.name}`)
      baseId = location.pack.index.idAt(basePosition)
      dataStart = header.headerLength + ofs.length
    } else {
      baseId = toHex(raw.subarray(header.headerLength, header.headerLength + ID_BYTES))
      dataStart = header.headerLength + ID_BYTES
    }
    if (options.sending.has(baseId) || options.clientHas?.has(baseId)) {
      yield concat([encodeEntryHeader(REF_DELTA, header.size), fromHex(baseId), raw.subarray(dataStart)])
      continue
    }
    const object = await odb.read(id)
    if (!object) throw new Error(`missing object ${id}`)
    yield concat([encodeEntryHeader(PACK_TYPE_CODES[object.type], object.data.length), deflate(object.data)])
  }
}

const FRAME = 65520

export async function* sidebandFrames(channel: number, source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  let frame = new Uint8Array(FRAME)
  let filled = 5
  const emit = (): Uint8Array => {
    const out = frame.subarray(0, filled)
    out.set(utf8(filled.toString(16).padStart(4, '0')), 0)
    out[4] = channel
    frame = new Uint8Array(FRAME)
    filled = 5
    return out
  }
  for await (const chunk of source) {
    let offset = 0
    while (offset < chunk.length) {
      const size = Math.min(chunk.length - offset, FRAME - filled)
      frame.set(chunk.subarray(offset, offset + size), filled)
      filled += size
      offset += size
      if (filled === FRAME) yield emit()
    }
  }
  if (filled > 5) yield emit()
}
