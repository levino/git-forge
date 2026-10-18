import { equalBytes, fromHex, readUint32, toHex } from './bytes.ts'
import { createSha1, type ObjectId } from './hash.ts'
import { ID_BYTES } from './id-table.ts'

export type IndexEntry = {
  readonly id: ObjectId
  readonly offset: number
  readonly crc32: number
}

export type IndexColumns = {
  readonly count: number
  readonly ids: Uint8Array
  readonly offsets: Float64Array
  readonly crcs: Uint32Array
}

const MAGIC = new Uint8Array([0xff, 0x74, 0x4f, 0x63])
const LARGE = 0x80000000

export const compareIds = (ids: Uint8Array, a: number, b: number): number => {
  const aStart = a * ID_BYTES
  const bStart = b * ID_BYTES
  for (let i = 0; i < ID_BYTES; i++) {
    const diff = (ids[aStart + i] as number) - (ids[bStart + i] as number)
    if (diff !== 0) return diff
  }
  return 0
}

export const sortedOrder = (ids: Uint8Array, count: number): Uint32Array => {
  const order = new Uint32Array(count)
  for (let i = 0; i < count; i++) order[i] = i
  return order.sort((a, b) => compareIds(ids, a, b))
}

const writeUint32 = (out: Uint8Array, offset: number, value: number): void => {
  out[offset] = (value >>> 24) & 0xff
  out[offset + 1] = (value >>> 16) & 0xff
  out[offset + 2] = (value >>> 8) & 0xff
  out[offset + 3] = value & 0xff
}

export const writeIndexColumns = (columns: IndexColumns, packChecksum: Uint8Array): Uint8Array => {
  const { count, ids, offsets, crcs } = columns
  const order = sortedOrder(ids, count)
  let large = 0
  for (let i = 0; i < count; i++) if ((offsets[i] as number) >= LARGE) large++
  const out = new Uint8Array(8 + 1024 + count * 28 + large * 8 + 40)
  out.set(MAGIC, 0)
  writeUint32(out, 4, 2)
  const fanout = new Uint32Array(256)
  for (let i = 0; i < count; i++) {
    const first = ids[(order[i] as number) * ID_BYTES] as number
    fanout[first] = (fanout[first] as number) + 1
  }
  let running = 0
  for (let i = 0; i < 256; i++) {
    running += fanout[i] as number
    writeUint32(out, 8 + i * 4, running)
  }
  const idTable = 8 + 1024
  const crcTable = idTable + count * 20
  const offsetTable = crcTable + count * 4
  const largeTable = offsetTable + count * 4
  let largeIndex = 0
  for (let i = 0; i < count; i++) {
    const entry = order[i] as number
    out.set(ids.subarray(entry * ID_BYTES, (entry + 1) * ID_BYTES), idTable + i * 20)
    writeUint32(out, crcTable + i * 4, crcs[entry] as number)
    const offset = offsets[entry] as number
    if (offset < LARGE) {
      writeUint32(out, offsetTable + i * 4, offset)
    } else {
      writeUint32(out, offsetTable + i * 4, (LARGE | largeIndex) >>> 0)
      writeUint32(out, largeTable + largeIndex * 8, Math.floor(offset / 2 ** 32))
      writeUint32(out, largeTable + largeIndex * 8 + 4, offset >>> 0)
      largeIndex++
    }
  }
  out.set(packChecksum, out.length - 40)
  const hash = createSha1()
  hash.update(out.subarray(0, out.length - 20))
  out.set(hash.digest(), out.length - 20)
  return out
}

export const writeIndex = (entries: readonly IndexEntry[], packChecksum: Uint8Array): Uint8Array => {
  const ids = new Uint8Array(entries.length * ID_BYTES)
  const offsets = new Float64Array(entries.length)
  const crcs = new Uint32Array(entries.length)
  entries.forEach((entry, i) => {
    ids.set(fromHex(entry.id), i * ID_BYTES)
    offsets[i] = entry.offset
    crcs[i] = entry.crc32
  })
  return writeIndexColumns({ count: entries.length, ids, offsets, crcs }, packChecksum)
}

export class PackIndex {
  readonly #bytes: Uint8Array
  readonly count: number
  readonly packChecksum: Uint8Array
  #byOffset: Uint32Array | undefined
  #sortedOffsets: Float64Array | undefined

