import { type Database, first, sql } from '@git-forge/accounts'
import { repositoryPrefix } from '@git-forge/core'
import { type BlobRow, createBlob, getBlob } from './blobs.ts'

export type CacheEntryRow = {
  readonly id: number
  readonly owner: string
  readonly repo: string
  readonly scope: string
  readonly key: string
  readonly version: string
  readonly blob_id: string
  readonly job_id: string | null
  readonly size: number | null
  readonly created_at: number
  readonly finalized_at: number | null
  readonly last_accessed_at: number
  readonly evicted_at: number | null
}

export type CacheLimits = {
  readonly repositoryBytes: number
  readonly entryBytes: number
  readonly unusedDays: number
  readonly maxDays: number
  readonly reservationHours: number
}

export const DEFAULT_CACHE_LIMITS: CacheLimits = {
  repositoryBytes: 10 * 1024 ** 3,
  entryBytes: 10 * 1024 ** 3,
  unusedDays: 7,
  maxDays: 30,
  reservationHours: 6,
}

export const MAX_CACHE_KEY_LENGTH = 512

export const MAX_CACHE_KEYS = 10

const DAY_MS = 24 * 60 * 60 * 1000

export type CacheScopeInput = {
  readonly ref: string
  readonly baseRef: string | null
  readonly defaultBranch: string | null
}

export const cacheScopes = (input: CacheScopeInput): string[] => {
  const base = input.baseRef ? (input.baseRef.startsWith('refs/') ? input.baseRef : `refs/heads/${input.baseRef}`) : null
  return [...new Set([input.ref, base, input.defaultBranch].filter((scope): scope is string => typeof scope === 'string' && scope.length > 0))]
}

export const validCacheKey = (key: string): boolean => key.length > 0 && key.length <= MAX_CACHE_KEY_LENGTH && !key.includes(',')

export const validCacheVersion = (version: string): boolean => /^[A-Za-z0-9._-]{1,512}$/.test(version)

export type CacheCandidate = Pick<CacheEntryRow, 'id' | 'scope' | 'key' | 'created_at'>

export const matchCacheEntry = <T extends CacheCandidate>(candidates: readonly T[], scopes: readonly string[], primaryKey: string, restoreKeys: readonly string[]): T | null => {
  const newest = (matches: readonly T[]): T | null => matches.reduce<T | null>((best, entry) => (best === null || entry.created_at > best.created_at || (entry.created_at === best.created_at && entry.id > best.id) ? entry : best), null)
  for (const scope of scopes) {
    const inScope = candidates.filter((entry) => entry.scope === scope)
    const exact = newest(inScope.filter((entry) => entry.key === primaryKey))
    if (exact) return exact
    for (const restoreKey of restoreKeys) {
      const exactRestore = newest(inScope.filter((entry) => entry.key === restoreKey))
      if (exactRestore) return exactRestore
      const prefixed = newest(inScope.filter((entry) => entry.key.startsWith(restoreKey)))
      if (prefixed) return prefixed
    }
  }
  return null
}

export type LruEntry = Pick<CacheEntryRow, 'id' | 'size' | 'last_accessed_at'>

export const entriesOverQuota = <T extends LruEntry>(entries: readonly T[], limitBytes: number): T[] => {
  let total = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0)
  const evicted: T[] = []
  for (const entry of [...entries].sort((a, b) => a.last_accessed_at - b.last_accessed_at || a.id - b.id)) {
    if (total <= limitBytes) break
    evicted.push(entry)
    total -= entry.size ?? 0
  }
  return evicted
}

export const cachePrefix = (owner: string, repo: string): string => `${repositoryPrefix({ owner, name: repo })}actions/caches/`

export type CacheReservation = {
  readonly owner: string
  readonly repo: string
  readonly scope: string
  readonly key: string
  readonly version: string
  readonly jobId: string
}

export const getCacheEntry = async (db: Database, id: number): Promise<CacheEntryRow | null> => first<CacheEntryRow>(db, sql('SELECT * FROM actions_caches WHERE id = ?', id))

const activeEntry = async (db: Database, reservation: CacheReservation): Promise<CacheEntryRow | null> =>
  first<CacheEntryRow>(
    db,
    sql(
      'SELECT * FROM actions_caches WHERE owner = ? AND repo = ? AND scope = ? AND key = ? AND version = ? AND evicted_at IS NULL',
      reservation.owner,
      reservation.repo,
      reservation.scope,
      reservation.key,
      reservation.version,
    ),
  )

const jobFinished = async (db: Database, jobId: string | null): Promise<boolean> =>
  jobId === null || (await first<{ status: string }>(db, sql('SELECT status FROM actions_jobs WHERE id = ?', jobId)))?.status !== 'in_progress'

export const reserveCache = async (
  db: Database,
  reservation: CacheReservation,
  now: number,
  limits: CacheLimits = DEFAULT_CACHE_LIMITS,
): Promise<{ readonly entry: CacheEntryRow; readonly blob: BlobRow } | null> => {
  const existing = await activeEntry(db, reservation)
  if (existing) {
    const stale = existing.finalized_at === null && existing.job_id !== reservation.jobId && (existing.created_at < now - limits.reservationHours * 3_600_000 || (await jobFinished(db, existing.job_id)))
    if (!stale) return null
    await evictCacheEntries(db, [existing.id], now)
  }
  const blob = await createBlob(db, { owner: reservation.owner, repo: reservation.repo, prefix: cachePrefix(reservation.owner, reservation.repo), contentType: 'application/octet-stream' }, now)
  try {
    const [row] = await db.all<CacheEntryRow>(
      sql(
        'INSERT INTO actions_caches (owner, repo, scope, key, version, blob_id, job_id, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
        reservation.owner,
        reservation.repo,
        reservation.scope,
        reservation.key,
        reservation.version,
        blob.id,
        reservation.jobId,
        now,
        now,
      ),
    )
    return { entry: row!, blob }
  } catch (error) {
    if (/UNIQUE|constraint/i.test(String((error as Error)?.message ?? error))) return null
    throw error
  }
}

