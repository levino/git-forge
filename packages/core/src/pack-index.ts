import { compareBytes, concat, equalBytes, fromHex, readUint32, toHex, uint32 } from './bytes.ts'
import { createSha1, type ObjectId } from './hash.ts'

export type IndexEntry = {
  readonly id: ObjectId
  readonly offset: number
  readonly crc32: number
}

const MAGIC = new Uint8Array([0xff, 0x74, 0x4f, 0x63])
const LARGE = 0x80000000

export const writeIndex = (entries: readonly IndexEntry[], packChecksum: Uint8Array): Uint8Array => {
  const sorted = entries
    .map((entry) => ({ ...entry, raw: fromHex(entry.id) }))
    .sort((a, b) => compareBytes(a.raw, b.raw))
  const fanout = new Uint32Array(256)
  for (const entry of sorted) fanout[entry.raw[0] as number] = (fanout[entry.raw[0] as number] as number) + 1
  for (let i = 1; i < 256; i++) fanout[i] = (fanout[i] as number) + (fanout[i - 1] as number)
  const large: number[] = []
  const offsets = sorted.map((entry) => {
    if (entry.offset < LARGE) return uint32(entry.offset)
    large.push(entry.offset)
    return uint32((LARGE | (large.length - 1)) >>> 0)
  })
  const largeBytes = large.map((offset) => concat([uint32(Math.floor(offset / 2 ** 32)), uint32(offset >>> 0)]))
  const body = concat([
    MAGIC,
    uint32(2),
    ...Array.from(fanout, (count) => uint32(count)),
    ...sorted.map((entry) => entry.raw),
    ...sorted.map((entry) => uint32(entry.crc32)),
    ...offsets,
    ...largeBytes,
    packChecksum,
  ])
  const hash = createSha1()
  hash.update(body)
  return concat([body, hash.digest()])
}

export class PackIndex {
  readonly #bytes: Uint8Array
  readonly count: number
  readonly packChecksum: Uint8Array

  constructor(bytes: Uint8Array) {
    if (bytes.length < 8 + 1024 + 40 || !equalBytes(bytes.subarray(0, 4), MAGIC) || readUint32(bytes, 4) !== 2) {
      throw new Error('unsupported pack index')
    }
    this.#bytes = bytes
    this.count = readUint32(bytes, 8 + 255 * 4)
    this.packChecksum = bytes.subarray(bytes.length - 40, bytes.length - 20)
  }

  #idAt(position: number): Uint8Array {
    const start = 8 + 1024 + position * 20
    return this.#bytes.subarray(start, start + 20)
  }

  #offsetAt(position: number): number {
    const table = 8 + 1024 + this.count * 24
    const value = readUint32(this.#bytes, table + position * 4)
    if ((value & LARGE) === 0) return value
    const largeTable = table + this.count * 4
    const index = value & 0x7fffffff
    return readUint32(this.#bytes, largeTable + index * 8) * 2 ** 32 + readUint32(this.#bytes, largeTable + index * 8 + 4)
  }

  find(id: ObjectId): number | null {
    const raw = fromHex(id)
    const first = raw[0] as number
    let low = first === 0 ? 0 : readUint32(this.#bytes, 8 + (first - 1) * 4)
    let high = readUint32(this.#bytes, 8 + first * 4)
    while (low < high) {
      const middle = (low + high) >>> 1
      const order = compareBytes(this.#idAt(middle), raw)
      if (order === 0) return this.#offsetAt(middle)
      if (order < 0) low = middle + 1
      else high = middle
    }
    return null
  }

  *entries(): Generator<{ id: ObjectId; offset: number }> {
    for (let i = 0; i < this.count; i++) yield { id: toHex(this.#idAt(i)), offset: this.#offsetAt(i) }
  }
}
