import { concat, uint32, utf8 } from './bytes.ts'
import { crc32, createSha1, hashObject, type ObjectId } from './hash.ts'
import { type GitObject, PACK_TYPE_CODES } from './objects.ts'
import { deflate } from './zlib.ts'

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

export type ResolvedObject = GitObject & {
  readonly id: ObjectId
  readonly offset: number
  readonly crc32: number
}

export class PackError extends Error {}

export const encodeEntryHeader = (typeCode: number, size: number): Uint8Array => {
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

