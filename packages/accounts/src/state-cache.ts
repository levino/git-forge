import type { StateCache, StateEntry, StateValue } from '@git-forge/core'
import { type LockedStorageOptions, StorageLockTimeoutError } from './locked-storage.ts'
import { type Database, reused, sql } from './database.ts'

export const STATE_PENDING_MS = 60_000

type StateRow = { key: string; version: number; hit: number; etag: string | null; body: string | null }

const STATE_SELECT = 'SELECT key, version, token IS NULL AND cached = 1 AS hit, etag, body FROM storage_state WHERE key = ?'

const entryOf = (row: StateRow): StateEntry => ({ version: row.version, hit: row.hit === 1, value: row.etag === null ? null : { etag: row.etag, text: row.body ?? '' } })

const commitStatement = (key: string, token: string, value: StateValue) => {
  const mine = 'CASE WHEN token = ?1 THEN'
  return sql(
    `UPDATE storage_state SET version = version + 1, cached = ${mine} 1 ELSE 0 END, etag = ${mine} ?2 END, body = ${mine} ?3 END, pending_at = ${mine} NULL ELSE pending_at END, token = ${mine} NULL ELSE token END WHERE key = ?4 AND (token = ?1 OR token IS NULL)`,
    token,
    value?.etag ?? null,
    value?.text ?? null,
    key,
  )
}

const abortStatement = (key: string, token: string) =>
  sql('UPDATE storage_state SET version = version + 1, token = NULL, pending_at = NULL, cached = 0, etag = NULL, body = NULL WHERE key = ? AND token = ?', key, token)

export type StateCacheOptions = { readonly now?: () => number; readonly locks?: LockedStorageOptions }

export const createStateCache = (db: Database, options: StateCacheOptions = {}): StateCache => {
  const now = options.now ?? Date.now
  const cache: StateCache = {
    get: async (keys) => {
      const rows = await db.read(keys.map((key) => reused(sql(STATE_SELECT, key))))
      return new Map((rows.flat() as StateRow[]).map((row) => [row.key, entryOf(row)]))
    },
    fill: async (key, value, version) => {
      await db.run(
        version === null
          ? sql('INSERT INTO storage_state (key, version, cached, etag, body) VALUES (?, 1, 1, ?, ?) ON CONFLICT (key) DO NOTHING', key, value?.etag ?? null, value?.text ?? null)
          : sql(
              'UPDATE storage_state SET version = version + 1, token = NULL, pending_at = NULL, cached = 1, etag = ?, body = ? WHERE key = ? AND version = ? AND (token IS NULL OR pending_at < ?)',
              value?.etag ?? null,
              value?.text ?? null,
              key,
              version,
              now() - STATE_PENDING_MS,
            ),
      )
    },
    begin: async (key, token) => {
      await db.run(
        sql(
          'INSERT INTO storage_state (key, version, token, pending_at, cached) VALUES (?, 1, ?, ?, 0) ON CONFLICT (key) DO UPDATE SET version = version + 1, token = excluded.token, pending_at = excluded.pending_at, cached = 0, etag = NULL, body = NULL',
          key,
          token,
          now(),
        ),
      )
    },
    commit: async (key, token, value) => {
      await db.run(commitStatement(key, token, value))
    },
    abort: async (key, token) => {
      await db.run(abortStatement(key, token))
    },
  }
  const locks = options.locks
  if (!locks) return cache
  const leaseMs = locks.leaseMs ?? 30_000
  const waitMs = locks.waitMs ?? leaseMs + 5_000
  return {
    ...cache,
    lock: async (key, token) => {
      const deadline = now() + waitMs
      for (let delay = 10; ; delay = Math.min(delay * 2, 250)) {
        const at = now()
        const [acquired, state] = await db.batch([
          sql(
            'INSERT INTO storage_locks (key, holder, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at WHERE storage_locks.expires_at <= ?',
            key,
            token,
            at + leaseMs,
            at,
          ),
          sql(STATE_SELECT, key),
          sql(
            'INSERT INTO storage_state (key, version, token, pending_at, cached) SELECT ?, 1, ?, ?, 0 WHERE EXISTS (SELECT 1 FROM storage_locks WHERE key = ? AND holder = ?) ON CONFLICT (key) DO UPDATE SET version = version + 1, token = excluded.token, pending_at = excluded.pending_at, cached = 0, etag = NULL, body = NULL',
            key,
            token,
            at,
            key,
            token,
          ),
        ])
        if (acquired?.changes === 1) {
          const row = state?.rows[0] as StateRow | undefined
          return row ? entryOf(row) : undefined
        }
        if (at >= deadline) throw new StorageLockTimeoutError(`timed out waiting for the write lock on ${key}`)
        await new Promise((resolve) => setTimeout(resolve, delay * (0.5 + Math.random())))
      }
    },
    release: async (key, token, value) => {
      await db.batch([value === undefined ? abortStatement(key, token) : commitStatement(key, token, value), sql('DELETE FROM storage_locks WHERE key = ? AND holder = ?', key, token)])
    },
  }
}
