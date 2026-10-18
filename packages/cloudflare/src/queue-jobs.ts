import { DEFAULT_MAX_ATTEMPTS, type EnqueueOptions, type JobHandler, type JobQueue, PermanentJobError, jobRetryDelaySeconds } from '@git-forge/core'

export class QueueJobs<J> implements JobQueue<J> {
  readonly #queue: Queue<J>

  constructor(queue: Queue<J>) {
    this.#queue = queue
  }

  async enqueue(job: J, options: EnqueueOptions = {}): Promise<void> {
    await this.#queue.send(job, options.delaySeconds ? { delaySeconds: Math.min(options.delaySeconds, 24 * 60 * 60) } : {})
  }
}

export type ConsumedJob = {
  readonly id: string
  readonly attempts: number
  readonly outcome: 'done' | 'retry' | 'failed'
  readonly error?: string
}

export const consumeJobs = async <J>(batch: MessageBatch<J>, handler: JobHandler<J>, maxAttempts = DEFAULT_MAX_ATTEMPTS): Promise<ConsumedJob[]> => {
  const outcomes: ConsumedJob[] = []
  for (const message of batch.messages) {
    try {
      await handler(message.body, message.attempts)
      message.ack()
      outcomes.push({ id: message.id, attempts: message.attempts, outcome: 'done' })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      if (error instanceof PermanentJobError || message.attempts >= maxAttempts) {
        message.ack()
        outcomes.push({ id: message.id, attempts: message.attempts, outcome: 'failed', error: text })
      } else {
        message.retry({ delaySeconds: jobRetryDelaySeconds(message.attempts) })
        outcomes.push({ id: message.id, attempts: message.attempts, outcome: 'retry', error: text })
      }
    }
  }
  return outcomes
}
