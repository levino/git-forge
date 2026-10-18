import { describe, expect, it } from 'vitest'
import { createMemoryJobQueue, PermanentJobError, jobRetryDelaySeconds } from '../src/jobs.ts'

describe('job queue', () => {
  it('backs off exponentially up to an hour', () => {
    expect([1, 2, 3, 4, 10, 20].map((attempt) => jobRetryDelaySeconds(attempt))).toEqual([10, 20, 40, 80, 3600, 3600])
  })

  it('retries failing jobs with backoff until they succeed', async () => {
    const delays: number[] = []
    let calls = 0
    const queue = createMemoryJobQueue<string>(
      async () => {
        calls++
        if (calls < 3) throw new Error('flaky')
      },
      { delayMs: (seconds) => (delays.push(seconds), 0) },
    )
    await queue.enqueue('job')
    await queue.idle()
    expect(calls).toBe(3)
    expect(delays).toEqual([10, 20])
    expect(queue.completed).toEqual(['job'])
  })

  it('gives up after the maximum attempts or on a permanent error', async () => {
    const queue = createMemoryJobQueue<string>(
      async (job) => {
        throw job === 'permanent' ? new PermanentJobError('gone') : new Error('down')
      },
      { maxAttempts: 3, delayMs: () => 0 },
    )
    await queue.enqueue('transient')
    await queue.enqueue('permanent')
    await queue.idle()
    expect(queue.failed).toEqual([
      { job: 'permanent', attempts: 1, error: 'gone' },
      { job: 'transient', attempts: 3, error: 'down' },
    ])
  })
})
