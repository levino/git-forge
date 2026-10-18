import { concat, fromUtf8, utf8 } from './bytes.ts'
import { isObjectId, ZERO_ID } from './hash.ts'
import { LfsIntegrityError, putVerifiedStream } from './lfs.ts'
import { FLUSH, pkt } from './pktline.ts'
import { type PushOutcome, receivePack, type ReceiveOptions, type RefCommand } from './receive-pack.ts'
import { repositoryPrefix, type RepositoryName } from './repository.ts'
import type { Storage } from './storage.ts'

export type UploadPartSpec = {
  readonly size: number
  readonly sha256: string
}

export type UploadSession = {
  readonly version: 1
  readonly id: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly parts: readonly UploadPartSpec[]
}

export type UploadLimits = {
  readonly maxPartBytes: number
  readonly maxParts: number
  readonly maxUploadBytes: number
  readonly lifetimeSeconds: number
}

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxPartBytes: 64 * 1024 * 1024,
  maxParts: 10_000,
  maxUploadBytes: Number.POSITIVE_INFINITY,
  lifetimeSeconds: 12 * 3600,
}

export class UploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const UPLOAD_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const isUploadId = (id: string): boolean => UPLOAD_ID.test(id)

const newUploadId = (at: Date): string => `${at.toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`

const uploadPrefix = (repo: RepositoryName, id: string): string => `tmp/${repositoryPrefix(repo)}${id}/`

const uploadSessionKey = (repo: RepositoryName, id: string): string => `${uploadPrefix(repo, id)}upload.json`

export const uploadPartKey = (repo: RepositoryName, id: string, number: number): string =>
  `${uploadPrefix(repo, id)}part/${String(number).padStart(5, '0')}`

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export const parseUploadParts = (input: unknown, limits: UploadLimits): UploadPartSpec[] => {
  if (!isRecord(input) || !Array.isArray(input.parts)) throw new UploadError(422, 'parts must be an array')
  if (input.parts.length > limits.maxParts) throw new UploadError(422, `at most ${limits.maxParts} parts`)
  let total = 0
  const parts = input.parts.map((part: unknown, index): UploadPartSpec => {
    if (!isRecord(part)) throw new UploadError(422, `part ${index + 1} must be an object`)
    const { size, sha256 } = part
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) throw new UploadError(422, `part ${index + 1} needs a positive integer size`)
    if (size > limits.maxPartBytes) throw new UploadError(413, `part ${index + 1} exceeds ${limits.maxPartBytes} bytes`)
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new UploadError(422, `part ${index + 1} needs a lowercase hex sha256`)
    total += size
    return { size, sha256 }
  })
  if (total > limits.maxUploadBytes) throw new UploadError(413, `upload exceeds ${limits.maxUploadBytes} bytes`)
  return parts
}

export const createUploadSession = async (
  storage: Storage,
  repo: RepositoryName,
  parts: readonly UploadPartSpec[],
  limits: UploadLimits,
  now: Date = new Date(),
): Promise<UploadSession> => {
  const id = newUploadId(now)
  const session: UploadSession = {
    version: 1,
    id,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + limits.lifetimeSeconds * 1000).toISOString(),
    parts,
  }
  const body = utf8(`${JSON.stringify(session)}\n`)
  const written = await storage.put(uploadSessionKey(repo, id), body, body.length, { ifNoneMatch: '*', contentType: 'application/json' })
  if (!written.ok) throw new UploadError(409, 'upload session exists')
  return session
}

export const readUploadSession = async (storage: Storage, repo: RepositoryName, id: string): Promise<UploadSession | null> => {
  if (!isUploadId(id)) return null
  const stored = await storage.get(uploadSessionKey(repo, id))
  if (!stored) return null
  const chunks: Uint8Array[] = []
  const reader = stored.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const value: unknown = JSON.parse(fromUtf8(concat(chunks)))
  if (!isRecord(value) || value.version !== 1 || value.id !== id || !Array.isArray(value.parts)) return null
  return value as UploadSession
}

export const isExpired = (session: UploadSession, now: Date): boolean => now.getTime() >= Date.parse(session.expiresAt)

export const uploadedParts = async (storage: Storage, repo: RepositoryName, session: UploadSession): Promise<Set<number>> => {
  const prefix = `${uploadPrefix(repo, session.id)}part/`
  const present = new Set<number>()
  for await (const object of storage.list(prefix)) {
    const name = object.key.slice(prefix.length)
    if (!/^\d{5}$/.test(name)) continue
    const number = Number(name)
    const spec = session.parts[number - 1]
    if (spec && spec.size === object.size) present.add(number)
  }
  return present
}

export const partSpec = (session: UploadSession, number: number): UploadPartSpec => {
  const spec = Number.isSafeInteger(number) && number >= 1 ? session.parts[number - 1] : undefined
  if (!spec) throw new UploadError(404, `upload has no part ${number}`)
  return spec
}

