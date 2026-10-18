import { type Database, sql } from './database.ts'
import { sha256Hex } from './encoding.ts'

export type RateLimit = {
  readonly name: string
  readonly limit: number
  readonly windowMs: number
}

export type RateDecision = {
  readonly allowed: boolean
  readonly estimate: number
  readonly retryAfterSeconds: number
}

export const windowStartOf = (at: number, windowMs: number): number => at - (at % windowMs)

export const slidingWindowDecision = (limit: RateLimit, counts: { readonly previous: number; readonly current: number }, at: number): RateDecision => {
  const start = windowStartOf(at, limit.windowMs)
  const elapsed = (at - start) / limit.windowMs
  const estimate = counts.previous * (1 - elapsed) + counts.current
  if (estimate <= limit.limit) return { allowed: true, estimate, retryAfterSeconds: 0 }
  const remainingMs = counts.current > limit.limit ? start + limit.windowMs - at : Math.ceil(((estimate - limit.limit) / Math.max(counts.previous, 1)) * limit.windowMs)
  return { allowed: false, estimate, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) }
}

const bucketOf = (limit: RateLimit, key: string): Promise<string> => sha256Hex(`git-forge rate limit\n${limit.name}\n${key}`)

export const createRateLimiter = (db: Database, now: () => number = Date.now) => ({
  hit: async (limit: RateLimit, key: string): Promise<RateDecision> => {
    const at = now()
    const start = windowStartOf(at, limit.windowMs)
    const bucket = await bucketOf(limit, key)
    await db.run(
      sql(
        `INSERT INTO rate_limits (bucket, window_start, count, expires_at) VALUES (?, ?, 1, ?)
         ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1`,
        bucket,
        start,
        start + 2 * limit.windowMs,
      ),
    )
    const rows = await db.all<{ window_start: number; count: number }>(
      sql('SELECT window_start, count FROM rate_limits WHERE bucket = ? AND window_start IN (?, ?)', bucket, start, start - limit.windowMs),
    )
    const count = (windowStart: number) => Number(rows.find((row) => Number(row.window_start) === windowStart)?.count ?? 0)
    return slidingWindowDecision(limit, { previous: count(start - limit.windowMs), current: count(start) }, at)
  },

  purge: async (): Promise<number> => (await db.run(sql('DELETE FROM rate_limits WHERE expires_at <= ?', now()))).changes,
})
