import { concat, equalBytes, fromUtf8, readUint32, toHex, uint32, utf8 } from './bytes.ts'
import { applyDelta } from './delta.ts'
import { crc32, createSha1, hashObject, type ObjectId } from './hash.ts'
import { type GitObject, OFS_DELTA, PACK_TYPE_CODES, REF_DELTA, typeFromCode } from './objects.ts'
import { deflate, inflateAt } from './zlib.ts'

export type PackEntryHeader = {
  readonly typeCode: number
  readonly size: number
  readonly headerLength: number
}

export const readEntryHeader = (bytes: Uint8Array, offset: number): PackEntryHeader => {
  let byte = bytes[offset] as number
  if (byte === undefined) throw new Error('truncated pack entry')
  const typeCode = (byte >> 4) & 0x07
  let size = byte & 0x0f
  let shift = 4
  let position = offset + 1
  while (byte & 0x80) {
    byte = bytes[position++] as number
    if (byte === undefined) throw new Error('truncated pack entry')
    size += (byte & 0x7f) * 2 ** shift
    shift += 7
  }
  return { typeCode, size, headerLength: position - offset }
}

export const readOfsDeltaOffset = (bytes: Uint8Array, start: number): { distance: number; length: number } => {
  let position = start
  let byte = bytes[position++] as number
  let distance = byte & 0x7f
  while (byte & 0x80) {
    byte = bytes[position++] as number
    if (byte === undefined) throw new Error('truncated ofs-delta')
    distance = (distance + 1) * 128 + (byte & 0x7f)
  }
  return { distance, length: position - start }
}

type RawEntry = {
  readonly offset: number
  readonly end: number
  readonly typeCode: number
  readonly payload: Uint8Array
  readonly baseOffset?: number
  readonly baseId?: ObjectId
}

export type ResolvedObject = GitObject & {
  readonly id: ObjectId
  readonly offset: number
  readonly crc32: number
}

export type ExternalLookup = (id: ObjectId) => Promise<GitObject | null>

export type ParsedPack = {
  readonly objects: readonly ResolvedObject[]
  readonly checksum: Uint8Array
  readonly externalBases: readonly ObjectId[]
}

export class PackError extends Error {}

export const scanPack = (bytes: Uint8Array): { entries: RawEntry[]; checksum: Uint8Array } => {
  if (bytes.length < 32 || fromUtf8(bytes.subarray(0, 4)) !== 'PACK') throw new PackError('not a pack file')
  const version = readUint32(bytes, 4)
  if (version !== 2 && version !== 3) throw new PackError(`unsupported pack version ${version}`)
  const count = readUint32(bytes, 8)
  const entries: RawEntry[] = []
  let offset = 12
  for (let i = 0; i < count; i++) {
    const header = readEntryHeader(bytes, offset)
    let position = offset + header.headerLength
    let baseOffset: number | undefined
    let baseId: ObjectId | undefined
    if (header.typeCode === OFS_DELTA) {
      const ofs = readOfsDeltaOffset(bytes, position)
      baseOffset = offset - ofs.distance
      if (baseOffset < 12) throw new PackError('ofs-delta base out of range')
      position += ofs.length
    } else if (header.typeCode === REF_DELTA) {
      baseId = toHex(bytes.subarray(position, position + 20))
      position += 20
    } else {
      typeFromCode(header.typeCode)
    }
    const inflated = inflateAt(bytes, position)
    if (inflated.data.length !== header.size) throw new PackError('pack entry size mismatch')
    const end = position + inflated.consumed
    entries.push({
      offset,
      end,
      typeCode: header.typeCode,
      payload: inflated.data,
      ...(baseOffset !== undefined ? { baseOffset } : {}),
      ...(baseId !== undefined ? { baseId } : {}),
    })
    offset = end
  }
  if (offset + 20 !== bytes.length) throw new PackError('unexpected data after pack entries')
  const hash = createSha1()
  hash.update(bytes.subarray(0, offset))
  const checksum = bytes.subarray(offset, offset + 20)
  if (!equalBytes(hash.digest(), checksum)) throw new PackError('pack checksum mismatch')
  return { entries, checksum: checksum.slice() }
}

export const parsePack = async (bytes: Uint8Array, lookup: ExternalLookup): Promise<ParsedPack> => {
  const { entries, checksum } = scanPack(bytes)
  const byOffset = new Map<number, GitObject>()
  const byId = new Map<ObjectId, GitObject>()
  const ids = new Map<number, ObjectId>()
  const externalBases = new Set<ObjectId>()
  const record = (entry: RawEntry, object: GitObject) => {
    const id = hashObject(object.type, object.data)
    byOffset.set(entry.offset, object)
    byId.set(id, object)
    ids.set(entry.offset, id)
  }
  for (const entry of entries) {
    if (entry.typeCode !== OFS_DELTA && entry.typeCode !== REF_DELTA) {
      record(entry, { type: typeFromCode(entry.typeCode), data: entry.payload })
    }
  }
  let pending = entries.filter((entry) => !byOffset.has(entry.offset))
  while (pending.length > 0) {
    const waiting: RawEntry[] = []
    for (const entry of pending) {
      const base = entry.baseOffset !== undefined ? byOffset.get(entry.baseOffset) : byId.get(entry.baseId as ObjectId)
      if (base) record(entry, { type: base.type, data: applyDelta(base.data, entry.payload) })
      else waiting.push(entry)
    }
    if (waiting.length === pending.length) {
      let progressed = false
      for (const entry of waiting) {
        if (entry.baseId === undefined || byId.has(entry.baseId)) continue
        const external = await lookup(entry.baseId)
        if (!external) continue
        byId.set(entry.baseId, external)
        externalBases.add(entry.baseId)
        progressed = true
      }
      if (!progressed) throw new PackError('unresolvable delta base')
    }
    pending = waiting
  }
  const objects = entries.map((entry) => {
    const object = byOffset.get(entry.offset) as GitObject
    return {
      ...object,
      id: ids.get(entry.offset) as ObjectId,
      offset: entry.offset,
      crc32: crc32(bytes.subarray(entry.offset, entry.end)),
    }
  })
  return { objects, checksum, externalBases: [...externalBases] }
}

const encodeEntryHeader = (typeCode: number, size: number): Uint8Array => {
  const out: number[] = []
  let byte = (typeCode << 4) | (size & 0x0f)
  let rest = Math.floor(size / 16)
  while (rest > 0) {
    out.push(byte | 0x80)
    byte = rest & 0x7f
    rest = Math.floor(rest / 128)
  }
  out.push(byte)
  return new Uint8Array(out)
}

export type WrittenPack = {
  readonly bytes: Uint8Array
  readonly objects: readonly ResolvedObject[]
  readonly checksum: Uint8Array
}

export const writePack = (objects: readonly (GitObject & { readonly id?: ObjectId })[]): WrittenPack => {
  const parts: Uint8Array[] = [utf8('PACK'), uint32(2), uint32(objects.length)]
  let offset = 12
  const written: ResolvedObject[] = []
  for (const object of objects) {
    const entry = concat([encodeEntryHeader(PACK_TYPE_CODES[object.type], object.data.length), deflate(object.data)])
    written.push({
      type: object.type,
      data: object.data,
      id: object.id ?? hashObject(object.type, object.data),
      offset,
      crc32: crc32(entry),
    })
    parts.push(entry)
    offset += entry.length
  }
  const body = concat(parts)
  const hash = createSha1()
  hash.update(body)
  const checksum = hash.digest()
  return { bytes: concat([body, checksum]), objects: written, checksum }
}

