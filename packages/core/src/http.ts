import { readAll, SizeLimitError } from './bytes.ts'
import { parseRange } from './content.ts'
import { advertiseReceivePack, type PushOutcome, receivePack, type ReceiveOptions, type RefPolicy } from './receive-pack.ts'
import { handleLfsRequest, type LfsHttpOptions } from './lfs-http.ts'
import { lfsPushCheck } from './lfs.ts'
import { handleUploadRequest, type UploadHttpOptions, uploadLimits } from './pack-upload-http.ts'
import { gitPrefix, isValidName, readRefs, type RepositoryName } from './repository.ts'
import type { Storage } from './storage.ts'
import { advertiseUploadPackV2, type PackfileUri, uploadPackV2 } from './upload-pack.ts'

export type Access = 'read' | 'write'

export type Surface = 'git' | 'lfs'

export type Authorize = (request: Request, repo: RepositoryName, access: Access, surface: Surface) => Promise<Response | null>

export type PushPolicy = (request: Request, repo: RepositoryName) => Promise<RefPolicy | null>

export type GitHttpOptions = {
  readonly storage: Storage
  readonly authorize?: Authorize
  readonly pushPolicy?: PushPolicy
  readonly maxRequestBytes?: number
  readonly maxPushBytes?: number
  readonly receive?: Omit<ReceiveOptions, 'storage' | 'repo'>
  readonly onPush?: (repo: RepositoryName, outcome: PushOutcome) => Promise<void>
  readonly lfs?: LfsHttpOptions | false
  readonly uploads?: UploadHttpOptions | false
  readonly packfileUris?: (request: Request, repo: RepositoryName) => PackfileUri | undefined | Promise<PackfileUri | undefined>
}

export const publicPackfileUris =
  (baseUrl?: string) =>
  (request: Request, repo: RepositoryName): PackfileUri =>
  async (pack) =>
    `${(baseUrl ?? new URL(request.url).origin).replace(/\/+$/, '')}/${repo.owner}/${repo.name}.git/objects/pack/${pack.name}`

export const presignedPackfileUris =
  (storage: Storage, expiresInSeconds = 3600) =>
  (): PackfileUri | undefined => {
    const presign = storage.presignGet?.bind(storage)
    return presign ? async (pack) => presign(pack.key, expiresInSeconds) : undefined
  }

export type GitRoute = {
  readonly repo: RepositoryName
  readonly path: string
}

const ROUTE = /^\/([^/]+)\/([^/]+?)(?:\.git)?(\/.*)$/

export const matchGitRoute = (pathname: string): GitRoute | null => {
  const match = ROUTE.exec(pathname)
  if (!match) return null
  const [, owner, name, path] = match as unknown as [string, string, string, string]
  if (!isValidName(owner) || !isValidName(name)) return null
  return { repo: { owner, name }, path }
}

const DUMB_PATHS = [/^\/HEAD$/, /^\/info\/refs$/, /^\/objects\/info\/packs$/, /^\/objects\/pack\/pack-[0-9a-f]{40}\.(pack|idx)$/]

const binary = (bytes: Uint8Array): BodyInit => bytes as Uint8Array<ArrayBuffer>

const noCache = { 'Cache-Control': 'no-cache, max-age=0, must-revalidate' }
const immutable = { 'Cache-Control': 'public, max-age=31536000, immutable' }

const text = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...noCache, ...headers } })

const isProtocolV2 = (request: Request): boolean =>
  (request.headers.get('Git-Protocol') ?? '').split(':').includes('version=2')

const bodyStream = (request: Request): ReadableStream<Uint8Array> => {
  if (!request.body) return new ReadableStream({ start: (controller) => controller.close() })
  const encoding = request.headers.get('Content-Encoding')
  return encoding === 'gzip' || encoding === 'x-gzip'
    ? request.body.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
    : request.body
}

const readBody = async (request: Request, limit: number): Promise<Uint8Array> => readAll(bodyStream(request), limit)

const limited = (stream: ReadableStream<Uint8Array>, limit: number): ReadableStream<Uint8Array> => {
  if (!Number.isFinite(limit)) return stream
  let seen = 0
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.length
        if (seen > limit) controller.error(new SizeLimitError(limit))
        else controller.enqueue(chunk)
      },
    }),
  )
}

const serveStored = async (storage: Storage, key: string, contentType: string, cache: Record<string, string>, rangeHeader: string | null = null): Promise<Response> => {
  if (rangeHeader !== null) {
    const info = await storage.head(key)
    if (!info) return text(404, 'not found\n')
    const range = parseRange(rangeHeader, info.size)
    if (range.kind === 'unsatisfiable') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } })
    if (range.kind === 'partial') {
      const object = await storage.get(key, range.range)
      if (!object) return text(404, 'not found\n')
      const { offset, length } = range.range
      return new Response(object.body, {
        status: 206,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(length),
          'Content-Range': `bytes ${offset}-${offset + length - 1}/${info.size}`,
          'Accept-Ranges': 'bytes',
          ETag: `"${object.etag}"`,
          ...cache,
        },
      })
    }
  }
  const object = await storage.get(key)
  if (!object) return text(404, 'not found\n')
  return new Response(object.body, {
    status: 200,
    headers: { 'Content-Type': contentType, 'Content-Length': String(object.size), ETag: `"${object.etag}"`, ...cache },
  })
}

const dumbContentType = (path: string): string => {
  if (path.endsWith('.pack')) return 'application/x-git-packed-objects'
  if (path.endsWith('.idx')) return 'application/x-git-packed-objects-toc'
  return 'text/plain; charset=utf-8'
}

