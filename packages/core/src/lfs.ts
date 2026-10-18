import { fromUtf8, toHex } from './bytes.ts'
import { createSha256 } from './hash.ts'
import type { ResolvedObject } from './pack.ts'
import { repositoryPrefix, type RepositoryName } from './repository.ts'
import type { Storage } from './storage.ts'

export const LFS_CONTENT_TYPE = 'application/vnd.git-lfs+json'

export const LFS_POINTER_VERSION = 'https://git-lfs.github.com/spec/v1'

export const LFS_LEGACY_POINTER_VERSION = 'https://hawser.github.com/spec/v1'

export const LFS_POINTER_MAX_SIZE = 1024

export type LfsOperation = 'upload' | 'download'

export type LfsObjectSpec = {
  readonly oid: string
  readonly size: number
}

export type LfsAction = {
  readonly href: string
  readonly header?: Readonly<Record<string, string>>
  readonly expires_in?: number
}

export type LfsObjectResult = LfsObjectSpec & {
  readonly authenticated?: boolean
  readonly actions?: Readonly<Partial<Record<'upload' | 'download' | 'verify', LfsAction>>>
  readonly error?: { readonly code: number; readonly message: string }
}

export type LfsBatchRequest = {
  readonly operation: LfsOperation
  readonly transfers?: readonly string[]
  readonly objects: readonly LfsObjectSpec[]
  readonly hash_algo?: string
}

export type LfsBatchResponse = {
  readonly transfer: 'basic'
  readonly objects: readonly LfsObjectResult[]
  readonly hash_algo: 'sha256'
}

export type LfsLinks = {
  readonly upload: (object: LfsObjectSpec) => Promise<LfsAction>
  readonly download: (object: LfsObjectSpec) => Promise<LfsAction>
  readonly verify: (object: LfsObjectSpec) => Promise<LfsAction>
}

export class LfsRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export const isLfsOid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

export const isLfsSize = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export const lfsPrefix = (repo: RepositoryName): string => `${repositoryPrefix(repo)}lfs/`

export const lfsObjectKey = (repo: RepositoryName, oid: string): string => {
  if (!isLfsOid(oid)) throw new LfsRequestError(422, `invalid LFS oid ${oid}`)
  return `${lfsPrefix(repo)}objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`
}

export const LFS_MAX_BATCH_OBJECTS = 1000

export const parseBatchRequest = (input: unknown): LfsBatchRequest => {
  if (typeof input !== 'object' || input === null) throw new LfsRequestError(422, 'request must be a JSON object')
  const body = input as Record<string, unknown>
  if (body.operation !== 'upload' && body.operation !== 'download') throw new LfsRequestError(422, 'operation must be upload or download')
  if (body.hash_algo !== undefined && body.hash_algo !== 'sha256') throw new LfsRequestError(409, `unsupported hash algorithm ${String(body.hash_algo)}`)
  if (body.transfers !== undefined) {
    if (!Array.isArray(body.transfers)) throw new LfsRequestError(422, 'transfers must be an array')
    if (body.transfers.length > 0 && !body.transfers.includes('basic')) throw new LfsRequestError(422, 'only the basic transfer adapter is supported')
  }
  if (!Array.isArray(body.objects)) throw new LfsRequestError(422, 'objects must be an array')
  if (body.objects.length > LFS_MAX_BATCH_OBJECTS) throw new LfsRequestError(413, `at most ${LFS_MAX_BATCH_OBJECTS} objects per batch`)
  const objects = body.objects.map((object: unknown) => {
    const record = (typeof object === 'object' && object !== null ? object : {}) as Record<string, unknown>
    return { oid: record.oid, size: record.size } as LfsObjectSpec
  })
  return { operation: body.operation, objects, hash_algo: 'sha256' }
}

export const objectError = (object: LfsObjectSpec): string | null => {
  if (!isLfsOid(object.oid)) return 'invalid oid'
  if (!isLfsSize(object.size)) return 'invalid size'
  return null
}

