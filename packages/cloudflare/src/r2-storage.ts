import { type ByteRange, exactLength, type ObjectInfo, type PutBody, type PutOptions, type PutResult, type Storage, type StoredObject } from '@git-forge/core'

export type R2StorageOptions = {
  readonly prefix?: string
  readonly listPageSize?: number
}

const info = (object: R2Object, key: string): ObjectInfo => ({ key, size: object.size, etag: object.etag })

const conditions = (options: PutOptions): R2Conditional | undefined => {
  if (options.ifNoneMatch === '*' && options.ifMatch !== undefined) return { etagMatches: options.ifMatch, etagDoesNotMatch: '*' }
  if (options.ifNoneMatch === '*') return { etagDoesNotMatch: '*' }
  if (options.ifMatch !== undefined) return { etagMatches: options.ifMatch }
  return undefined
}

const fixedLength = (body: PutBody, size: number): Uint8Array | ReadableStream<Uint8Array> => {
  if (body instanceof Uint8Array) {
    if (body.length !== size) throw new Error(`size mismatch: expected ${size}, got ${body.length}`)
    return body
  }
  return body.pipeThrough(exactLength(size)).pipeThrough(new FixedLengthStream(size) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
}

export class R2Storage implements Storage {
  readonly #bucket: R2Bucket
  readonly #prefix: string
  readonly #pageSize: number

  constructor(bucket: R2Bucket, options: R2StorageOptions = {}) {
    this.#bucket = bucket
    this.#prefix = options.prefix ?? ''
    this.#pageSize = options.listPageSize ?? 1000
  }

  async get(key: string, range?: ByteRange): Promise<StoredObject | null> {
    if (range) {
      const head = await this.#bucket.head(this.#prefix + key)
      if (!head) return null
      const offset = Math.min(range.offset, head.size)
      const length = Math.max(0, Math.min(range.length, head.size - offset))
      if (length === 0) return { ...info(head, key), body: new Response(new Uint8Array(0)).body as ReadableStream<Uint8Array> }
      const object = await this.#bucket.get(this.#prefix + key, { range: { offset, length }, onlyIf: { etagMatches: head.etag } })
      if (!object) return null
      if (!('body' in object)) return this.get(key, range)
      return { ...info(object, key), body: object.body as ReadableStream<Uint8Array> }
    }
    const object = await this.#bucket.get(this.#prefix + key)
    return object ? { ...info(object, key), body: object.body as ReadableStream<Uint8Array> } : null
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const object = await this.#bucket.head(this.#prefix + key)
    return object ? info(object, key) : null
  }

  async put(key: string, body: PutBody, size: number, options: PutOptions = {}): Promise<PutResult> {
    const onlyIf = conditions(options)
    const object = await this.#bucket.put(this.#prefix + key, fixedLength(body, size), {
      ...(onlyIf ? { onlyIf } : {}),
      ...(options.contentType ? { httpMetadata: { contentType: options.contentType } } : {}),
    })
    return object ? { ok: true, info: info(object, key) } : { ok: false, reason: 'precondition-failed' }
  }

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    let cursor: string | undefined
    do {
      const page = await this.#bucket.list({ prefix: this.#prefix + prefix, limit: this.#pageSize, ...(cursor ? { cursor } : {}) })
      for (const object of page.objects) yield info(object, object.key.slice(this.#prefix.length))
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
  }
}