  constructor(bytes: Uint8Array) {
    if (bytes.length < 8 + 1024 + 40 || !equalBytes(bytes.subarray(0, 4), MAGIC) || readUint32(bytes, 4) !== 2) {
      throw new Error('unsupported pack index')
    }
    this.#bytes = bytes
    this.count = readUint32(bytes, 8 + 255 * 4)
    this.packChecksum = bytes.subarray(bytes.length - 40, bytes.length - 20)
  }

  get byteLength(): number {
    return this.#bytes.length
  }

  idBytesAt(position: number): Uint8Array {
    const start = 8 + 1024 + position * 20
    return this.#bytes.subarray(start, start + 20)
  }

  idAt(position: number): ObjectId {
    return toHex(this.idBytesAt(position))
  }

  crcAt(position: number): number {
    return readUint32(this.#bytes, 8 + 1024 + this.count * 20 + position * 4)
  }

  offsetAt(position: number): number {
    const table = 8 + 1024 + this.count * 24
    const value = readUint32(this.#bytes, table + position * 4)
    if ((value & LARGE) === 0) return value
    const largeTable = table + this.count * 4
    const index = value & 0x7fffffff
    return readUint32(this.#bytes, largeTable + index * 8) * 2 ** 32 + readUint32(this.#bytes, largeTable + index * 8 + 4)
  }

  positionOfBytes(raw: Uint8Array, rawOffset = 0): number {
    const first = raw[rawOffset] as number
    let low = first === 0 ? 0 : readUint32(this.#bytes, 8 + (first - 1) * 4)
    let high = readUint32(this.#bytes, 8 + first * 4)
    const table = 8 + 1024
    while (low < high) {
      const middle = (low + high) >>> 1
      const start = table + middle * 20
      let order = 0
      for (let i = 0; i < 20 && order === 0; i++) order = (this.#bytes[start + i] as number) - (raw[rawOffset + i] as number)
      if (order === 0) return middle
      if (order < 0) low = middle + 1
      else high = middle
    }
    return -1
  }

  position(id: ObjectId): number {
    return this.positionOfBytes(fromHex(id))
  }

  find(id: ObjectId): number | null {
    const position = this.position(id)
    return position === -1 ? null : this.offsetAt(position)
  }

  #offsetOrder(): { byOffset: Uint32Array; sortedOffsets: Float64Array } {
    if (!this.#byOffset || !this.#sortedOffsets) {
      const offsets = new Float64Array(this.count)
      for (let i = 0; i < this.count; i++) offsets[i] = this.offsetAt(i)
      const byOffset = new Uint32Array(this.count)
      for (let i = 0; i < this.count; i++) byOffset[i] = i
      byOffset.sort((a, b) => (offsets[a] as number) - (offsets[b] as number))
      const sortedOffsets = new Float64Array(this.count)
      for (let i = 0; i < this.count; i++) sortedOffsets[i] = offsets[byOffset[i] as number] as number
      this.#byOffset = byOffset
      this.#sortedOffsets = sortedOffsets
    }
    return { byOffset: this.#byOffset, sortedOffsets: this.#sortedOffsets }
  }

  get positionsByOffset(): Uint32Array {
    return this.#offsetOrder().byOffset
  }

  #rankOf(offset: number): number {
    const { sortedOffsets } = this.#offsetOrder()
    let low = 0
    let high = this.count
    while (low < high) {
      const middle = (low + high) >>> 1
      if ((sortedOffsets[middle] as number) < offset) low = middle + 1
      else high = middle
    }
    return low
  }

  positionAtOffset(offset: number): number {
    const { byOffset, sortedOffsets } = this.#offsetOrder()
    const rank = this.#rankOf(offset)
    return rank < this.count && sortedOffsets[rank] === offset ? (byOffset[rank] as number) : -1
  }

  nextOffset(offset: number): number | null {
    const { sortedOffsets } = this.#offsetOrder()
    const rank = this.#rankOf(offset + 1)
    return rank < this.count ? (sortedOffsets[rank] as number) : null
  }

  *entries(): Generator<{ id: ObjectId; offset: number }> {
    for (let i = 0; i < this.count; i++) yield { id: this.idAt(i), offset: this.offsetAt(i) }
  }
}
