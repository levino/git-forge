import type { StateCache, StateEntry } from '@git-forge/core'
import { type Database, sql } from './database.ts'

export const STATE_PENDING_MS = 60_000

type StateRow = { key: string; version: number; hit: number; etag: string | null; body: string | null }

export const createStateCache = (db: Database, now: () => number = Date.now): StateCache => ({
  get: async (keys) => {
    const found = new Map<string, StateEntry>()
    for (let i = 0; i < keys.length; i += 50) {
      const chunk = keys.slice(i, i + 50)
      const rows = await db.all<StateRow>(
        sql(`SELECT key, version, token IS NULL AND cached = 1 AS hit, etag, body FROM storage_state WHERE key IN (${chunk.map(() => '?').join(', ')})`, ...chunk),
      )
      for (const row of rows) found.set(row.key, { version: row.version, hit: row.hit === 1, value: row.etag === null ? null : { etag: row.etag, text: row.body ?? '' } })
    }
    return found
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
    const mine = 'CASE WHEN token = ?1 THEN'
    await db.run(
      sql(
        `UPDATE storage_state SET version = version + 1, cached = ${mine} 1 ELSE 0 END, etag = ${mine} ?2 END, body = ${mine} ?3 END, pending_at = ${mine} NULL ELSE pending_at END, token = ${mine} NULL ELSE token END WHERE key = ?4 AND (token = ?1 OR token IS NULL)`,
        token,
        value?.etag ?? null,
        value?.text ?? null,
        key,
      ),
    )
  },
  abort: async (key, token) => {
    await db.run(sql('UPDATE storage_state SET version = version + 1, token = NULL, pending_at = NULL, cached = 0, etag = NULL, body = NULL WHERE key = ? AND token = ?', key, token))
  },
})
