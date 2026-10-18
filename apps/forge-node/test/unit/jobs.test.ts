import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations, type Database, MIGRATIONS, type Row, type Statement, sql } from '@git-forge/accounts'
import { type JobOutcome, PermanentJobError } from '@git-forge/core'
import { afterAll, describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/instance.ts'
import { createSqliteJobQueue, type SqliteJobQueueOptions } from '../../src/jobs.ts'

const root = mkdtempSync(join(tmpdir(), 'git-forge-jobs-'))
let counter = 0

afterAll(() => rm(root, { recursive: true, force: true }))

const database = async () => {
  const path = join(root, `jobs-${++counter}.sqlite`)
  const opened = await openDatabase(path)
  await applyMigrations(opened.db, MIGRATIONS)
  return { ...opened, path }
}

const reopen = (path: string) => openDatabase(path)

const waitFor = async (check: () => boolean | Promise<boolean>, timeoutMs = 5000) => {
  const until = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > until) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

type Job = { readonly n: number }

const queue = (db: Database, handler: SqliteJobQueueOptions<Job>['handler'], options: Partial<SqliteJobQueueOptions<Job>> = {}) => {
  const outcomes: JobOutcome<Job>[] = []
  const jobs = createSqliteJobQueue<Job>({ db, queue: 'test', handler, delayMs: (seconds) => seconds, onOutcome: (outcome) => outcomes.push(outcome), ...options })
  return { jobs, outcomes }
}

describe('SQLite job queue', () => {
  it('runs jobs in order of due time, honours delays and deletes finished jobs', async () => {
    const { db, handle } = await database()
    const ran: number[] = []
    const { jobs, outcomes } = queue(db, async (job) => void ran.push(job.n))
    jobs.start()
    await jobs.enqueue({ n: 1 }, { delaySeconds: 40 })
    await jobs.enqueue({ n: 2 })
    await waitFor(() => ran.length === 2)
    expect(ran).toEqual([2, 1])
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['done', 'done'])
    expect(await jobs.pending()).toBe(0)
    await jobs.stop()
    handle.close()
  })

  it('keeps queued and delayed jobs across a restart', async () => {
    const { db, handle, path } = await database()
    const before = queue(db, async () => undefined)
    await before.jobs.enqueue({ n: 1 })
    await before.jobs.enqueue({ n: 2 }, { delaySeconds: 30 })
    await before.jobs.stop()
    handle.close()
    const reopened = await reopen(path)
    const ran: number[] = []
    const after = queue(reopened.db, async (job) => void ran.push(job.n))
    expect(await after.jobs.pending()).toBe(2)
    after.jobs.start()
    await waitFor(() => ran.length === 2)
    expect(ran).toEqual([1, 2])
    await after.jobs.stop()
    reopened.handle.close()
  })

  it('retries with backoff, stops at maxAttempts and on PermanentJobError', async () => {
    const { db, handle } = await database()
    const attempts: [number, number][] = []
    const { jobs, outcomes } = queue(
      db,
      async (job, attempt) => {
        attempts.push([job.n, attempt])
        if (job.n === 1 && attempt < 3) throw new Error(`flaky ${attempt}`)
        if (job.n === 2) throw new Error('always')
        if (job.n === 3) throw new PermanentJobError('never')
      },
      { maxAttempts: 4 },
    )
    jobs.start()
    await jobs.enqueue({ n: 1 })
    await jobs.enqueue({ n: 2 })
    await jobs.enqueue({ n: 3 })
    await waitFor(() => outcomes.filter((outcome) => outcome.outcome !== 'retry').length === 3)
    const final = (n: number) => outcomes.find((outcome) => outcome.job.n === n && outcome.outcome !== 'retry')
    expect(final(1)).toEqual({ job: { n: 1 }, attempts: 3, outcome: 'done' })
    expect(final(2)).toEqual({ job: { n: 2 }, attempts: 4, outcome: 'failed', error: 'always' })
    expect(final(3)).toEqual({ job: { n: 3 }, attempts: 1, outcome: 'failed', error: 'never' })
    expect(outcomes.filter((outcome) => outcome.job.n === 1 && outcome.outcome === 'retry').map((outcome) => 'error' in outcome && outcome.error)).toEqual(['flaky 1', 'flaky 2'])
    expect(await jobs.pending()).toBe(0)
    await jobs.stop()
    handle.close()
  })

  it('schedules a retry with jobRetryDelaySeconds and records the error', async () => {
    const { db, handle } = await database()
    const now = 1_000_000
    const { jobs } = queue(
      db,
      async () => {
        throw new Error('down')
      },
      { now: () => now, delayMs: (seconds) => seconds * 1000 },
    )
    jobs.start()
    await jobs.enqueue({ n: 1 })
    await jobs.idle()
    const [row] = await db.all<{ attempts: number; run_at: number; lease_until: number | null; last_error: string }>(sql('SELECT attempts, run_at, lease_until, last_error FROM jobs'))
    expect(row).toEqual({ attempts: 1, run_at: now + 10_000, lease_until: null, last_error: 'down' })
    await jobs.stop()
    handle.close()
  })

  it('re-runs a job whose lease expired because the process died', async () => {
    const { db, handle } = await database()
    const started: number[] = []
    const crashed = queue(db, async (_job, attempt) => {
      started.push(attempt)
      await new Promise(() => undefined)
    }, { leaseMs: 60 })
    crashed.jobs.start()
    await crashed.jobs.enqueue({ n: 1 })
    await waitFor(() => started.length === 1)
    await crashed.jobs.stop(0)
    const [leased] = await db.all<{ lease_until: number }>(sql('SELECT lease_until FROM jobs'))
    expect(leased!.lease_until).toBeGreaterThan(Date.now())
    const attempts: number[] = []
    const recovered = queue(db, async (_job, attempt) => void attempts.push(attempt), { leaseMs: 60 })
    recovered.jobs.start()
    await waitFor(() => attempts.length === 1)
    expect(attempts).toEqual([2])
    expect(started).toEqual([1])
    await waitFor(async () => (await recovered.jobs.pending()) === 0)
    await recovered.jobs.stop()
    handle.close()
  })

  it('renews the lease of a long job so it is not run twice', async () => {
    const { db, handle } = await database()
    let release!: () => void
    const runs: number[] = []
    const first = queue(db, async (_job, attempt) => {
      runs.push(attempt)
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }, { leaseMs: 30 })
    const second = queue(db, async (_job, attempt) => void runs.push(attempt), { leaseMs: 30 })
    first.jobs.start()
    await first.jobs.enqueue({ n: 1 })
    await waitFor(() => runs.length === 1)
    second.jobs.start()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(runs).toEqual([1])
    release()
    await first.jobs.idle()
    expect(first.outcomes).toEqual([{ job: { n: 1 }, attempts: 1, outcome: 'done' }])
    expect(await first.jobs.pending()).toBe(0)
    await Promise.all([first.jobs.stop(), second.jobs.stop()])
    handle.close()
  })

  it('gives up on a job that crashed the process on its last attempt', async () => {
    const { db, handle } = await database()
    await db.run(sql("INSERT INTO jobs (id, queue, payload, attempts, run_at, lease_until, created_at) VALUES ('j', 'test', '{\"n\":1}', 2, 0, 1, 0)"))
    const ran: number[] = []
    const { jobs, outcomes } = queue(db, async (job) => void ran.push(job.n), { maxAttempts: 2 })
    jobs.start()
    await waitFor(() => outcomes.length === 1)
    expect(ran).toEqual([])
    expect(outcomes[0]).toMatchObject({ job: { n: 1 }, attempts: 3, outcome: 'failed' })
    expect(await jobs.pending()).toBe(0)
    await jobs.stop()
    handle.close()
  })

  it('waits instead of polling while all slots are busy', async () => {
    const { db, handle } = await database()
    let queries = 0
    const counting: Database = { ...db, all: <T extends Row>(statement: Statement) => (queries++, db.all<T>(statement)) }
    let release!: () => void
    const { jobs } = queue(counting, (job) => (job.n === 1 ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve()))
    jobs.start()
    await jobs.enqueue({ n: 1 })
    await waitFor(() => release !== undefined)
    await jobs.enqueue({ n: 2 })
    const before = queries
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(queries - before).toBeLessThan(5)
    release()
    await jobs.idle()
    expect(await jobs.pending()).toBe(0)
    await jobs.stop()
    handle.close()
  })

  it('limits concurrency and keeps queues apart', async () => {
    const { db, handle } = await database()
    let active = 0
    let peak = 0
    const { jobs } = queue(
      db,
      async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 10))
        active--
      },
      { concurrency: 2 },
    )
    const other = createSqliteJobQueue<Job>({ db, queue: 'other', handler: async () => undefined })
    await other.enqueue({ n: 0 })
    jobs.start()
    for (let n = 0; n < 6; n++) await jobs.enqueue({ n })
    await jobs.idle()
    expect(peak).toBe(2)
    expect(await jobs.pending()).toBe(0)
    expect(await other.pending()).toBe(1)
    await jobs.stop()
    handle.close()
  })
})
