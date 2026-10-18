import { equalBytes, readAll, readUint32, streamOf, uint32, utf8 } from '@git-forge/core'

export const MAGIC = utf8('GFBACKUP')

export const SEAL_VERSION = 1

export const DEFAULT_SEGMENT_SIZE = 64 * 1024

const TAG = 16

const SALT = 16

const OBJECT_INFO = utf8('git-forge backup object v1')

export class BackupIntegrityError extends Error {}

export type RunKeys = (run: string) => Promise<CryptoKey>

const buffer = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes)

const RUN_PATTERN = /^[A-Za-z0-9._-]{1,200}$/

export const segmentCount = (size: number, segment: number): number => Math.max(1, Math.ceil(size / segment))

export const headerLength = (run: string): number => MAGIC.length + 2 + run.length + 4 + 8 + SALT

export const sealedSize = (size: number, run: string, segment = DEFAULT_SEGMENT_SIZE): number =>
  headerLength(run) + size + TAG * segmentCount(size, segment)

const encodeHeader = (run: string, segment: number, size: number, salt: Uint8Array): Uint8Array => {
  if (!RUN_PATTERN.test(run)) throw new Error(`invalid run id ${run}`)
  const header = new Uint8Array(headerLength(run))
  header.set(MAGIC, 0)
  let at = MAGIC.length
  header[at++] = SEAL_VERSION
  header[at++] = run.length
  header.set(utf8(run), at)
  at += run.length
  header.set(uint32(segment), at)
  header.set(uint32(Math.floor(size / 2 ** 32)), at + 4)
  header.set(uint32(size % 2 ** 32), at + 8)
  header.set(salt, at + 12)
  return header
}

type Header = { readonly run: string; readonly segment: number; readonly size: number; readonly salt: Uint8Array; readonly bytes: Uint8Array }

const decodeHeader = (bytes: Uint8Array): Header | 'incomplete' => {
  if (bytes.length < MAGIC.length + 2) return 'incomplete'
  if (!equalBytes(bytes.subarray(0, MAGIC.length), MAGIC)) throw new BackupIntegrityError('not a git-forge backup object')
  if (bytes[MAGIC.length] !== SEAL_VERSION) throw new BackupIntegrityError(`unsupported backup object version ${bytes[MAGIC.length]}`)
  const runLength = bytes[MAGIC.length + 1] as number
  const total = MAGIC.length + 2 + runLength + 4 + 8 + SALT
  if (bytes.length < total) return 'incomplete'
  let at = MAGIC.length + 2
  const run = String.fromCharCode(...bytes.subarray(at, at + runLength))
  if (!RUN_PATTERN.test(run)) throw new BackupIntegrityError('invalid run id in backup object')
  at += runLength
  const segment = readUint32(bytes, at)
  const size = readUint32(bytes, at + 4) * 2 ** 32 + readUint32(bytes, at + 8)
  if (segment === 0 || !Number.isSafeInteger(size)) throw new BackupIntegrityError('invalid backup object header')
  return { run, segment, size, salt: bytes.slice(at + 12, at + 12 + SALT), bytes: bytes.slice(0, total) }
}

const objectKey = async (runKey: CryptoKey, salt: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> =>
  crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: buffer(salt), info: buffer(OBJECT_INFO) }, runKey, { name: 'AES-GCM', length: 256 }, false, [usage])

const nonce = (index: number, last: boolean): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(12)
  bytes.set(uint32(Math.floor(index / 2 ** 32)), 3)
  bytes.set(uint32(index % 2 ** 32), 7)
  bytes[11] = last ? 1 : 0
  return bytes
}

class Collector {
  readonly #target: Uint8Array
  #filled = 0

  constructor(size: number) {
    this.#target = new Uint8Array(size)
  }

  get filled(): number {
    return this.#filled
  }

  get full(): boolean {
    return this.#filled === this.#target.length
  }