export const lfsObjectSize = async (storage: Storage, repo: RepositoryName, oid: string): Promise<number | null> =>
  (await storage.head(lfsObjectKey(repo, oid)))?.size ?? null

export const hasLfsObject = async (storage: Storage, repo: RepositoryName, object: LfsObjectSpec): Promise<boolean> =>
  (await lfsObjectSize(storage, repo, object.oid)) === object.size

export type LfsLimits = {
  readonly maxObjectBytes?: number
}

const describeObject = async (
  storage: Storage,
  repo: RepositoryName,
  operation: LfsOperation,
  object: LfsObjectSpec,
  links: LfsLinks,
  limits: LfsLimits,
): Promise<LfsObjectResult> => {
  const invalid = objectError(object)
  if (invalid) return { oid: object.oid, size: object.size, error: { code: 422, message: invalid } }
  const stored = await lfsObjectSize(storage, repo, object.oid)
  if (operation === 'download') {
    if (stored === null) return { ...object, error: { code: 404, message: 'object does not exist' } }
    if (stored !== object.size) return { ...object, error: { code: 422, message: `object size is ${stored}, not ${object.size}` } }
    return { ...object, authenticated: true, actions: { download: await links.download(object) } }
  }
  if (stored === object.size) return { ...object, authenticated: true }
  if (stored !== null) return { ...object, error: { code: 422, message: `object size is ${stored}, not ${object.size}` } }
  if (limits.maxObjectBytes !== undefined && object.size > limits.maxObjectBytes) {
    return { ...object, error: { code: 422, message: `object exceeds ${limits.maxObjectBytes} bytes` } }
  }
  return { ...object, authenticated: true, actions: { upload: await links.upload(object), verify: await links.verify(object) } }
}

export const lfsBatch = async (
  storage: Storage,
  repo: RepositoryName,
  request: LfsBatchRequest,
  links: LfsLinks,
  limits: LfsLimits = {},
): Promise<LfsBatchResponse> => ({
  transfer: 'basic',
  hash_algo: 'sha256',
  objects: await Promise.all(request.objects.map((object) => describeObject(storage, repo, request.operation, object, links, limits))),
})

export class LfsIntegrityError extends Error {}

export const verifyingStream = (expected: LfsObjectSpec): TransformStream<Uint8Array, Uint8Array> => {
  const hash = createSha256()
  let seen = 0
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.length
      if (seen > expected.size) throw new LfsIntegrityError(`body exceeds declared size ${expected.size}`)
      hash.update(chunk)
      controller.enqueue(chunk)
    },
    flush() {
      if (seen !== expected.size) throw new LfsIntegrityError(`body has ${seen} bytes, expected ${expected.size}`)
      const actual = toHex(hash.digest())
      if (actual !== expected.oid) throw new LfsIntegrityError(`body has sha256 ${actual}, expected ${expected.oid}`)
    },
  })
}

export const hashStream = async (stream: ReadableStream<Uint8Array>): Promise<{ readonly oid: string; readonly size: number }> => {
  const hash = createSha256()
  let size = 0
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    hash.update(value)
  }
  return { oid: toHex(hash.digest()), size }
}

export type StoreResult = { readonly ok: true; readonly created: boolean } | { readonly ok: false; readonly status: number; readonly message: string }

export const storeLfsObject = async (
  storage: Storage,
  repo: RepositoryName,
  object: LfsObjectSpec,
  body: ReadableStream<Uint8Array>,
): Promise<StoreResult> => {
  const invalid = objectError(object)
  if (invalid) {
    await body.cancel()
    return { ok: false, status: 422, message: invalid }
  }
  const existing = await lfsObjectSize(storage, repo, object.oid)
  if (existing !== null) {
    await body.cancel()
    return existing === object.size ? { ok: true, created: false } : { ok: false, status: 422, message: `object size is ${existing}, not ${object.size}` }
  }
  try {
    const result = await storage.put(lfsObjectKey(repo, object.oid), body.pipeThrough(verifyingStream(object)), object.size, {
      ifNoneMatch: '*',
      contentType: 'application/octet-stream',
    })
    return { ok: true, created: result.ok }
  } catch (error) {
    if (error instanceof LfsIntegrityError) return { ok: false, status: 422, message: error.message }
    throw error
  }
}

