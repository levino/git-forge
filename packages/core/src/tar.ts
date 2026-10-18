import { ByteCursor } from './cursor.ts'

const BLOCK = 512

const decoder = new TextDecoder()

export type TarEntryType = 'file' | 'directory' | 'symlink' | 'other'

export type TarEntry = {
  readonly path: string
  readonly type: TarEntryType
  readonly size: number
  readonly linkName: string
  readonly body: AsyncIterable<Uint8Array>
}

export class TarFormatError extends Error {}

const text = (block: Uint8Array, offset: number, length: number): string => {
  const slice = block.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return decoder.decode(end === -1 ? slice : slice.subarray(0, end))
}

const numeric = (block: Uint8Array, offset: number, length: number): number => {
  if ((block[offset]! & 0x80) !== 0) {
    let value = 0
    for (let i = offset + 1; i < offset + length; i++) value = value * 256 + block[i]!
    return value
  }
  const digits = text(block, offset, length).trim()
  if (digits === '') return 0
  if (!/^[0-7]+$/.test(digits)) throw new TarFormatError(`invalid octal field ${JSON.stringify(digits)}`)
  return parseInt(digits, 8)
}

const checksumMatches = (block: Uint8Array): boolean => {
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!
  return sum === numeric(block, 148, 8)
}

const isZeroBlock = (block: Uint8Array): boolean => block.every((byte) => byte === 0)

const parsePax = (data: Uint8Array): Map<string, string> => {
  const records = new Map<string, string>()
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number(decoder.decode(data.subarray(offset, space)))
    if (!Number.isSafeInteger(length) || length <= 0) throw new TarFormatError('invalid PAX record')
    const record = decoder.decode(data.subarray(space + 1, offset + length - 1))
    const equals = record.indexOf('=')
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1))
    offset += length
  }
  return records
}

const padding = (size: number): number => (BLOCK - (size % BLOCK)) % BLOCK

const typeOf = (flag: string): TarEntryType => {
  if (flag === '0' || flag === '\0' || flag === '' || flag === '7') return 'file'
  if (flag === '5') return 'directory'
  if (flag === '2') return 'symlink'
  return 'other'
}

export const MAX_TAR_METADATA_BYTES = 1024 * 1024

export async function* readTar(stream: ReadableStream<Uint8Array>): AsyncGenerator<TarEntry> {
  const cursor = new ByteCursor(stream)
  let pax = new Map<string, string>()
  let longName: string | null = null
  let longLink: string | null = null
  try {
    for (;;) {
      if (await cursor.atEnd()) return
      const block = await cursor.read(BLOCK)
      if (isZeroBlock(block)) return
      if (!checksumMatches(block)) throw new TarFormatError('tar header checksum mismatch')
      const flag = String.fromCharCode(block[156]!)
      const headerSize = numeric(block, 124, 12)
      if (flag === 'x' || flag === 'g' || flag === 'L' || flag === 'K') {
        if (headerSize > MAX_TAR_METADATA_BYTES) throw new TarFormatError('tar metadata entry too large')
        const data = await cursor.read(headerSize)
        await cursor.read(padding(headerSize))
        if (flag === 'x') pax = parsePax(data)
        else if (flag === 'L') longName = text(data, 0, data.length)
        else if (flag === 'K') longLink = text(data, 0, data.length)
        continue
      }
      const magic = text(block, 257, 6)
      const prefix = magic.startsWith('ustar') ? text(block, 345, 155) : ''
      const name = text(block, 0, 100)
      const path = pax.get('path') ?? longName ?? (prefix ? `${prefix}/${name}` : name)
      const linkName = pax.get('linkpath') ?? longLink ?? text(block, 157, 100)
      const paxSize = pax.get('size')
      const size = paxSize !== undefined ? Number(paxSize) : headerSize
      if (!Number.isSafeInteger(size) || size < 0) throw new TarFormatError('invalid entry size')
      pax = new Map()
      longName = null
      longLink = null
      let drained = false
      const body: AsyncIterable<Uint8Array> = {
        async *[Symbol.asyncIterator]() {
          if (drained) throw new TarFormatError('tar entry body read twice')
          drained = true
          yield* cursor.take(size)
        },
      }
      yield { path, type: typeOf(flag), size, linkName, body }
      if (!drained) {
        drained = true
        for await (const _ of cursor.take(size));
      }
      await cursor.read(padding(size))
    }
  } finally {
    await cursor.cancel()
  }
}

export const maybeGunzip = async (stream: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> => {
  const reader = stream.getReader()
  const first = await reader.read()
  const head = first.done ? new Uint8Array(0) : first.value
  const replay = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.length > 0) controller.enqueue(head)
    },
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) controller.close()
      else controller.enqueue(value)
    },
    cancel: (reason) => reader.cancel(reason),
  })
  return head[0] === 0x1f && head[1] === 0x8b ? replay.pipeThrough(new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>) : replay
}
