import type { ByteRange, ObjectInfo, PresignedPut, PutBody, PutOptions, PutResult, Storage, StoredObject } from '@git-forge/core'
import { exactLength, fromHex } from '@git-forge/core'
import { AwsV4Signer } from 'aws4fetch'
import { normalizeEtag, parseErrorCode, parseListObjectsV2 } from './xml.ts'

export type S3StorageConfig = {
  readonly endpoint: string
  readonly region: string
  readonly bucket: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
  readonly prefix?: string
  readonly forcePathStyle?: boolean
  readonly listPageSize?: number
  readonly fetch?: typeof fetch
}

export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message)
    this.name = 'S3Error'
  }
}

type FixedLengthStreamConstructor = new (length: number) => TransformStream<Uint8Array, Uint8Array>

const encodeKey = (key: string): string =>
  key
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/')

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const emptyStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    },
  })

const fixedLength = (body: ReadableStream<Uint8Array>, size: number): ReadableStream<Uint8Array> => {
  const checked = body.pipeThrough(exactLength(size))
  const Fixed = (globalThis as { FixedLengthStream?: FixedLengthStreamConstructor }).FixedLengthStream
  return typeof Fixed === 'function' ? checked.pipeThrough(new Fixed(size)) : checked
}

const totalSize = (response: Response): number => {
  const range = response.headers.get('content-range')
  const total = range?.match(/\/(\d+)\s*$/)?.[1]
  if (total !== undefined) return Number.parseInt(total, 10)
  return Number.parseInt(response.headers.get('content-length') ?? '0', 10)
}

export class S3Storage implements Storage {
  readonly #config: S3StorageConfig
  readonly #prefix: string
  readonly #fetch: typeof fetch
  readonly #base: URL

  constructor(config: S3StorageConfig) {
    this.#config = config
    this.#prefix = config.prefix ?? ''
    this.#fetch = config.fetch ?? ((input, init) => fetch(input, init))
    const endpoint = new URL(config.endpoint)
    if (config.forcePathStyle) {
      const path = endpoint.pathname.replace(/\/+$/, '')
      this.#base = new URL(`${endpoint.protocol}//${endpoint.host}${path}/${encodeKey(config.bucket)}`)
    } else {
      this.#base = new URL(`${endpoint.protocol}//${config.bucket}.${endpoint.host}${endpoint.pathname.replace(/\/+$/, '')}`)
    }
  }