const withLfsCheck = (options: GitHttpOptions, repo: RepositoryName): NonNullable<ReceiveOptions['beforeUpdate']> => {
  const custom = options.receive?.beforeUpdate
  const lfs = options.lfs === false ? null : lfsPushCheck(options.storage, repo)
  return async (objects, commands) => (await lfs?.(objects)) ?? (await custom?.(objects, commands)) ?? null
}

export const combinePolicies =
  (...policies: readonly (RefPolicy | null | undefined)[]): RefPolicy =>
  (command) => {
    for (const policy of policies) {
      const denied = policy?.(command) ?? null
      if (denied) return denied
    }
    return null
  }

export const handleGitRequest = async (request: Request, options: GitHttpOptions): Promise<Response | null> => {
  const url = new URL(request.url)
  const route = matchGitRoute(url.pathname)
  if (!route) return null
  const { repo, path } = route
  const { storage } = options
  if (options.lfs !== false) {
    const lfs = await handleLfsRequest(request, repo, path, {
      storage,
      ...(options.authorize ? { authorize: options.authorize } : {}),
      ...(options.lfs ? { lfs: options.lfs } : {}),
    })
    if (lfs) return lfs
  }
  const limit = options.maxRequestBytes ?? 64 * 1024 * 1024
  if (options.uploads !== false) {
    const uploads = await handleUploadRequest(request, repo, path, {
      storage,
      ...(options.authorize ? { authorize: options.authorize } : {}),
      limits: uploadLimits(options.uploads, options.maxPushBytes ?? options.maxRequestBytes ?? Number.POSITIVE_INFINITY),
      presignExpiresInSeconds: options.uploads?.presignExpiresInSeconds ?? 3600,
      ...(options.uploads?.presignPut ? { presignPut: options.uploads.presignPut } : {}),
      receive: async (incoming) => ({
        ...options.receive,
        storage,
        repo,
        policy: combinePolicies(options.receive?.policy, await options.pushPolicy?.(incoming, repo)),
        beforeUpdate: withLfsCheck(options, repo),
      }),
      ...(options.onPush ? { onPush: options.onPush } : {}),
      ...(options.receive?.now ? { now: options.receive.now } : {}),
    })
    if (uploads) return uploads
  }
  const service = url.searchParams.get('service')
  const isReceive = service === 'git-receive-pack' || path === '/git-receive-pack'
  const isGitPath = path === '/git-upload-pack' || path === '/git-receive-pack' || DUMB_PATHS.some((pattern) => pattern.test(path))
  if (!isGitPath) return null
  const denied = await options.authorize?.(request, repo, isReceive ? 'write' : 'read', 'git')
  if (denied) return denied
  const refs = await readRefs(storage, repo)
  if (!refs) return text(404, 'repository not found\n')

  if (request.method === 'GET' && path === '/info/refs' && service === 'git-receive-pack') {
    return new Response(binary(advertiseReceivePack(refs.state)), {
      headers: { 'Content-Type': 'application/x-git-receive-pack-advertisement', ...noCache },
    })
  }
  const uploadOptions = async () => {
    const packfileUri = await options.packfileUris?.(request, repo)
    return packfileUri ? { packfileUri } : {}
  }
  if (request.method === 'GET' && path === '/info/refs' && service === 'git-upload-pack' && isProtocolV2(request)) {
    return new Response(binary(advertiseUploadPackV2(await uploadOptions())), {
      headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement', ...noCache },
    })
  }
  if ((request.method === 'GET' || request.method === 'HEAD') && DUMB_PATHS.some((pattern) => pattern.test(path))) {
    const cache = path.startsWith('/objects/pack/') ? immutable : noCache
    return serveStored(storage, `${gitPrefix(repo)}${path.slice(1)}`, dumbContentType(path), cache, path.startsWith('/objects/pack/') ? request.headers.get('Range') : null)
  }
  if (request.method === 'POST' && path === '/git-upload-pack') {
    if (!isProtocolV2(request)) return text(400, 'only git protocol v2 is supported for smart fetch\n')
    let body: Uint8Array
    try {
      body = await readBody(request, limit)
    } catch (error) {
      if (error instanceof SizeLimitError) return text(413, 'request too large\n')
      throw error
    }
    return new Response(await uploadPackV2(storage, repo, body, await uploadOptions()), {
      headers: { 'Content-Type': 'application/x-git-upload-pack-result', ...noCache },
    })
  }
  if (request.method === 'POST' && path === '/git-receive-pack') {
    const pushLimit = options.maxPushBytes ?? options.maxRequestBytes ?? Number.POSITIVE_INFINITY
    const policy = combinePolicies(options.receive?.policy, await options.pushPolicy?.(request, repo))
    let received: Awaited<ReturnType<typeof receivePack>>
    try {
      received = await receivePack(
        { ...options.receive, storage, repo, policy, beforeUpdate: withLfsCheck(options, repo) },
        limited(bodyStream(request), pushLimit),
      )
    } catch (error) {
      if (error instanceof SizeLimitError) return text(413, `push exceeds ${pushLimit} bytes; use Git LFS for large files\n`)
      throw error
    }
    const { response, outcome } = received
    if (options.onPush) await options.onPush(repo, outcome)
    return new Response(binary(response), { headers: { 'Content-Type': 'application/x-git-receive-pack-result', ...noCache } })
  }
  return text(405, 'method not allowed\n')
}
