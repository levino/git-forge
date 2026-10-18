import { fromUtf8, toHex, utf8 } from './bytes.ts'
import { createSha256 } from './hash.ts'
import { expectOk, type Remote, RemoteError, remoteRequest } from './remote.ts'
import { type RepositoryName, repositoryPrefix } from './repository.ts'
import type { Storage } from './storage.ts'

export type LfsPointer = {
  readonly oid: string
  readonly size: number
}

export const LFS_POINTER_MAX_SIZE = 1024

const POINTER_VERSIONS = ['https://git-lfs.github.com/spec/v1', 'https://hawser.github.com/spec/v1']

export const isLfsOid = (value: string): boolean => /^[0-9a-f]{64}$/.test(value)

export const parseLfsPointer = (data: Uint8Array): LfsPointer | null => {
  if (data.length > LFS_POINTER_MAX_SIZE || data.length === 0) return null
  const text = fromUtf8(data)
  if (!text.startsWith('version ')) return null
  const fields = new Map<string, string>()
  for (const line of text.split('\n')) {
    if (line === '') continue
    const space = line.indexOf(' ')
    if (space <= 0) return null
    fields.set(line.slice(0, space), line.slice(space + 1))
  }
  const version = fields.get('version')
  const oid = fields.get('oid')
  const size = fields.get('size')
  if (!version || !POINTER_VERSIONS.includes(version) || !oid?.startsWith('sha256:') || !size || !/^\d+$/.test(size)) return null
  const hex = oid.slice('sha256:'.length)
  const bytes = Number(size)
  if (!isLfsOid(hex) || !Number.isSafeInteger(bytes)) return null
  return { oid: hex, size: bytes }
}

export const lfsObjectKey = (repo: RepositoryName, oid: string): string => {
  if (!isLfsOid(oid)) throw new Error(`invalid LFS oid ${oid}`)
  return `${repositoryPrefix(repo)}lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`
}

export const lfsEndpointFor = (gitUrl: string): string => {
  const base = gitUrl.replace(/\/+$/, '')
  return base.endsWith('.git') ? `${base}/info/lfs` : `${base}.git/info/lfs`
}

export class LfsVerificationError extends Error {}

export const verifyingStream = (expected: LfsPointer): TransformStream<Uint8Array, Uint8Array> => {
  const hash = createSha256()
  let received = 0
  return new TransformStream({
    transform(chunk, controller) {
      received += chunk.length
      if (received > expected.size) throw new LfsVerificationError(`LFS object ${expected.oid} is larger than ${expected.size} bytes`)
      hash.update(chunk)
      controller.enqueue(chunk)
    },
    flush() {
      if (received !== expected.size) throw new LfsVerificationError(`LFS object ${expected.oid} has ${received} bytes, expected ${expected.size}`)
      const actual = toHex(hash.digest())
      if (actual !== expected.oid) throw new LfsVerificationError(`LFS object ${expected.oid} has sha256 ${actual}`)
    },
  })
}

export type LfsMissing = LfsPointer & { readonly reason: string }

export type LfsMirrorResult = {
  readonly downloaded: readonly LfsPointer[]
  readonly present: number
  readonly missing: readonly LfsMissing[]
  readonly bytes: number
}

export type LfsMirrorOptions = {
  readonly storage: Storage
  readonly repo: RepositoryName
  readonly remote: Remote
  readonly endpoint?: string
  readonly objects: readonly LfsPointer[]
  readonly batchSize?: number
  readonly concurrency?: number
}

type BatchAction = { readonly href: string; readonly header?: Readonly<Record<string, string>> }

type BatchObject = {
  readonly oid: string
  readonly size: number
  readonly actions?: { readonly download?: BatchAction }
  readonly error?: { readonly code: number; readonly message: string }
}

const LFS_MEDIA_TYPE = 'application/vnd.git-lfs+json'

