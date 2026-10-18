import { describe, expect, it } from 'vitest'
import { parseCron } from '../../src/cron.ts'
import { startScheduler, type Timers } from '../../src/scheduler.ts'

const fakeClock = (start: string) => {
  let now = new Date(start).getTime()
  let pending: { at: number; callback: () => void } | undefined
  const timers: Timers = {
    setTimeout: (callback, ms) => (pending = { at: now + ms, callback }),
    clearTimeout: () => (pending = undefined),
  }
  return {
    now: () => new Date(now),
    timers,
    advance: async (ms: number) => {
      const target = now + ms
      while (pending && pending.at <= target) {
        const { at, callback } = pending
        pending = undefined
        now = at
        callback()
        await new Promise((resolve) => setImmediate(resolve))
      }
      now = target
    },
  }
}

describe('scheduler', () => {
  it('runs the task at every matching minute and stops cleanly', async () => {
    const clock = fakeClock('2026-10-18T10:00:30Z')
    const runs: string[] = []
    const scheduler = startScheduler({
      schedule: parseCron('*/30 * * * *'),
      task: async (at) => void runs.push(at.toISOString()),
      now: clock.now,
      timers: clock.timers,
    })
    expect(scheduler.next()?.toISOString()).toBe('2026-10-18T10:30:00.000Z')
    await clock.advance(60 * 60 * 1000)
    expect(runs).toEqual(['2026-10-18T10:30:00.000Z', '2026-10-18T11:00:00.000Z'])
    await scheduler.stop()
    await clock.advance(60 * 60 * 1000)
    expect(runs).toHaveLength(2)
  })

  it('skips a tick while the previous run is still busy and reports errors', async () => {
    const clock = fakeClock('2026-10-18T10:00:30Z')
    const errors: unknown[] = []
    let release: () => void = () => undefined
    let calls = 0
    const scheduler = startScheduler({
      schedule: parseCron('* * * * *'),
      task: async () => {
        calls++
        if (calls === 1) await new Promise<void>((resolve) => (release = resolve))
        else throw new Error('sync failed')
      },
      onError: (error) => errors.push(error),
      now: clock.now,
      timers: clock.timers,
    })
    await clock.advance(3 * 60 * 1000)
    expect(calls).toBe(1)
    release()
    await new Promise((resolve) => setImmediate(resolve))
    await clock.advance(60 * 1000)
    expect(calls).toBe(2)
    expect(errors).toEqual([new Error('sync failed')])
    await scheduler.stop()
  })

  it('waits in steps below the timer limit for distant runs', async () => {
    const clock = fakeClock('2026-01-01T00:00:30Z')
    const runs: string[] = []
    const scheduler = startScheduler({
      schedule: parseCron('0 0 1 3 *'),
      task: async (at) => void runs.push(at.toISOString()),
      now: clock.now,
      timers: clock.timers,
    })
    await clock.advance(70 * 24 * 60 * 60 * 1000)
    expect(runs).toEqual(['2026-03-01T00:00:00.000Z'])
    await scheduler.stop()
  })
})
