import { concat, readAll } from './bytes.ts'
import { ByteLru } from './lru.ts'
import type { Storage } from './storage.ts'

export type PackSource = {
  readonly size: number
  read(offset: number, length: number): Promise<Uint8Array>
  stream(from: number, to: number): AsyncIterable<Uint8Array>
}

export const memorySource = (bytes: Uint8Array): PackSource => ({
  size: bytes.length,
  read: async (offset, length) => bytes.subarray(offset, Math.min(bytes.length, offset + length)),
  async *stream(from, to) {
    if (to > from) yield bytes.subarray(from, to)
  },
})

const STREAM_PIECE = 1024 * 1024

export const readStorageRange = async (storage: Storage, key: string, offset: number, length: number): Promise<Uint8Array> => {
  if (length <= 0) return new Uint8Array(0)
  const object = await storage.get(key, { offset, length })
  if (!object) throw new Error(`missing ${key}`)
  const bytes = await readAll(object.body)
  if (bytes.length !== length) throw new Error(`short read of ${key} at ${offset}: ${bytes.length} of ${length} bytes`)
  return bytes
}

export async function* streamStorageRange(storage: Storage, key: string, from: number, to: number): AsyncGenerator<Uint8Array> {
  if (to <= from) return
  const object = await storage.get(key, { offset: from, length: to - from })
  if (!object) throw new Error(`missing ${key}`)
  let seen = 0
  const reader = object.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      seen += value.length
      for (let offset = 0; offset < value.length; offset += STREAM_PIECE) yield value.subarray(offset, offset + STREAM_PIECE)
    }
  } finally {
    reader.releaseLock()
  }
  if (seen !== to - from) throw new Error(`short read of ${key}: ${seen} of ${to - from} bytes`)
}

export class BlockCache {
  readonly #read: (offset: number, length: number) => Promise<Uint8Array>
  readonly #size: number
  readonly #blockSize: number
  readonly #blocks: ByteLru<string, Uint8Array>
  readonly #prefix: string

  constructor(
    read: (offset: number, length: number) => Promise<Uint8Array>,
    size: number,
    blockSize: number,
    blocks: ByteLru<string, Uint8Array> | number,
    prefix = '',
  ) {
    this.#read = read
    this.#size = size
    this.#blockSize = blockSize
    this.#blocks = typeof blocks === 'number' ? new ByteLru(blocks) : blocks
    this.#prefix = prefix
  }

  async #block(index: number): Promise<Uint8Array> {
    const key = `${this.#prefix}${index}`
    const cached = this.#blocks.get(key)
    if (cached) return cached
    const offset = index * this.#blockSize
    const block = await this.#read(offset, Math.min(this.#blockSize, this.#size - offset))
    this.#blocks.set(key, block, block.length)
    return block
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const end = Math.min(this.#size, offset + length)
    if (end <= offset) return new Uint8Array(0)
    if (end - offset > this.#blockSize) return this.#read(offset, end - offset)
    const first = Math.floor(offset / this.#blockSize)
    const last = Math.floor((end - 1) / this.#blockSize)
    const parts: Uint8Array[] = []
    for (let index = first; index <= last; index++) {
      const block = await this.#block(index)
      const start = index === first ? offset - index * this.#blockSize : 0
      const stop = index === last ? end - index * this.#blockSize : block.length
      parts.push(block.subarray(start, stop))
    }
    return parts.length === 1 ? (parts[0] as Uint8Array) : concat(parts)
  }
}

export const storageSource = (storage: Storage, key: string, size: number, blockSize = 64 * 1024, budget = 4 * 1024 * 1024): PackSource => {
  const cache = new BlockCache((offset, length) => readStorageRange(storage, key, offset, length), size, blockSize, budget)
  return {
    size,
    read: (offset, length) => cache.read(offset, length),
    stream: (from, to) => streamStorageRange(storage, key, from, to),
  }
}

export class StagingWriter {
  readonly #storage: Storage
  readonly #prefix: string
  readonly #chunkSize: number
  #current: Uint8Array
  #filled = 0
  #flushed = 0
  readonly #pending: Uint8Array[] = []

  constructor(storage: Storage, prefix: string, chunkSize: number) {
    this.#storage = storage
    this.#prefix = prefix
    this.#chunkSize = chunkSize
    this.#current = new Uint8Array(chunkSize)
  }

  write(bytes: Uint8Array): void {
    let offset = 0
    while (offset < bytes.length) {
      if (this.#filled === this.#chunkSize) {
        this.#pending.push(this.#current)
        this.#current = new Uint8Array(this.#chunkSize)
        this.#filled = 0
      }
      const size = Math.min(bytes.length - offset, this.#chunkSize - this.#filled)
      this.#current.set(bytes.subarray(offset, offset + size), this.#filled)
      this.#filled += size
      offset += size
    }
  }

  async drain(): Promise<void> {
    while (this.#pending.length > 0) {
      const chunk = this.#pending.shift() as Uint8Array
      await this.#storage.put(`${this.#prefix}${this.#flushed}`, chunk, chunk.length, { contentType: 'application/octet-stream' })
      this.#flushed++
    }
  }

  async finish(): Promise<PackSource> {
    await this.drain()
    const tail = this.#current.subarray(0, this.#filled)
    if (this.#flushed === 0) return memorySource(tail)
    return stagedSource(this.#storage, this.#prefix, this.#chunkSize, this.#flushed, tail)
  }
}

const stagedSource = (storage: Storage, prefix: string, chunkSize: number, chunks: number, tail: Uint8Array): PackSource => {
  const size = chunks * chunkSize + tail.length
  const readDirect = async (offset: number, length: number): Promise<Uint8Array> => {
    const parts: Uint8Array[] = []
    let position = offset
    const end = Math.min(size, offset + length)
    while (position < end) {
      const chunk = Math.floor(position / chunkSize)
      const start = position - chunk * chunkSize
      const stop = Math.min(chunkSize, end - chunk * chunkSize)
      parts.push(chunk < chunks ? await readStorageRange(storage, `${prefix}${chunk}`, start, stop - start) : tail.subarray(start, stop))
      position = chunk * chunkSize + stop
    }
    return parts.length === 1 ? (parts[0] as Uint8Array) : concat(parts)
  }
  const cache = new BlockCache(readDirect, size, 256 * 1024, 4 * 1024 * 1024)
  return {
    size,
    read: (offset, length) => cache.read(offset, length),
    async *stream(from, to) {
      let position = from
      while (position < to) {
        const chunk = Math.floor(position / chunkSize)
        const start = position - chunk * chunkSize
        const stop = Math.min(chunkSize, to - chunk * chunkSize)
        if (chunk < chunks) yield* streamStorageRange(storage, `${prefix}${chunk}`, start, stop)
        else yield tail.subarray(start, stop)
        position = chunk * chunkSize + stop
      }
    },
  }
}
