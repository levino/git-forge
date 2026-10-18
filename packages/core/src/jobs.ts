export type EnqueueOptions = {
  readonly delaySeconds?: number
}

export interface JobQueue<J> {
  enqueue(job: J, options?: EnqueueOptions): Promise<void>
}

export type JobHandler<J> = (job: J, attempt: number) => Promise<void>

export class PermanentJobError extends Error {}

export const DEFAULT_MAX_ATTEMPTS = 8

export const jobRetryDelaySeconds = (attempt: number, baseSeconds = 10, maxSeconds = 3600): number =>
  Math.min(maxSeconds, baseSeconds * 2 ** Math.max(0, attempt - 1))

export type JobFailure<J> = {
  readonly job: J
  readonly attempts: number
  readonly error: string
}

export type MemoryJobQueue<J> = JobQueue<J> & {
  idle(): Promise<void>
  readonly completed: readonly J[]
  readonly failed: readonly JobFailure<J>[]
}

export type JobOutcome<J> =
  | { readonly job: J; readonly attempts: number; readonly outcome: 'done' }
  | { readonly job: J; readonly attempts: number; readonly outcome: 'retry' | 'failed'; readonly error: string }

export type MemoryJobQueueOptions<J = unknown> = {
  readonly maxAttempts?: number
  readonly delayMs?: (seconds: number) => number
  readonly concurrency?: number
  readonly keepHistory?: boolean
  readonly onOutcome?: (outcome: JobOutcome<J>) => void
}

export const createMemoryJobQueue = <J>(handler: JobHandler<J>, options: MemoryJobQueueOptions<J> = {}): MemoryJobQueue<J> => {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const delayMs = options.delayMs ?? ((seconds: number) => seconds * 1000)
  const concurrency = options.concurrency ?? Number.POSITIVE_INFINITY
  const keepHistory = options.keepHistory ?? true
  const report = options.onOutcome ?? (() => undefined)
  const completed: J[] = []
  const failed: JobFailure<J>[] = []
  const running = new Set<Promise<void>>()
  const waiting: (() => void)[] = []
  let active = 0
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const slot = async (): Promise<() => void> => {
    if (active >= concurrency) await new Promise<void>((done) => waiting.push(done))
    else active++
    return () => {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
  const attemptOnce = async (job: J, attempt: number): Promise<void> => {
    const release = await slot()
    try {
      await handler(job, attempt)
    } finally {
      release()
    }
  }
  const execute = async (job: J, initialDelaySeconds: number): Promise<void> => {
    if (initialDelaySeconds > 0) await sleep(delayMs(initialDelaySeconds))
    for (let attempt = 1; ; attempt++) {
      try {
        await attemptOnce(job, attempt)
        if (keepHistory) completed.push(job)
        report({ job, attempts: attempt, outcome: 'done' })
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof PermanentJobError || attempt >= maxAttempts) {
          if (keepHistory) failed.push({ job, attempts: attempt, error: message })
          report({ job, attempts: attempt, outcome: 'failed', error: message })
          return
        }
        report({ job, attempts: attempt, outcome: 'retry', error: message })
        await sleep(delayMs(jobRetryDelaySeconds(attempt)))
      }
    }
  }
  return {
    completed,
    failed,
    enqueue: async (job, enqueueOptions = {}) => {
      const promise = execute(job, enqueueOptions.delaySeconds ?? 0).finally(() => running.delete(promise))
      running.add(promise)
    },
    idle: async () => {
      while (running.size > 0) await Promise.all([...running])
    },
  }
}
