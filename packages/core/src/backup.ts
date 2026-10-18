import { toHex } from './bytes.ts'
import type { DigestFactory } from './digest.ts'
import { hashStream } from './lfs.ts'
import type { ObjectInfo, Storage } from './storage.ts'

export type BackupEntry = { readonly key: string; readonly target: string; readonly etag: string; readonly size: number; readonly sha256: string }

export type BackupLedger = {
  readonly etags: (keys: readonly string[]) => Promise<ReadonlyMap<string, string>>
  readonly record: (entry: BackupEntry) => Promise<void>
}

export type CopyBudget = { readonly maxBytes: number; readonly maxKeys: number }

export type CopyOptions = {
  readonly after: string
  readonly skip: (key: string) => boolean
  readonly rewritten: (key: string) => string
  readonly budget: CopyBudget
  readonly digests: DigestFactory
}

export type CopyProgress = { readonly cursor: string | null; readonly objects: number; readonly bytes: number }

export class BackupVerificationError extends Error {}

const LOOKUP_BATCH = 50

export const copyVerified = async (source: Storage, target: Storage, key: string, targetKey: string, digests: DigestFactory): Promise<BackupEntry | null> => {
  const object = await source.get(key)
  if (!object) return null
  const digest = digests('SHA-256')
  const body = object.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        digest.update(chunk)
        controller.enqueue(chunk)
      },
    }),
  )
  await target.put(targetKey, body, object.size)
  const sha256 = toHex(await digest.digest())
  const copy = await target.get(targetKey)
  if (!copy || copy.size !== object.size || (await hashStream(copy.body, digests)).oid !== sha256) throw new BackupVerificationError(`${targetKey}: the copy does not match ${key}`)
  return { key, target: targetKey, etag: object.etag, size: object.size, sha256 }
}

export const copyOnce = async (source: Storage, target: Storage, key: string, targetKey: string, digests: DigestFactory): Promise<BackupEntry | 'conflict' | null> => {
  const existing = await target.get(targetKey)
  if (!existing) return copyVerified(source, target, key, targetKey, digests)
  const object = await source.get(key)
  if (!object) return null
  const [stored, sha256] = await Promise.all([hashStream(existing.body, digests), hashStream(object.body, digests)])
  return stored.oid === sha256.oid && existing.size === object.size ? { key, target: targetKey, etag: object.etag, size: object.size, sha256: sha256.oid } : 'conflict'
}

export const copyObjects = async (source: Storage, target: Storage, ledger: BackupLedger, options: CopyOptions): Promise<CopyProgress> => {
  let cursor = options.after
  let objects = 0
  let bytes = 0
  let seen = 0
  let batch: ObjectInfo[] = []
  const flush = async (): Promise<boolean> => {
    const known = batch.length > 0 ? await ledger.etags(batch.map((info) => info.key)) : new Map<string, string>()
    for (const info of batch) {
      const etag = known.get(info.key)
      if (etag !== info.etag) {
        const plain = etag === undefined ? await copyOnce(source, target, info.key, info.key, options.digests) : 'conflict'
        const entry = plain === 'conflict' ? await copyOnce(source, target, info.key, options.rewritten(info.key), options.digests) : plain
        if (entry && entry !== 'conflict') {
          await ledger.record(entry)
          objects++
          bytes += entry.size
        }
      }
      cursor = info.key
      if (bytes >= options.budget.maxBytes) return true
    }
    batch = []
    return seen >= options.budget.maxKeys
  }
  for await (const info of source.list('')) {
    if (info.key <= options.after || options.skip(info.key)) continue
    batch.push(info)
    seen++
    if ((batch.length >= LOOKUP_BATCH || seen >= options.budget.maxKeys) && (await flush())) return { cursor, objects, bytes }
  }
  return { cursor: (await flush()) ? cursor : null, objects, bytes }
}

export const memoryLedger = (): BackupLedger & { readonly entries: Map<string, BackupEntry> } => {
  const entries = new Map<string, BackupEntry>()
  return {
    entries,
    etags: async (keys) => new Map(keys.flatMap((key) => (entries.has(key) ? [[key, entries.get(key)!.etag] as const] : []))),
    record: async (entry) => void entries.set(entry.key, entry),
  }
}

export const verifyEntries = async (target: Storage, entries: readonly BackupEntry[], digests: DigestFactory): Promise<string[]> => {
  const failures: string[] = []
  for (const entry of entries) {
    const object = await target.get(entry.target)
    if (!object) failures.push(`${entry.target}: missing`)
    else if (object.size !== entry.size) failures.push(`${entry.target}: size ${object.size}, expected ${entry.size}`)
    else if ((await hashStream(object.body, digests)).oid !== entry.sha256) failures.push(`${entry.target}: SHA-256 mismatch`)
  }
  return failures
}