  #objectUrl(key: string): URL {
    return new URL(`${this.#base.href}/${encodeKey(this.#prefix + key)}`)
  }

  #bucketUrl(): URL {
    return new URL(`${this.#base.href}/`)
  }

  #signer(method: string, url: URL, headers: Record<string, string>, query?: { signQuery: true; allHeaders: boolean }) {
    return new AwsV4Signer({
      method,
      url: url.toString(),
      headers,
      accessKeyId: this.#config.accessKeyId,
      secretAccessKey: this.#config.secretAccessKey,
      ...(this.#config.sessionToken === undefined ? {} : { sessionToken: this.#config.sessionToken }),
      service: 's3',
      region: this.#config.region,
      ...(query ?? {}),
    })
  }

  async #send(method: string, url: URL, headers: Record<string, string>, body?: BodyInit): Promise<Response> {
    const signed = await this.#signer(method, url, headers).sign()
    const init: RequestInit & { duplex?: 'half' } = { method, headers: signed.headers }
    if (body !== undefined) {
      init.body = body
      init.duplex = 'half'
    }
    return this.#fetch(signed.url.toString(), init)
  }

  async #fail(response: Response, action: string, key: string): Promise<never> {
    const text = await response.text().catch(() => '')
    const code = parseErrorCode(text)
    throw new S3Error(response.status, code, `S3 ${action} ${key}: ${response.status}${code ? ` ${code}` : ''}`)
  }

  async get(key: string, range?: ByteRange): Promise<StoredObject | null> {
    if (range && range.length <= 0) return this.#emptyRange(key)
    const headers: Record<string, string> = range ? { range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {}
    const response = await this.#send('GET', this.#objectUrl(key), headers)
    if (response.status === 404) {
      await response.body?.cancel()
      return null
    }
    if (response.status === 416) {
      await response.body?.cancel()
      return this.#emptyRange(key)
    }
    if (response.status !== 200 && response.status !== 206) return this.#fail(response, 'GET', key)
    return {
      key,
      size: totalSize(response),
      etag: normalizeEtag(response.headers.get('etag') ?? ''),
      body: response.body ?? emptyStream(),
    }
  }

  async #emptyRange(key: string): Promise<StoredObject | null> {
    const info = await this.head(key)
    return info ? { ...info, body: emptyStream() } : null
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const response = await this.#send('HEAD', this.#objectUrl(key), {})
    await response.body?.cancel()
    if (response.status === 404) return null
    if (response.status !== 200) throw new S3Error(response.status, undefined, `S3 HEAD ${key}: ${response.status}`)
    return {
      key,
      size: Number.parseInt(response.headers.get('content-length') ?? '0', 10),
      etag: normalizeEtag(response.headers.get('etag') ?? ''),
    }
  }

  async put(key: string, body: PutBody, size: number, options: PutOptions = {}): Promise<PutResult> {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`invalid size for ${key}: ${size}`)
    if (body instanceof Uint8Array && body.length !== size) {
      throw new Error(`size mismatch for ${key}: expected ${size}, got ${body.length}`)
    }
    const headers: Record<string, string> = { 'content-length': String(size) }
    if (options.contentType !== undefined) headers['content-type'] = options.contentType
    if (options.ifMatch !== undefined) headers['if-match'] = `"${normalizeEtag(options.ifMatch)}"`
    if (options.ifNoneMatch === '*') headers['if-none-match'] = '*'
    const payload: BodyInit = body instanceof Uint8Array ? (body as Uint8Array<ArrayBuffer>) : fixedLength(body, size)
    const response = await this.#send('PUT', this.#objectUrl(key), headers, payload)
    if (response.status === 412) {
      await response.body?.cancel()
      return { ok: false, reason: 'precondition-failed' }
    }
    if (response.status === 409 || (response.status === 404 && options.ifMatch !== undefined)) {
      const text = await response.text().catch(() => '')
      const code = parseErrorCode(text)
      if (response.status === 404 || code === 'ConditionalRequestConflict') return { ok: false, reason: 'precondition-failed' }
      throw new S3Error(response.status, code, `S3 PUT ${key}: ${response.status}${code ? ` ${code}` : ''}`)
    }
    if (response.status !== 200) return this.#fail(response, 'PUT', key)
    await response.body?.cancel()
    const etag = response.headers.get('etag')
    if (etag) return { ok: true, info: { key, size, etag: normalizeEtag(etag) } }
    const info = await this.head(key)
    if (!info) throw new S3Error(response.status, undefined, `S3 PUT ${key}: object missing after write`)
    return { ok: true, info }
  }

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    let token: string | undefined
    do {
      const url = this.#bucketUrl()
      url.searchParams.set('list-type', '2')
      url.searchParams.set('prefix', this.#prefix + prefix)
      if (this.#config.listPageSize !== undefined) url.searchParams.set('max-keys', String(this.#config.listPageSize))
      if (token !== undefined) url.searchParams.set('continuation-token', token)
      const response = await this.#send('GET', url, {})
      if (response.status !== 200) await this.#fail(response, 'LIST', prefix)
      const page = parseListObjectsV2(await response.text())
      for (const entry of page.contents) {
        if (!entry.key.startsWith(this.#prefix)) continue
        yield { key: entry.key.slice(this.#prefix.length), size: entry.size, etag: entry.etag }
      }
      token = page.isTruncated ? page.nextContinuationToken : undefined
      if (page.isTruncated && token === undefined) throw new S3Error(200, undefined, `S3 LIST ${prefix}: truncated without token`)
    } while (token !== undefined)
  }

  async presignGet(key: string, expiresInSeconds: number): Promise<string> {
    const url = this.#objectUrl(key)
    url.searchParams.set('X-Amz-Expires', String(Math.floor(expiresInSeconds)))
    const signed = await this.#signer('GET', url, {}, { signQuery: true, allHeaders: false }).sign()
    return signed.url.toString()
  }

  async presignPut(key: string, size: number, sha256Hex: string, expiresInSeconds: number): Promise<PresignedPut> {
    if (!/^[0-9a-f]{64}$/.test(sha256Hex)) throw new Error(`invalid sha256: ${sha256Hex}`)
    const expiresAt = new Date(Date.now() + Math.floor(expiresInSeconds) * 1000)
    const headers = { 'content-length': String(size), 'x-amz-checksum-sha256': toBase64(fromHex(sha256Hex)) }
    const url = this.#objectUrl(key)
    url.searchParams.set('X-Amz-Expires', String(Math.floor(expiresInSeconds)))
    const signed = await this.#signer('PUT', url, headers, { signQuery: true, allHeaders: true }).sign()
    return { url: signed.url.toString(), headers, expiresAt }
  }
}
