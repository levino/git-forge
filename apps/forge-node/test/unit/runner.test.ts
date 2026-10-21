import { applyMigrations, MIGRATIONS } from '@git-forge/accounts'
import { openSqliteDatabase } from '@git-forge/accounts-node'
import { describe, expect, it } from 'vitest'
import { parseCron } from '../../src/cron.ts'
import { createSqliteJobQueue } from '../../src/jobs.ts'
import { runnerSeenAt } from 'forge-worker/jobs'
import { claimDueCrons, startRunner } from '../../src/runner.ts'

const fresh = async () => {
  const { db } = openSqliteDatabase()
  await applyMigrations(db, MIGRATIONS)
  return db
}

const HOURLY = parseCron('0 * * * *')

describe('job runner', () => {
  it('claims a due schedule once, catches up after a pause and records a heartbeat', async () => {
    const db = await fresh()
    const start = Date.UTC(2026, 0, 1, 10, 30)
    expect(await claimDueCrons(db, [{ id: 'sync', schedule: HOURLY }], start, true)).toEqual(['sync'])
    expect(await claimDueCrons(db, [{ id: 'sync', schedule: HOURLY }], start + 1000)).toEqual([])
    expect(await runnerSeenAt(db)).toBe(start)
    expect(await claimDueCrons(db, [{ id: 'sync', schedule: HOURLY }], start + 5 * 3_600_000)).toEqual(['sync'])
    expect(await claimDueCrons(db, [{ id: 'sync', schedule: HOURLY }], start + 5 * 3_600_000 + 1000)).toEqual([])
  })

  it('lets only one of two runners fire a schedule', async () => {
    const db = await fresh()
    const fired: string[] = []
    const crons = (name: string) => [{ id: 'sync', schedule: HOURLY, task: async () => void fired.push(name) }]
    const runners = [startRunner({ db, crons: crons('a'), tickMs: 5 }), startRunner({ db, crons: crons('b'), tickMs: 5 })]
    await new Promise((resolve) => setTimeout(resolve, 50))
    await Promise.all(runners.map((runner) => runner.stop()))
    expect(fired).toHaveLength(1)
  })

  it('never hands one job to two queues', async () => {
    const db = await fresh()
    const runs: string[] = []
    const queues = ['a', 'b'].map((name) =>
      createSqliteJobQueue<{ n: number }>({ db, queue: 'test', concurrency: 4, pollMs: 5, handler: async (job) => void runs.push(`${name}:${job.n}`) }),
    )
    for (let n = 0; n < 40; n++) await queues[0]!.enqueue({ n })
    for (const queue of queues) queue.start()
    await Promise.all(queues.map((queue) => queue.idle()))
    await Promise.all(queues.map((queue) => queue.stop()))
    expect(runs.map((run) => run.split(':')[1]).sort((a, b) => Number(a) - Number(b))).toEqual(Array.from({ length: 40 }, (_, n) => String(n)))
  })
})
