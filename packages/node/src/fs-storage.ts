import type { ByteRange, ObjectInfo, PutBody, PutOptions, PutResult, Storage, StoredObject } from '@git-forge/core'
import { createHash, randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { type FileHandle, mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type FsStorageOptions = {
  readonly lockTimeoutMs?: number
  readonly staleLockMs?: number
  readonly readChunkBytes?: number
}

export const FS_STORAGE_RESERVED = '.git-forge'

const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined

const ignoreMissing = (error: unknown): null => {
  if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return null
  throw error
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const validKey = (key: string): boolean =>
  key.length > 0 &&
  !key.includes('\\') &&
  !key.includes('\0') &&
  key.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..') &&
  key !== FS_STORAGE_RESERVED &&
  !key.startsWith(`${FS_STORAGE_RESERVED}/`)

const assertKey = (key: string): void => {
  if (!validKey(key)) throw new Error(`invalid storage key: ${JSON.stringify(key)}`)
}

const etagOf = (stats: BigIntStats): string =>
  [stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].map((value) => value.toString(16)).join('-')

const infoOf = async (handle: FileHandle, key: string): Promise<ObjectInfo> => {
  const stats = await handle.stat({ bigint: true })
  return { key, size: Number(stats.size), etag: etagOf(stats) }
}

const emptyStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    },
  })

const fileStream = (handle: FileHandle, start: number, end: number, chunk: number): ReadableStream<Uint8Array> => {
  let position = start
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const length = Math.min(chunk, end - position)
        const buffer = new Uint8Array(Math.max(length, 0))
        const { bytesRead } = length > 0 ? await handle.read(buffer, 0, length, position) : { bytesRead: 0 }
        if (bytesRead === 0) {
          await handle.close()
          controller.close()
          return
        }
        position += bytesRead
        controller.enqueue(buffer.subarray(0, bytesRead))
      } catch (error) {
        await handle.close().catch(() => undefined)
        controller.error(error)
      }
    },
    async cancel() {
      await handle.close()
    },
  })
}

const writeBody = async (path: string, body: PutBody, size: number): Promise<void> => {
  const handle = await open(path, 'wx')
  try {
    if (body instanceof Uint8Array) {
      await handle.write(body)
    } else {
      let written = 0
      const reader = body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          written += value.length
          if (written > size) throw new Error(`size mismatch: more than ${size} bytes`)
          await handle.write(value)
        }
      } catch (error) {
        await reader.cancel(error).catch(() => undefined)
        throw error
      }
      if (written !== size) throw new Error(`size mismatch: expected ${size}, got ${written}`)
    }
    await handle.datasync()
  } finally {
    await handle.close()
  }
}

export class FsStorage implements Storage {
  readonly #root: string
  readonly #tmp: string
  readonly #locks: string
  readonly #lockTimeoutMs: number
  readonly #staleLockMs: number
  readonly #chunk: number

  constructor(root: string, options: FsStorageOptions = {}) {
    this.#root = root
    this.#tmp = join(root, FS_STORAGE_RESERVED, 'tmp')
    this.#locks = join(root, FS_STORAGE_RESERVED, 'locks')
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 10_000
    this.#staleLockMs = options.staleLockMs ?? 30_000
    this.#chunk = options.readChunkBytes ?? 256 * 1024
  }

  #path(key: string): string {
    return join(this.#root, ...key.split('/'))
  }

  async get(key: string, range?: ByteRange): Promise<StoredObject | null> {
    assertKey(key)
    const handle = await open(this.#path(key), 'r').catch(ignoreMissing)
    if (!handle) return null
    try {
      const info = await infoOf(handle, key)
      const start = range ? Math.min(range.offset, info.size) : 0
      const end = range ? Math.min(range.offset + Math.max(range.length, 0), info.size) : info.size
      if (end <= start) {
        await handle.close()
        return { ...info, body: emptyStream() }
      }
      return { ...info, body: fileStream(handle, start, end, this.#chunk) }
    } catch (error) {
      await handle.close().catch(() => undefined)
      if (errorCode(error) === 'EISDIR') return null
      throw error
    }
  }

  async head(key: string): Promise<ObjectInfo | null> {
    assertKey(key)
    const stats = await stat(this.#path(key), { bigint: true }).catch(ignoreMissing)
    return stats?.isFile() ? { key, size: Number(stats.size), etag: etagOf(stats) } : null
  }

  async put(key: string, body: PutBody, size: number, options: PutOptions = {}): Promise<PutResult> {
    assertKey(key)
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`invalid size for ${key}: ${size}`)
    if (body instanceof Uint8Array && body.length !== size) throw new Error(`size mismatch for ${key}: expected ${size}, got ${body.length}`)
    await mkdir(this.#tmp, { recursive: true })
    const tmp = join(this.#tmp, randomUUID())
    let renamed = false
    try {
      await writeBody(tmp, body, size)
      const target = this.#path(key)
      await mkdir(dirname(target), { recursive: true })
      const release = await this.#lock(key)
      try {
        const current = await this.head(key)
        if (options.ifNoneMatch === '*' && current) return { ok: false, reason: 'precondition-failed' }
        if (options.ifMatch !== undefined && current?.etag !== options.ifMatch) return { ok: false, reason: 'precondition-failed' }
        await rename(tmp, target)
        renamed = true
      } finally {
        await release()
      }
      const info = await this.head(key)
      if (!info) throw new Error(`object ${key} missing after write`)
      return { ok: true, info }
    } finally {
      if (!renamed) await unlink(tmp).catch(() => undefined)
    }
  }

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    const cut = prefix.lastIndexOf('/') + 1
    const directory = prefix.slice(0, cut)
    if (directory !== '' && !validKey(directory.slice(0, -1))) return
    yield* this.#walk(directory === '' ? this.#root : this.#path(directory.slice(0, -1)), directory, prefix)
  }

  async *#walk(directory: string, keyPrefix: string, prefix: string): AsyncGenerator<ObjectInfo> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(ignoreMissing)
    if (!entries) return
    const ordered = entries
      .filter((entry) => !(keyPrefix === '' && entry.name === FS_STORAGE_RESERVED))
      .map((entry) => ({ entry, order: entry.isDirectory() ? `${entry.name}/` : entry.name }))
      .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
    for (const { entry } of ordered) {
      const key = keyPrefix + entry.name
      if (entry.isDirectory()) {
        const nested = `${key}/`
        if (nested.startsWith(prefix) || prefix.startsWith(nested)) yield* this.#walk(join(directory, entry.name), nested, prefix)
      } else if (entry.isFile() && key.startsWith(prefix)) {
        const info = await this.head(key)
        if (info) yield info
      }
    }
  }

  async #lock(key: string): Promise<() => Promise<void>> {
    await mkdir(this.#locks, { recursive: true })
    const path = join(this.#locks, createHash('sha256').update(key).digest('hex'))
    const deadline = Date.now() + this.#lockTimeoutMs
    for (let attempt = 0; ; attempt++) {
      try {
        await (await open(path, 'wx')).close()
        return () => unlink(path).catch(() => undefined)
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error
      }
      const held = await stat(path).catch(ignoreMissing)
      if (held && Date.now() - held.mtimeMs > this.#staleLockMs) {
        await unlink(path).catch(() => undefined)
        continue
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for the lock on ${key}`)
      await sleep(Math.min(2 ** attempt, 50) + Math.random() * 5)
    }
  }
}