const requestBatch = async (remote: Remote, endpoint: string, objects: readonly LfsPointer[]): Promise<readonly BatchObject[] | null> => {
  const body = utf8(
    JSON.stringify({
      operation: 'download',
      transfers: ['basic'],
      objects: objects.map(({ oid, size }) => ({ oid, size })),
      hash_algo: 'sha256',
    }),
  )
  const response = await remoteRequest(remote, `${endpoint}/objects/batch`, {
    method: 'POST',
    headers: { Accept: LFS_MEDIA_TYPE, 'Content-Type': LFS_MEDIA_TYPE },
    body,
  })
  if (response.status === 404) {
    await response.body?.cancel()
    return null
  }
  await expectOk(response, 'LFS batch request')
  const parsed = (await response.json()) as { transfer?: string; objects?: BatchObject[] }
  if (parsed.transfer !== undefined && parsed.transfer !== 'basic') throw new RemoteError(`unsupported LFS transfer ${parsed.transfer}`)
  return parsed.objects ?? []
}

const download = async (
  options: LfsMirrorOptions,
  endpoint: string,
  pointer: LfsPointer,
  action: BatchAction,
): Promise<{ ok: true } | { ok: false; reason: string }> => {
  const sameOrigin = new URL(action.href, endpoint).origin === new URL(endpoint).origin
  const headers = action.header ?? {}
  const hasAuthorization = Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')
  const response = await remoteRequest(options.remote, new URL(action.href, endpoint).href, {
    headers,
    authorize: sameOrigin && !hasAuthorization,
  })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    return { ok: false, reason: `download failed with HTTP ${response.status}` }
  }
  try {
    await options.storage.put(lfsObjectKey(options.repo, pointer.oid), response.body.pipeThrough(verifyingStream(pointer)), pointer.size, {
      ifNoneMatch: '*',
      contentType: 'application/octet-stream',
    })
  } catch (error) {
    if (error instanceof LfsVerificationError) return { ok: false, reason: error.message }
    throw error
  }
  return { ok: true }
}

const runLimited = async <T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> => {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await task(items[next++] as T)
  })
  await Promise.all(workers)
}

export const mirrorLfsObjects = async (options: LfsMirrorOptions): Promise<LfsMirrorResult> => {
  const endpoint = options.endpoint ?? lfsEndpointFor(options.remote.url)
  const unique = [...new Map(options.objects.map((pointer) => [pointer.oid, pointer])).values()]
  const wanted: LfsPointer[] = []
  let present = 0
  for (const pointer of unique) {
    const existing = await options.storage.head(lfsObjectKey(options.repo, pointer.oid))
    if (existing && existing.size === pointer.size) present++
    else wanted.push(pointer)
  }
  const downloaded: LfsPointer[] = []
  const missing: LfsMissing[] = []
  let bytes = 0
  const batchSize = options.batchSize ?? 100
  for (let start = 0; start < wanted.length; start += batchSize) {
    const batch = wanted.slice(start, start + batchSize)
    const answers = await requestBatch(options.remote, endpoint, batch)
    if (!answers) {
      missing.push(...batch.map((pointer) => ({ ...pointer, reason: 'LFS batch API not available' })))
      continue
    }
    const byOid = new Map(answers.map((answer) => [answer.oid, answer]))
    await runLimited(batch, options.concurrency ?? 4, async (pointer) => {
      const answer = byOid.get(pointer.oid)
      const action = answer?.actions?.download
      if (!answer || answer.error || !action) {
        missing.push({ ...pointer, reason: answer?.error ? `${answer.error.code} ${answer.error.message}` : 'no download action' })
        return
      }
      const result = await download(options, endpoint, pointer, action)
      if (result.ok) {
        downloaded.push(pointer)
        bytes += pointer.size
      } else {
        missing.push({ ...pointer, reason: result.reason })
      }
    })
  }
  return { downloaded, present, missing, bytes }
}
