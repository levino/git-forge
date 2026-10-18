import { type Database, sql } from '@git-forge/accounts'
import { DEFAULT_MAX_ATTEMPTS, type JobHandler, type JobOutcome, type JobQueue, jobRetryDelaySeconds, PermanentJobError } from '@git-forge/core'

export type SqliteJobQueueOptions<J> = {
  readonly db: Database
  readonly queue: string
  readonly handler: JobHandler<J>
  readonly maxAttempts?: number
  readonly concurrency?: number
  readonly leaseMs?: number
  readonly pollMs?: number
  readonly delayMs?: (seconds: number) => number
  readonly now?: () => number
  readonly onOutcome?: (outcome: JobOutcome<J>) => void
  readonly onError?: (error: unknown) => void
}

export type SqliteJobQueue<J> = JobQueue<J> & {
  start(): void
  idle(): Promise<void>
  stop(graceMs?: number): Promise<void>
  pending(): Promise<number>
}

export const DEFAULT_LEASE_MS = 60_000

export const DEFAULT_POLL_MS = 60_000

type Claimed = { id: string; payload: string; attempts: number }

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const handle = setTimeout(resolve, ms)
    handle.unref?.()
  })

export const createSqliteJobQueue = <J>(options: SqliteJobQueueOptions<J>): SqliteJobQueue<J> => {
  const { db, queue, handler } = options
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const concurrency = options.concurrency ?? 1
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const delayMs = options.delayMs ?? ((seconds: number) => seconds * 1000)
  const now = options.now ?? Date.now
  const report = options.onOutcome ?? (() => undefined)
  const onError = options.onError ?? (() => undefined)
  const running = new Set<Promise<void>>()
  const renewals = new Set<ReturnType<typeof setInterval>>()
  let started = false
  let stopped = false
  let abandoned = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let pumping: Promise<void> | undefined
  let again = false

  const claim = async (): Promise<Claimed | null> => {
    const at = now()
    const rows = await db.all<Claimed>(
      sql(
        'UPDATE jobs SET attempts = attempts + 1, lease_until = ? WHERE id = (SELECT id FROM jobs WHERE queue = ? AND run_at <= ? AND (lease_until IS NULL OR lease_until <= ?) ORDER BY run_at, rowid LIMIT 1) RETURNING id, payload, attempts',
        at + leaseMs,
        queue,
        at,
        at,
      ),
    )
    return rows[0] ?? null
  }

  const remove = (claimed: Claimed) => db.run(sql('DELETE FROM jobs WHERE id = ? AND attempts = ?', claimed.id, claimed.attempts))

  const settle = async (claimed: Claimed, job: J | undefined, error: unknown | undefined): Promise<void> => {
    if (error === undefined) {
      await remove(claimed)
      report({ job: job as J, attempts: claimed.attempts, outcome: 'done' })
      return
    }
    const text = message(error)
    if (job === undefined || error instanceof PermanentJobError || claimed.attempts >= maxAttempts) {
      await remove(claimed)
      report({ job: job as J, attempts: claimed.attempts, outcome: 'failed', error: text })
      return
    }
    await db.run(
      sql(
        'UPDATE jobs SET run_at = ?, lease_until = NULL, last_error = ? WHERE id = ? AND attempts = ?',
        now() + delayMs(jobRetryDelaySeconds(claimed.attempts)),
        text.slice(0, 2000),
        claimed.id,
        claimed.attempts,
      ),
    )
    report({ job, attempts: claimed.attempts, outcome: 'retry', error: text })
  }

  const execute = async (claimed: Claimed): Promise<void> => {
    let job: J | undefined
    try {
      job = JSON.parse(claimed.payload) as J
    } catch (error) {
      await settle(claimed, undefined, error)
      return
    }
    if (claimed.attempts > maxAttempts) {
      await settle(claimed, job, new Error(`gave up after ${maxAttempts} attempts; the last one did not finish`))
      return
    }
    const renewal = setInterval(() => {
      db.run(sql('UPDATE jobs SET lease_until = ? WHERE id = ? AND attempts = ?', now() + leaseMs, claimed.id, claimed.attempts)).catch(onError)
    }, Math.max(1, Math.floor(leaseMs / 3)))
    renewals.add(renewal)
    let failure: unknown
    try {
      await handler(job, claimed.attempts)
    } catch (error) {
      failure = error ?? new Error('job failed')
    } finally {
      clearInterval(renewal)
      renewals.delete(renewal)
    }
    if (abandoned) return
    await settle(claimed, job, failure)
  }

  const launch = (claimed: Claimed) => {
    const promise = execute(claimed)
      .catch(onError)
      .finally(() => {
        running.delete(promise)
        pump()
      })
    running.add(promise)
  }

  const arm = async () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (stopped) return
    const [row] = await db.all<{ next: number | null }>(
      sql('SELECT MIN(CASE WHEN lease_until IS NULL THEN run_at ELSE MAX(run_at, lease_until) END) AS next FROM jobs WHERE queue = ?', queue),
    )
    const wait = row?.next == null ? pollMs : Math.min(pollMs, Math.max(0, Number(row.next) - now()))
    if (stopped) return
    timer = setTimeout(pump, wait)
    timer.unref?.()
  }

  const drain = async () => {
    while (!stopped && running.size < concurrency) {
      const claimed = await claim()
      if (!claimed) break
      launch(claimed)
    }
    if (running.size >= concurrency) {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      return
    }
    await arm()
  }

  const pump = (): void => {
    if (!started || stopped) return
    if (pumping) {
      again = true
      return
    }
    pumping = drain()
      .catch((error: unknown) => {
        onError(error)
        if (!stopped) {
          timer = setTimeout(pump, Math.min(pollMs, 1000))
          timer.unref?.()
        }
      })
      .finally(() => {
        pumping = undefined
        if (again) {
          again = false
          pump()
        }
      })
  }

  const due = async (): Promise<number> => {
    const at = now()
    const [row] = await db.all<{ count: number }>(
      sql('SELECT COUNT(*) AS count FROM jobs WHERE queue = ? AND run_at <= ? AND (lease_until IS NULL OR lease_until <= ?)', queue, at, at),
    )
    return Number(row?.count ?? 0)
  }

  return {
    enqueue: async (job, enqueueOptions = {}) => {
      const at = now()
      await db.run(
        sql(
          'INSERT INTO jobs (id, queue, payload, attempts, run_at, created_at) VALUES (?, ?, ?, 0, ?, ?)',
          crypto.randomUUID(),
          queue,
          JSON.stringify(job),
          at + delayMs(enqueueOptions.delaySeconds ?? 0),
          at,
        ),
      )
      pump()
    },
    start: () => {
      if (started || stopped) return
      started = true
      pump()
    },
    idle: async () => {
      for (;;) {
        await pumping
        if (running.size > 0) {
          await Promise.all([...running])
          continue
        }
        if (stopped || !started || (await due()) === 0) {
          await pumping
          if (running.size === 0) return
          continue
        }
        pump()
        await sleep(5)
      }
    },
    stop: async (graceMs = 10_000) => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      await pumping
      const waited = await Promise.race([Promise.all([...running]).then(() => true), sleep(graceMs).then(() => false)])
      if (!waited) {
        abandoned = true
        for (const renewal of renewals) clearInterval(renewal)
        renewals.clear()
      }
    },
    pending: async () => {
      const [row] = await db.all<{ count: number }>(sql('SELECT COUNT(*) AS count FROM jobs WHERE queue = ?', queue))
      return Number(row?.count ?? 0)
    },
  }
}