  take(chunk: Uint8Array): Uint8Array {
    const count = Math.min(chunk.length, this.#target.length - this.#filled)
    this.#target.set(chunk.subarray(0, count), this.#filled)
    this.#filled += count
    return chunk.subarray(count)
  }

  drain(): Uint8Array {
    const bytes = this.#target.slice(0, this.#filled)
    this.#filled = 0
    return bytes
  }
}

export type SealOptions = {
  readonly run: string
  readonly runKey: CryptoKey
  readonly size: number
  readonly segment?: number
}

export const sealStream = (options: SealOptions): TransformStream<Uint8Array, Uint8Array> => {
  const segment = options.segment ?? DEFAULT_SEGMENT_SIZE
  const salt = crypto.getRandomValues(new Uint8Array(SALT))
  const header = encodeHeader(options.run, segment, options.size, salt)
  const last = segmentCount(options.size, segment) - 1
  const pending = new Collector(segment)
  let key: CryptoKey | undefined
  let index = 0
  let seen = 0
  const encrypt = async (plain: Uint8Array, final: boolean): Promise<Uint8Array> => {
    key ??= await objectKey(options.runKey, salt, 'encrypt')
    const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce(index, final), additionalData: buffer(header) }, key, buffer(plain))
    index++
    return new Uint8Array(sealed)
  }
  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      controller.enqueue(header)
    },
    async transform(chunk, controller) {
      seen += chunk.length
      if (seen > options.size) throw new BackupIntegrityError(`input exceeds the declared ${options.size} bytes`)
      let rest = chunk
      while (rest.length > 0) {
        rest = pending.take(rest)
        if (pending.full && index < last) controller.enqueue(await encrypt(pending.drain(), false))
      }
    },
    async flush(controller) {
      if (seen !== options.size) throw new BackupIntegrityError(`input has ${seen} bytes, declared ${options.size}`)
      controller.enqueue(await encrypt(pending.drain(), true))
    },
  })
}

export const openStream = (keys: RunKeys): TransformStream<Uint8Array, Uint8Array> => {
  let headerBytes: Uint8Array = new Uint8Array(0)
  let header: Header | undefined
  let key: CryptoKey | undefined
  let pending: Collector | undefined
  let index = 0
  let last = 0
  let produced = 0
  const decrypt = async (sealed: Uint8Array, final: boolean): Promise<Uint8Array> => {
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce(index, final), additionalData: buffer(header!.bytes) }, key!, buffer(sealed))
      index++
      return new Uint8Array(plain)
    } catch {
      throw new BackupIntegrityError(`segment ${index} failed authentication`)
    }
  }
  const lastSealedSize = () => header!.size - last * header!.segment + TAG
  const consume = async (input: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) => {
    let rest = input
    if (!header) {
      const combined = new Uint8Array(headerBytes.length + rest.length)
      combined.set(headerBytes)
      combined.set(rest, headerBytes.length)
      const decoded = decodeHeader(combined)
      if (decoded === 'incomplete') {
        headerBytes = combined
        return
      }
      header = decoded
      last = segmentCount(header.size, header.segment) - 1
      key = await objectKey(await keys(header.run), header.salt, 'decrypt')
      pending = new Collector(last === 0 ? lastSealedSize() : header.segment + TAG)
      rest = combined.subarray(header.bytes.length)
    }
    while (rest.length > 0) {
      if (index > last) throw new BackupIntegrityError('data after the final segment')
      rest = pending!.take(rest)
      if (!pending!.full) continue
      const final = index === last
      const plain = await decrypt(pending!.drain(), final)
      produced += plain.length
      if (plain.length > 0) controller.enqueue(plain)
      if (index === last) pending = new Collector(lastSealedSize())
    }
  }
  return new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      await consume(chunk, controller)
    },
    flush() {
      if (!header) throw new BackupIntegrityError('truncated backup object header')
      if (index !== last + 1 || produced !== header.size) throw new BackupIntegrityError('truncated backup object')
    },
  })
}

export const sealBytes = async (bytes: Uint8Array, options: Omit<SealOptions, 'size'>): Promise<Uint8Array> =>
  readAll(streamOf(bytes).pipeThrough(sealStream({ ...options, size: bytes.length })))

export const openBytes = async (bytes: Uint8Array, keys: RunKeys): Promise<Uint8Array> => readAll(streamOf(bytes).pipeThrough(openStream(keys)))

export const sealedRun = (head: Uint8Array): string | null => {
  try {
    const decoded = decodeHeader(head)
    return decoded === 'incomplete' ? null : decoded.run
  } catch {
    return null
  }
}
