import type { PutBody, PutOptions, PutResult, Storage } from '@git-forge/core'
import { type Database, sql } from './database.ts'
import { randomId } from './encoding.ts'

export type LockedStorageOptions = {
  readonly leaseMs?: number
  readonly waitMs?: number
  readonly now?: () => number
}

export class StorageLockTimeoutError extends Error {}

const conditional = (options: PutOptions | undefined): boolean => options?.ifMatch !== undefined || options?.ifNoneMatch !== undefined

const cancel = async (body: PutBody | ReadableStream<Uint8Array>): Promise<void> => {
  if (!(body instanceof Uint8Array)) await body.cancel().catch(() => undefined)
}

export const lockedStorage = (storage: Storage, db: Database, options: LockedStorageOptions = {}): Storage => {
  const leaseMs = options.leaseMs ?? 30_000
  const waitMs = options.waitMs ?? leaseMs + 5_000
  const now = options.now ?? Date.now

  const acquire = async (key: string, holder: string): Promise<void> => {
    const deadline = now() + waitMs
    for (let delay = 10; ; delay = Math.min(delay * 2, 250)) {
      const at = now()
      const { changes } = await db.run(
        sql(
          'INSERT INTO storage_locks (key, holder, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at WHERE storage_locks.expires_at <= ?',
          key,
          holder,
          at + leaseMs,
          at,
        ),
      )
      if (changes === 1) return
      if (at >= deadline) throw new StorageLockTimeoutError(`timed out waiting for the write lock on ${key}`)
      await new Promise((resolve) => setTimeout(resolve, delay * (0.5 + Math.random())))
    }
  }

  const locked = async <B extends PutBody>(key: string, body: B, putOptions: PutOptions, write: (body: B, options: PutOptions) => Promise<PutResult>): Promise<PutResult> => {
    const holder = randomId()
    await acquire(key, holder).catch(async (error: unknown) => {
      await cancel(body)
      throw error
    })
    const renew = setInterval(() => {
      db.run(sql('UPDATE storage_locks SET expires_at = ? WHERE key = ? AND holder = ?', now() + leaseMs, key, holder)).catch(() => undefined)
    }, leaseMs / 3)
    try {
      const current = await storage.head(key)
      if ((putOptions.ifNoneMatch === '*' && current) || (putOptions.ifMatch !== undefined && current?.etag !== putOptions.ifMatch)) {
        await cancel(body)
        return { ok: false, reason: 'precondition-failed' }
      }
      const { ifMatch: _, ifNoneMatch: __, ...rest } = putOptions
      return await write(body, rest)
    } finally {
      clearInterval(renew)
      await db.run(sql('DELETE FROM storage_locks WHERE key = ? AND holder = ?', key, holder)).catch(() => undefined)
    }
  }

  const wrapped: Storage = {
    get: (key, range) => storage.get(key, range),
    head: (key) => storage.head(key),
    put: (key, body, size, putOptions) =>
      conditional(putOptions) ? locked(key, body, putOptions!, (b, o) => storage.put(key, b, size, o)) : storage.put(key, body, size, putOptions),
    list: (prefix) => storage.list(prefix),
  }
  if (storage.putVerified) {
    const putVerified = storage.putVerified.bind(storage)
    wrapped.putVerified = (key, body, size, sha256Hex, putOptions) =>
      conditional(putOptions) ? locked(key, body, putOptions!, (b, o) => putVerified(key, b, size, sha256Hex, o)) : putVerified(key, body, size, sha256Hex, putOptions)
  }
  if (storage.presignGet) wrapped.presignGet = storage.presignGet.bind(storage)
  if (storage.presignPut) wrapped.presignPut = storage.presignPut.bind(storage)
  return wrapped
}
