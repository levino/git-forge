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

export type MemoryJobQueueOptions = {
  readonly maxAttempts?: number
  readonly delayMs?: (seconds: number) => number
}

export const createMemoryJobQueue = <J>(handler: JobHandler<J>, options: MemoryJobQueueOptions = {}): MemoryJobQueue<J> => {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const delayMs = options.delayMs ?? ((seconds: number) => seconds * 1000)
  const completed: J[] = []
  const failed: JobFailure<J>[] = []
  const running = new Set<Promise<void>>()
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const execute = async (job: J, initialDelaySeconds: number): Promise<void> => {
    if (initialDelaySeconds > 0) await sleep(delayMs(initialDelaySeconds))
    for (let attempt = 1; ; attempt++) {
      try {
        await handler(job, attempt)
        completed.push(job)
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof PermanentJobError || attempt >= maxAttempts) {
          failed.push({ job, attempts: attempt, error: message })
          return
        }
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
