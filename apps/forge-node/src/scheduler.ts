import { type CronSchedule, nextRun } from './cron.ts'

export type Timers = {
  readonly setTimeout: (callback: () => void, ms: number) => unknown
  readonly clearTimeout: (handle: unknown) => void
}

export type SchedulerOptions = {
  readonly schedule: CronSchedule
  readonly task: (at: Date) => Promise<void>
  readonly onError?: (error: unknown, at: Date) => void
  readonly now?: () => Date
  readonly timers?: Timers
}

export type Scheduler = {
  readonly next: () => Date | undefined
  stop(): Promise<void>
}

const MAX_TIMEOUT_MS = 2 ** 31 - 1

const defaultTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export const startScheduler = (options: SchedulerOptions): Scheduler => {
  const now = options.now ?? (() => new Date())
  const timers = options.timers ?? defaultTimers
  let handle: unknown
  let due: Date | undefined
  let running: Promise<void> | undefined
  let stopped = false

  const fire = (at: Date) => {
    if (running) return
    running = options
      .task(at)
      .catch((error: unknown) => options.onError?.(error, at))
      .finally(() => {
        running = undefined
      })
  }

  const arm = () => {
    if (stopped) return
    due ??= nextRun(options.schedule, now())
    const wait = due.getTime() - now().getTime()
    if (wait <= 0) {
      const at = due
      due = undefined
      fire(at)
      arm()
      return
    }
    handle = timers.setTimeout(arm, Math.min(wait, MAX_TIMEOUT_MS))
  }

  arm()
  return {
    next: () => due,
    stop: async () => {
      stopped = true
      timers.clearTimeout(handle)
      await running
    },
  }
}
