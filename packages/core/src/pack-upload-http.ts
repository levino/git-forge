import { fromUtf8, readAll, SizeLimitError } from './bytes.ts'
import type { Authorize } from './http.ts'
import { refusal } from './visibility.ts'
import {
  createUploadSession,
  DEFAULT_UPLOAD_LIMITS,
  finalizeResult,
  finalizeUpload,
  isExpired,
  parseFinalizeRequest,
  parseUploadParts,
  partSpec,
  readUploadSession,
  storeUploadPart,
  UploadError,
  type UploadLimits,
  uploadedParts,
  uploadPartKey,
  type UploadSession,
} from './pack-upload.ts'
import type { PushOutcome, ReceiveOptions } from './receive-pack.ts'
import { readRefs, type RepositoryName } from './repository.ts'
import type { Storage } from './storage.ts'

export type PresignPut = NonNullable<Storage['presignPut']>

export type UploadHttpOptions = Partial<UploadLimits> & {
  readonly presignExpiresInSeconds?: number
  readonly presignPut?: PresignPut
}

export type UploadContext = {
  readonly storage: Storage
  readonly authorize?: Authorize
  readonly limits: UploadLimits
  readonly presignExpiresInSeconds: number
  readonly presignPut?: PresignPut
  readonly receive: (request: Request) => Promise<ReceiveOptions>
  readonly onPush?: (repo: RepositoryName, outcome: PushOutcome) => Promise<void>
  readonly now?: () => Date
}

const UPLOAD_CONTENT_TYPE = 'application/json; charset=utf-8'

const UPLOADS_PATH = /^\/forge\/uploads(?:\/([^/]+)(?:\/(finalize|parts\/(\d+)))?)?$/

const noCache = { 'Cache-Control': 'no-store' }

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': UPLOAD_CONTENT_TYPE, ...noCache } })

const failure = (status: number, message: string): Response => json(status, { message })

export const uploadLimits = (options: UploadHttpOptions | undefined, maxRequestBytes: number): UploadLimits => ({
  maxPartBytes: Math.min(options?.maxPartBytes ?? DEFAULT_UPLOAD_LIMITS.maxPartBytes, maxRequestBytes),
  maxParts: options?.maxParts ?? DEFAULT_UPLOAD_LIMITS.maxParts,
  maxUploadBytes: options?.maxUploadBytes ?? DEFAULT_UPLOAD_LIMITS.maxUploadBytes,
  lifetimeSeconds: options?.lifetimeSeconds ?? DEFAULT_UPLOAD_LIMITS.lifetimeSeconds,
})

const readJson = async (request: Request): Promise<unknown> => {
  if (!request.body) throw new UploadError(422, 'missing request body')
  let bytes: Uint8Array
  try {
    bytes = await readAll(request.body, 4 * 1024 * 1024)
  } catch (error) {
    if (error instanceof SizeLimitError) throw new UploadError(413, 'request body too large')
    throw error
  }
  try {
    return JSON.parse(fromUtf8(bytes))
  } catch {
    throw new UploadError(422, 'request is not valid JSON')
  }
}

const describe = async (request: Request, base: string, context: UploadContext, repo: RepositoryName, session: UploadSession) => {
  const { storage } = context
  const presign = context.presignPut ?? storage.presignPut?.bind(storage)
  const present = await uploadedParts(storage, repo, session)
  const authorization = request.headers.get('Authorization')
  const own: Record<string, string> = authorization ? { Authorization: authorization } : {}
  const parts = await Promise.all(
    session.parts.map(async (spec, index) => {
      const number = index + 1
      if (present.has(number)) return { number, ...spec, uploaded: true }
      if (presign) {
        const signed = await presign(uploadPartKey(repo, session.id, number), spec.size, spec.sha256, context.presignExpiresInSeconds)
        return { number, ...spec, uploaded: false, upload: { href: signed.url, header: signed.headers, expiresAt: signed.expiresAt.toISOString() } }
      }
      return { number, ...spec, uploaded: false, upload: { href: `${base}/${session.id}/parts/${number}`, header: own, expiresAt: session.expiresAt } }
    }),
  )
  return { id: session.id, createdAt: session.createdAt, expiresAt: session.expiresAt, parts }
}

const declaredLength = (request: Request): number | null => {
  const value = request.headers.get('Content-Length')
  return value !== null && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : null
}

export const handleUploadRequest = async (request: Request, repo: RepositoryName, path: string, context: UploadContext): Promise<Response | null> => {
  const match = UPLOADS_PATH.exec(path)
  if (!match) return null
  const [, id, action, part] = match
  const { storage, limits } = context
  const now = context.now ?? (() => new Date())
  const url = new URL(request.url)
  const base = `${url.origin}${url.pathname.slice(0, url.pathname.length - path.length)}/forge/uploads`
  try {
    const denied = refusal(await context.authorize?.(request, repo, 'write', 'git'))
    if (denied) return denied
    if (!(await readRefs(storage, repo))) return failure(404, 'repository not found')
    if (id === undefined) {
      if (request.method === 'GET') {
        return json(200, {
          maxPartBytes: limits.maxPartBytes,
          maxParts: limits.maxParts,
          maxUploadBytes: Number.isFinite(limits.maxUploadBytes) ? limits.maxUploadBytes : null,
          lifetimeSeconds: limits.lifetimeSeconds,
          direct: (context.presignPut ?? storage.presignPut) !== undefined,
        })
      }
      if (request.method !== 'POST') return failure(405, 'method not allowed')
      const parts = parseUploadParts(await readJson(request), limits)
      const session = await createUploadSession(storage, repo, parts, limits, now())
      return json(201, await describe(request, base, context, repo, session))
    }
    const session = await readUploadSession(storage, repo, id)
    if (!session) return failure(404, 'upload not found')
    if (isExpired(session, now())) return failure(410, 'upload expired; start a new one')
    if (action === undefined) {
      if (request.method !== 'GET') return failure(405, 'method not allowed')
      return json(200, await describe(request, base, context, repo, session))
    }
    if (part !== undefined) {
      if (request.method !== 'PUT') return failure(405, 'method not allowed')
      const number = Number(part)
      const spec = partSpec(session, number)
      const size = declaredLength(request)
      if (size === null) return failure(411, 'Content-Length required')
      if (size !== spec.size) {
        await request.body?.cancel()
        return failure(422, `part ${number} has ${spec.size} bytes, not ${size}`)
      }
      const stored = await storeUploadPart(storage, repo, session, number, request.body ?? new ReadableStream({ start: (c) => c.close() }))
      return json(stored.created ? 201 : 200, { number, uploaded: true })
    }
    if (request.method !== 'POST') return failure(405, 'method not allowed')
    const finalize = parseFinalizeRequest(await readJson(request))
    const present = await uploadedParts(storage, repo, session)
    const missing = session.parts.map((_, index) => index + 1).filter((number) => !present.has(number))
    if (missing.length > 0) return json(409, { message: `parts not uploaded yet: ${missing.join(', ')}`, missing })
    const outcome = await finalizeUpload(await context.receive(request), session, finalize)
    if (context.onPush) await context.onPush(repo, outcome)
    return json(200, finalizeResult(outcome))
  } catch (error) {
    if (error instanceof UploadError) return failure(error.status, error.message)
    throw error
  }
}
