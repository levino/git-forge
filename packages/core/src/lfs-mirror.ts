import { utf8 } from './bytes.ts'
import type { DigestFactory } from './digest.ts'
import { LfsIntegrityError, lfsObjectKey, type LfsObjectSpec, verifyingStream } from './lfs.ts'
import { expectOk, type Remote, RemoteError, remoteRequest } from './remote.ts'
import type { RepositoryName } from './repository.ts'
import type { Storage } from './storage.ts'

export type LfsPointer = LfsObjectSpec

export const lfsEndpointFor = (gitUrl: string): string => {
  const base = gitUrl.replace(/\/+$/, '')
  return base.endsWith('.git') ? `${base}/info/lfs` : `${base}.git/info/lfs`
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
  readonly digests?: DigestFactory
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
    await options.storage.put(lfsObjectKey(options.repo, pointer.oid), response.body.pipeThrough(verifyingStream(pointer, options.digests)), pointer.size, {
      ifNoneMatch: '*',
      contentType: 'application/octet-stream',
    })
  } catch (error) {
    if (error instanceof LfsIntegrityError) return { ok: false, reason: error.message }
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