export type VerifyResult = { readonly ok: true } | { readonly ok: false; readonly status: number; readonly message: string }

export const verifyLfsObject = async (
  storage: Storage,
  repo: RepositoryName,
  object: LfsObjectSpec,
  options: { readonly checkHash: boolean },
): Promise<VerifyResult> => {
  const invalid = objectError(object)
  if (invalid) return { ok: false, status: 422, message: invalid }
  const key = lfsObjectKey(repo, object.oid)
  if (!options.checkHash) {
    const info = await storage.head(key)
    if (!info) return { ok: false, status: 404, message: 'object does not exist' }
    return info.size === object.size ? { ok: true } : { ok: false, status: 422, message: `object size is ${info.size}, not ${object.size}` }
  }
  const stored = await storage.get(key)
  if (!stored) return { ok: false, status: 404, message: 'object does not exist' }
  if (stored.size !== object.size) {
    await stored.body.cancel()
    return { ok: false, status: 422, message: `object size is ${stored.size}, not ${object.size}` }
  }
  const actual = await hashStream(stored.body)
  if (actual.oid !== object.oid || actual.size !== object.size) return { ok: false, status: 422, message: `stored object hashes to ${actual.oid}` }
  return { ok: true }
}

const POINTER_LINE = /^([a-z0-9.-]+) ([^\r\n]*)$/

export const parseLfsPointer = (data: Uint8Array): LfsObjectSpec | null => {
  if (data.length === 0 || data.length >= LFS_POINTER_MAX_SIZE || data[data.length - 1] !== 0x0a) return null
  const text = fromUtf8(data)
  if (!text.startsWith(`version ${LFS_POINTER_VERSION}\n`) && !text.startsWith(`version ${LFS_LEGACY_POINTER_VERSION}\n`)) return null
  const lines = text.slice(0, -1).split('\n')
  const values = new Map<string, string>()
  let previous = ''
  for (const [i, line] of lines.entries()) {
    const match = POINTER_LINE.exec(line)
    if (!match) return null
    const [, key, value] = match as unknown as [string, string, string]
    if (i > 0 && (key === 'version' || key <= previous)) return null
    if (i > 0) previous = key
    values.set(key, value)
  }
  const oid = /^sha256:([0-9a-f]{64})$/.exec(values.get('oid') ?? '')?.[1]
  const sizeText = values.get('size') ?? ''
  if (!oid || !/^(0|[1-9][0-9]*)$/.test(sizeText)) return null
  const size = Number(sizeText)
  return isLfsSize(size) ? { oid, size } : null
}

export const pointersIn = (objects: readonly ResolvedObject[]): LfsObjectSpec[] => {
  const found = new Map<string, LfsObjectSpec>()
  for (const object of objects) {
    if (object.type !== 'blob') continue
    const pointer = parseLfsPointer(object.data)
    if (pointer) found.set(`${pointer.oid}:${pointer.size}`, pointer)
  }
  return [...found.values()]
}

export const missingLfsObjects = async (storage: Storage, repo: RepositoryName, objects: readonly ResolvedObject[]): Promise<LfsObjectSpec[]> => {
  const missing: LfsObjectSpec[] = []
  for (const pointer of pointersIn(objects)) if (!(await hasLfsObject(storage, repo, pointer))) missing.push(pointer)
  return missing
}

export const lfsPushCheck =
  (storage: Storage, repo: RepositoryName) =>
  async (objects: readonly ResolvedObject[]): Promise<string | null> => {
    const missing = await missingLfsObjects(storage, repo, objects)
    if (missing.length === 0) return null
    const [first] = missing as [LfsObjectSpec]
    return missing.length === 1 ? `missing LFS object ${first.oid}` : `missing ${missing.length} LFS objects, e.g. ${first.oid}`
  }