export const finalizeCache = async (db: Database, entry: CacheEntryRow, size: number, now: number): Promise<boolean> =>
  (await db.run(sql('UPDATE actions_caches SET size = ?, finalized_at = ?, last_accessed_at = ? WHERE id = ? AND finalized_at IS NULL AND evicted_at IS NULL', size, now, now, entry.id))).changes === 1

export const uploadingCacheFor = async (db: Database, reservation: Omit<CacheReservation, 'scope'>): Promise<CacheEntryRow | null> =>
  first<CacheEntryRow>(
    db,
    sql(
      'SELECT * FROM actions_caches WHERE owner = ? AND repo = ? AND key = ? AND version = ? AND job_id = ? AND finalized_at IS NULL AND evicted_at IS NULL ORDER BY id DESC LIMIT 1',
      reservation.owner,
      reservation.repo,
      reservation.key,
      reservation.version,
      reservation.jobId,
    ),
  )

export type CacheLookup = {
  readonly owner: string
  readonly repo: string
  readonly version: string
  readonly scopes: readonly string[]
  readonly primaryKey: string
  readonly restoreKeys: readonly string[]
}

const LOOKUP_LIMIT = 500

export const findCache = async (db: Database, lookup: CacheLookup, now: number): Promise<CacheEntryRow | null> => {
  if (lookup.scopes.length === 0) return null
  const keys = [lookup.primaryKey, ...lookup.restoreKeys]
  const candidates = await db.all<CacheEntryRow>(
    sql(
      `SELECT * FROM actions_caches WHERE owner = ? AND repo = ? AND version = ? AND evicted_at IS NULL AND finalized_at IS NOT NULL AND scope IN (${lookup.scopes.map(() => '?').join(', ')}) AND (${keys.map(() => 'substr(key, 1, ?) = ?').join(' OR ')}) ORDER BY created_at DESC LIMIT ?`,
      lookup.owner,
      lookup.repo,
      lookup.version,
      ...lookup.scopes,
      ...keys.flatMap((key) => [key.length, key]),
      LOOKUP_LIMIT,
    ),
  )
  const match = matchCacheEntry(candidates, lookup.scopes, lookup.primaryKey, lookup.restoreKeys)
  if (match) await db.run(sql('UPDATE actions_caches SET last_accessed_at = ? WHERE id = ?', now, match.id))
  return match
}

export const cacheBlob = async (db: Database, entry: CacheEntryRow): Promise<BlobRow | null> => getBlob(db, entry.blob_id)

export const listCaches = async (db: Database, owner: string, repo: string, filter: { readonly key?: string; readonly ref?: string } = {}, limit = 100): Promise<CacheEntryRow[]> =>
  db.all<CacheEntryRow>(
    sql(
      'SELECT * FROM actions_caches WHERE owner = ? AND repo = ? AND evicted_at IS NULL AND finalized_at IS NOT NULL AND (? IS NULL OR substr(key, 1, length(?)) = ?) AND (? IS NULL OR scope = ?) ORDER BY last_accessed_at DESC LIMIT ?',
      owner,
      repo,
      filter.key ?? null,
      filter.key ?? null,
      filter.key ?? null,
      filter.ref ?? null,
      filter.ref ?? null,
      limit,
    ),
  )

export const cacheUsage = async (db: Database, owner: string, repo: string): Promise<{ readonly count: number; readonly bytes: number }> => {
  const row = await first<{ count: number; bytes: number | null }>(
    db,
    sql('SELECT COUNT(*) AS count, SUM(size) AS bytes FROM actions_caches WHERE owner = ? AND repo = ? AND evicted_at IS NULL AND finalized_at IS NOT NULL', owner, repo),
  )
  return { count: row?.count ?? 0, bytes: row?.bytes ?? 0 }
}

export const evictCacheEntries = async (db: Database, ids: readonly number[], now: number): Promise<number> => {
  let evicted = 0
  for (const id of ids) evicted += (await db.run(sql('UPDATE actions_caches SET evicted_at = ? WHERE id = ? AND evicted_at IS NULL', now, id))).changes
  return evicted
}

export const evictCaches = async (db: Database, now: number, limits: CacheLimits = DEFAULT_CACHE_LIMITS): Promise<number> => {
  let evicted = (
    await db.run(
      sql(
        'UPDATE actions_caches SET evicted_at = ? WHERE evicted_at IS NULL AND (last_accessed_at < ? OR created_at < ? OR (finalized_at IS NULL AND created_at < ?))',
        now,
        now - limits.unusedDays * DAY_MS,
        now - limits.maxDays * DAY_MS,
        now - limits.reservationHours * 3_600_000,
      ),
    )
  ).changes
  const repositories = await db.all<{ owner: string; repo: string }>(
    sql('SELECT owner, repo FROM actions_caches WHERE evicted_at IS NULL AND finalized_at IS NOT NULL GROUP BY owner, repo HAVING SUM(size) > ?', limits.repositoryBytes),
  )
  for (const { owner, repo } of repositories) {
    const entries = await db.all<LruEntry>(sql('SELECT id, size, last_accessed_at FROM actions_caches WHERE owner = ? AND repo = ? AND evicted_at IS NULL AND finalized_at IS NOT NULL', owner, repo))
    evicted += await evictCacheEntries(
      db,
      entriesOverQuota(entries, limits.repositoryBytes).map((entry) => entry.id),
      now,
    )
  }
  return evicted
}
