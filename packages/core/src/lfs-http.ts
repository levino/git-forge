import { readAll, SizeLimitError, fromUtf8 } from './bytes.ts'
import type { Authorize } from './http.ts'
import {
  isLfsOid,
  LFS_CONTENT_TYPE,
  lfsBatch,
  type LfsAction,
  lfsObjectKey,
  type LfsLinks,
  type LfsObjectSpec,
  LfsRequestError,
  oversizeMessage,
  parseBatchRequest,
  storeLfsObject,
  verifyLfsObject,
} from './lfs.ts'
import type { DigestFactory } from './digest.ts'
import { readRefs, type RepositoryName } from './repository.ts'
import type { Storage } from './storage.ts'

export type LfsHttpOptions = {
  readonly expiresInSeconds?: number
  readonly maxJsonBytes?: number
  readonly maxObjectBytes?: number
  readonly digests?: DigestFactory
  readonly oversizeHint?: string
  readonly onVerified?: (key: string, size: number) => Promise<void>
}

export type LfsContext = {
  readonly storage: Storage
  readonly authorize?: Authorize
  readonly lfs?: LfsHttpOptions
}

const LFS_PATH = /^\/info\/lfs(\/.*)?$/
const OBJECT_PATH = /^\/info\/lfs\/objects\/([^/]+)$/

const noCache = { 'Cache-Control': 'no-cache, max-age=0, must-revalidate' }

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': LFS_CONTENT_TYPE, ...noCache } })

const failure = (status: number, message: string): Response => json(status, { message })

const readJson = async (request: Request, limit: number): Promise<unknown> => {
  if (!request.body) throw new LfsRequestError(422, 'missing request body')
  let bytes: Uint8Array
  try {
    bytes = await readAll(request.body, limit)
  } catch (error) {
    if (error instanceof SizeLimitError) throw new LfsRequestError(413, `request exceeds ${limit} bytes`)
    throw error
  }
  try {
    return JSON.parse(fromUtf8(bytes))
  } catch {
    throw new LfsRequestError(422, 'request is not valid JSON')
  }
}

const parseSpec = (input: unknown): LfsObjectSpec => {
  const record = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  return { oid: record.oid, size: record.size } as LfsObjectSpec
}

const selfLinks = (request: Request, base: string, storage: Storage, repo: RepositoryName, expiresIn: number): LfsLinks => {
  const authorization = request.headers.get('Authorization')
  const header: Record<string, string> = authorization ? { Authorization: authorization } : {}
  const own = (path: string): LfsAction => ({ href: `${base}${path}`, header, expires_in: expiresIn })
  return {
    upload: async (object) => {
      if (!storage.presignPut) return own(`/objects/${object.oid}`)
      const signed = await storage.presignPut(lfsObjectKey(repo, object.oid), object.size, object.oid, expiresIn)
      return { href: signed.url, header: signed.headers, expires_in: Math.max(0, Math.floor((signed.expiresAt.getTime() - Date.now()) / 1000)) }
    },
    download: async (object) => {
      if (!storage.presignGet) return own(`/objects/${object.oid}`)
      return { href: await storage.presignGet(lfsObjectKey(repo, object.oid), expiresIn), expires_in: expiresIn }
    },
    verify: async () => own('/objects/verify'),
  }
}

const declaredLength = (request: Request): number | null => {
  const value = request.headers.get('Content-Length')
  return value !== null && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : null
}

export const handleLfsRequest = async (request: Request, repo: RepositoryName, path: string, context: LfsContext): Promise<Response | null> => {
  if (!LFS_PATH.test(path)) return null
  const { storage } = context
  const expiresIn = context.lfs?.expiresInSeconds ?? 3600
  const url = new URL(request.url)
  const base = `${url.origin}${url.pathname.slice(0, url.pathname.length - path.length)}/info/lfs`
  try {
    if (path === '/info/lfs/objects/batch') {
      if (request.method !== 'POST') return failure(405, 'method not allowed')
      const batch = parseBatchRequest(await readJson(request, context.lfs?.maxJsonBytes ?? 1024 * 1024))
      const denied = await context.authorize?.(request, repo, batch.operation === 'upload' ? 'write' : 'read', 'lfs')
      if (denied) return denied
      if (!(await readRefs(storage, repo))) return failure(404, 'repository not found')
      const limits = {
        ...(context.lfs?.maxObjectBytes !== undefined ? { maxObjectBytes: context.lfs.maxObjectBytes } : {}),
        ...(context.lfs?.oversizeHint ? { oversizeHint: context.lfs.oversizeHint } : {}),
      }
      return json(200, await lfsBatch(storage, repo, batch, selfLinks(request, base, storage, repo, expiresIn), limits))
    }
    if (path === '/info/lfs/objects/verify') {
      if (request.method !== 'POST') return failure(405, 'method not allowed')
      const denied = await context.authorize?.(request, repo, 'write', 'lfs')
      if (denied) return denied
      const spec = parseSpec(await readJson(request, 64 * 1024))
      const result = await verifyLfsObject(storage, repo, spec, {
        checkHash: storage.presignPut !== undefined,
        ...(context.lfs?.digests ? { digests: context.lfs.digests } : {}),
      })
      if (!result.ok) return failure(result.status, result.message)
      await context.lfs?.onVerified?.(lfsObjectKey(repo, spec.oid), spec.size)
      return json(200, { message: 'ok' })
    }
    const oid = OBJECT_PATH.exec(path)?.[1]
    if (oid === undefined) return failure(404, 'not found')
    if (!isLfsOid(oid)) return failure(422, 'invalid oid')
    if (request.method === 'PUT') {
      const denied = await context.authorize?.(request, repo, 'write', 'lfs')
      if (denied) return denied
      const size = declaredLength(request)
      if (size === null) return failure(411, 'Content-Length required')
      const max = context.lfs?.maxObjectBytes
      if (max !== undefined && size > max) {
        await request.body?.cancel()
        return failure(413, oversizeMessage(max, context.lfs?.oversizeHint))
      }
      if (!(await readRefs(storage, repo))) return failure(404, 'repository not found')
      const result = await storeLfsObject(storage, repo, { oid, size }, request.body ?? new ReadableStream({ start: (c) => c.close() }))
      return result.ok ? new Response(null, { status: 200, headers: noCache }) : failure(result.status, result.message)
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      const denied = await context.authorize?.(request, repo, 'read', 'lfs')
      if (denied) return denied
      const key = lfsObjectKey(repo, oid)
      const stored = request.method === 'GET' ? await storage.get(key) : await storage.head(key)
      if (!stored) return failure(404, 'object does not exist')
      return new Response('body' in stored ? (stored.body as ReadableStream<Uint8Array<ArrayBuffer>>) : null, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(stored.size),
          'Cache-Control': 'private, max-age=31536000, immutable',
        },
      })
    }
    return failure(405, 'method not allowed')
  } catch (error) {
    if (error instanceof LfsRequestError) return failure(error.status, error.message)
    throw error
  }
}
