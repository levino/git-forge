import { PermanentJobError } from '@git-forge/core'
import { describe, expect, it } from 'vitest'
import { consumeJobs, QueueJobs } from '../src/queue-jobs.ts'

type Recorded = { acked: boolean; retried?: number }

const message = (id: string, body: string, attempts: number, record: Recorded): Message<string> =>
  ({
    id,
    body,
    attempts,
    timestamp: new Date(),
    ack: () => (record.acked = true),
    retry: (options?: { delaySeconds?: number }) => (record.retried = options?.delaySeconds ?? 0),
  }) as unknown as Message<string>

describe('Queue job adapter', () => {
  it('acks successes, retries failures with backoff and drops permanent or exhausted ones', async () => {
    const records: Recorded[] = [{ acked: false }, { acked: false }, { acked: false }, { acked: false }]
    const batch = {
      queue: 'jobs',
      messages: [message('1', 'ok', 1, records[0]!), message('2', 'flaky', 3, records[1]!), message('3', 'gone', 1, records[2]!), message('4', 'flaky', 8, records[3]!)],
    } as unknown as MessageBatch<string>
    const outcomes = await consumeJobs(batch, async (job) => {
      if (job === 'flaky') throw new Error('upstream down')
      if (job === 'gone') throw new PermanentJobError('subscription gone')
    })
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['done', 'retry', 'failed', 'failed'])
    expect(records).toEqual([{ acked: true }, { acked: false, retried: 40 }, { acked: true }, { acked: true }])
  })

  it('sends jobs with an optional delay', async () => {
    const sent: unknown[] = []
    const queue = { send: async (body: unknown, options: unknown) => void sent.push([body, options]) } as unknown as Queue<string>
    await new QueueJobs(queue).enqueue('a')
    await new QueueJobs(queue).enqueue('b', { delaySeconds: 99_999 })
    expect(sent).toEqual([
      ['a', {}],
      ['b', { delaySeconds: 86_400 }],
    ])
  })
})
