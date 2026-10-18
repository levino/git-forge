import { readAll, streamOf } from './bytes.ts'
import {
  blobContentType,
  contentDisposition,
  contentTypeForName,
  IMMUTABLE_CACHE,
  matchContentRoute,
  matchesNoneMatch,
  mediaPath,
  OCTET_STREAM,
  parseRange,
  rangeApplies,
  refCacheControl,
  resolveRaw,
  SNIFF_BYTES,
  sniffContentType,
} from './content.ts'
import type { Authorize } from './http.ts'
import { lfsObjectKey } from './lfs.ts'
import { advertisedRefs, ObjectDatabase, readRefs, type RepositoryName } from './repository.ts'
import type { ByteRange, Storage } from './storage.ts'

export type ContentHttpOptions = {
  readonly storage: Storage
  readonly authorize?: Authorize
  readonly refMaxAgeSeconds?: number
}

const noCache = { 'Cache-Control': 'no-cache, max-age=0, must-revalidate' }

const text = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...noCache, ...headers } })

const SANDBOX = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox"

const safetyHeaders = (contentType: string): Record<string, string> => ({
  'X-Content-Type-Options': 'nosniff',
  ...(contentType === 'application/pdf' ? {} : { 'Content-Security-Policy': SANDBOX }),
})

type Servable = {
  readonly size: number
  readonly etag: string
  readonly contentType: string
  readonly cacheControl: string
  readonly filename: string | null
  readonly open: (range: ByteRange | undefined) => Promise<ReadableStream<Uint8Array> | null>
}

const serve = async (request: Request, item: Servable): Promise<Response> => {
  const headers: Record<string, string> = {
    'Content-Type': item.contentType,
    'Cache-Control': item.cacheControl,
    ETag: `"${item.etag}"`,
    'Accept-Ranges': 'bytes',
    ...safetyHeaders(item.contentType),
    ...(item.filename ? { 'Content-Disposition': contentDisposition(item.filename) } : {}),
  }
  if (matchesNoneMatch(request.headers.get('If-None-Match'), item.etag)) return new Response(null, { status: 304, headers })
  const range = rangeApplies(request.headers.get('If-Range'), item.etag) ? parseRange(request.headers.get('Range'), item.size) : ({ kind: 'full' } as const)
  if (range.kind === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${item.size}`, ...noCache } })
  }
  const partial = range.kind === 'partial' ? range.range : undefined
  const length = partial ? partial.length : item.size
  const body = request.method === 'HEAD' ? null : await item.open(partial)
  if (request.method !== 'HEAD' && !body) return text(404, 'object does not exist\n')
  return new Response(body as ReadableStream<Uint8Array<ArrayBuffer>> | null, {
    status: partial ? 206 : 200,
    headers: {
      ...headers,
      'Content-Length': String(length),
      ...(partial ? { 'Content-Range': `bytes ${partial.offset}-${partial.offset + partial.length - 1}/${item.size}` } : {}),
    },
  })
}

const sniffStored = async (storage: Storage, key: string, size: number): Promise<string> => {
  if (size === 0) return OCTET_STREAM
  const head = await storage.get(key, { offset: 0, length: Math.min(SNIFF_BYTES, size) })
  if (!head) return OCTET_STREAM
  return sniffContentType(await readAll(head.body)) ?? OCTET_STREAM
}

const serveLfs = async (
  request: Request,
  storage: Storage,
  repo: RepositoryName,
  oid: string,
  filename: string | null,
  cacheControl: string,
): Promise<Response> => {
  const key = lfsObjectKey(repo, oid)
  const info = await storage.head(key)
  if (!info) return text(404, 'object does not exist\n')
  const contentType = (filename ? contentTypeForName(filename) : null) ?? (await sniffStored(storage, key, info.size))
  return serve(request, {
    size: info.size,
    etag: oid,
    contentType,
    cacheControl,
    filename,
    open: async (range) => (await storage.get(key, range))?.body ?? null,
  })
}

export const handleContentRequest = async (request: Request, options: ContentHttpOptions): Promise<Response | null> => {
  const url = new URL(request.url)
  const route = matchContentRoute(url.pathname)
  if (!route) return null
  if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'method not allowed\n', { Allow: 'GET, HEAD' })
  const { storage } = options
  const denied = await options.authorize?.(request, route.repo, 'read', route.kind === 'media' ? 'lfs' : 'git')
  if (denied) return denied
  const refs = await readRefs(storage, route.repo)
  if (!refs) return text(404, 'repository not found\n')
  if (route.kind === 'media') return serveLfs(request, storage, route.repo, route.oid, route.filename, IMMUTABLE_CACHE)
  const target = await resolveRaw(new ObjectDatabase(storage, route.repo), advertisedRefs(refs.state), route.segments)
  if (target.kind === 'not-found') return text(404, `${target.message}\n`)
  const cacheControl = refCacheControl(target.immutable, options.refMaxAgeSeconds ?? 60)
  if (target.kind === 'lfs') {
    if ((await storage.head(lfsObjectKey(route.repo, target.pointer.oid)))?.size !== target.pointer.size) {
      return text(404, `LFS object ${target.pointer.oid} is not present\n`)
    }
    return new Response(null, {
      status: 302,
      headers: { Location: mediaPath(route.repo, target.pointer.oid, target.name), 'Cache-Control': cacheControl },
    })
  }
  const { data } = target
  return serve(request, {
    size: data.length,
    etag: target.id,
    contentType: blobContentType(target.name, data),
    cacheControl,
    filename: null,
    open: async (range) => streamOf(range ? data.slice(range.offset, range.offset + range.length) : data),
  })
}