export const storeUploadPart = async (
  storage: Storage,
  repo: RepositoryName,
  session: UploadSession,
  number: number,
  body: ReadableStream<Uint8Array>,
): Promise<{ readonly created: boolean }> => {
  const spec = partSpec(session, number)
  const key = uploadPartKey(repo, session.id, number)
  const existing = await storage.head(key)
  if (existing && existing.size === spec.size) {
    await body.cancel()
    return { created: false }
  }
  try {
    const result = await putVerifiedStream(storage, key, body, { oid: spec.sha256, size: spec.size }, { contentType: 'application/octet-stream' })
    return { created: result.ok }
  } catch (error) {
    if (error instanceof LfsIntegrityError) throw new UploadError(422, `part ${number}: ${error.message}`)
    throw error
  }
}

const uploadedPack = (storage: Storage, repo: RepositoryName, session: UploadSession): ReadableStream<Uint8Array> => {
  let next = 0
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let remaining = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (!reader) {
          if (next >= session.parts.length) {
            controller.close()
            return
          }
          const number = ++next
          const spec = session.parts[number - 1] as UploadPartSpec
          const stored = await storage.get(uploadPartKey(repo, session.id, number))
          if (!stored || stored.size !== spec.size) {
            controller.error(new UploadError(409, `part ${number} is missing`))
            return
          }
          reader = stored.body.getReader()
          remaining = spec.size
        }
        const { done, value } = await reader.read()
        if (done) {
          reader = null
          if (remaining !== 0) {
            controller.error(new UploadError(409, `part ${next} is truncated`))
            return
          }
          continue
        }
        remaining -= value.length
        controller.enqueue(value)
        return
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason)
    },
  })
}

export type FinalizeRequest = {
  readonly commands: readonly RefCommand[]
  readonly atomic: boolean
}

export const parseFinalizeRequest = (input: unknown): FinalizeRequest => {
  if (!isRecord(input) || !Array.isArray(input.commands) || input.commands.length === 0) throw new UploadError(422, 'commands must be a non-empty array')
  const seen = new Set<string>()
  const commands = input.commands.map((command: unknown): RefCommand => {
    if (!isRecord(command)) throw new UploadError(422, 'each command must be an object')
    const { name, oldId, newId } = command
    if (typeof name !== 'string' || name.length === 0 || /[\0\n ]/.test(name)) throw new UploadError(422, 'invalid ref name')
    if (typeof oldId !== 'string' || !isObjectId(oldId)) throw new UploadError(422, `invalid oldId for ${name}`)
    if (typeof newId !== 'string' || !isObjectId(newId)) throw new UploadError(422, `invalid newId for ${name}`)
    if (oldId === ZERO_ID && newId === ZERO_ID) throw new UploadError(422, `nothing to do for ${name}`)
    if (seen.has(name)) throw new UploadError(422, `duplicate command for ${name}`)
    seen.add(name)
    return { name, oldId, newId }
  })
  if (input.atomic !== undefined && typeof input.atomic !== 'boolean') throw new UploadError(422, 'atomic must be a boolean')
  return { commands, atomic: input.atomic === true }
}

export const receiveRequest = (request: FinalizeRequest, pack: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> => {
  const capabilities = `report-status${request.atomic ? ' atomic' : ''}`
  const head = concat([
    ...request.commands.map((command, i) => pkt(`${command.oldId} ${command.newId} ${command.name}${i === 0 ? `\0${capabilities}` : ''}\n`)),
    FLUSH,
  ])
  let sentHead = false
  const reader = pack?.getReader() ?? null
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentHead) {
        sentHead = true
        controller.enqueue(head)
        return
      }
      const next = reader ? await reader.read() : { done: true as const, value: undefined }
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    async cancel(reason) {
      await reader?.cancel(reason)
    },
  })
}

export type FinalizeResult = {
  readonly unpack: string
  readonly results: readonly { readonly name: string; readonly ok: boolean; readonly reason?: string }[]
}

export const finalizeResult = (outcome: PushOutcome): FinalizeResult => ({
  unpack: outcome.unpack,
  results: outcome.results.map((result) => (result.ok ? { name: result.name, ok: true } : { name: result.name, ok: false, reason: result.reason ?? 'rejected' })),
})

export const finalizeUpload = async (
  options: ReceiveOptions,
  session: UploadSession,
  request: FinalizeRequest,
): Promise<PushOutcome> => {
  const writes = request.commands.some((command) => command.newId !== ZERO_ID)
  const pack = writes && session.parts.length > 0 ? uploadedPack(options.storage, options.repo, session) : null
  const { outcome } = await receivePack(options, receiveRequest(request, pack))
  return outcome
}
