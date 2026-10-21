import { type Database, sql } from '@git-forge/accounts'
import { runnerHeartbeat } from 'forge-worker/jobs'
import { type CronSchedule, nextRun } from './cron.ts'

export type Cron = { readonly id: string; readonly schedule: CronSchedule; readonly task: (at: Date) => Promise<void> }

export const RUNNER_TICK_MS = 60_000

export const claimDueCrons = async (db: Database, crons: readonly Pick<Cron, 'id' | 'schedule'>[], at: number, heartbeat = false): Promise<string[]> => {
  const results = await db.batch([
    ...crons.flatMap((cron) => [
      sql("INSERT OR IGNORE INTO jobs (id, queue, payload, attempts, run_at, created_at) VALUES (?, 'cron', '{}', 0, ?, ?)", `cron:${cron.id}`, at, at),
      sql("UPDATE jobs SET run_at = ?, payload = json_object('ranAt', ?) WHERE id = ? AND queue = 'cron' AND run_at <= ?", nextRun(cron.schedule, new Date(at)).getTime(), at, `cron:${cron.id}`, at),
    ]),
    ...(heartbeat ? [runnerHeartbeat(at)] : []),
  ])
  return crons.filter((_, i) => (results[i * 2 + 1]?.changes ?? 0) > 0).map((cron) => cron.id)
}

export type Runner = { stop(): Promise<void> }

export type RunnerOptions = {
  readonly db: Database
  readonly crons: readonly Cron[]
  readonly tickMs?: number
  readonly now?: () => number
  readonly onError?: (error: unknown, cron: string | null) => void
}

export const startRunner = (options: RunnerOptions): Runner => {
  const now = options.now ?? Date.now
  const running = new Set<Promise<void>>()
  const busy = new Set<string>()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    const at = now()
    const due: string[] = await claimDueCrons(options.db, options.crons, at, true).catch((error: unknown) => (options.onError?.(error, null), []))
    for (const cron of options.crons) {
      if (!due.includes(cron.id) || busy.has(cron.id)) continue
      busy.add(cron.id)
      const run = cron
        .task(new Date(at))
        .catch((error: unknown) => options.onError?.(error, cron.id))
        .finally(() => {
          busy.delete(cron.id)
          running.delete(run)
        })
      running.add(run)
    }
    const next = Math.min(...options.crons.map((cron) => nextRun(cron.schedule, new Date(at)).getTime()))
    if (!stopped) timer = setTimeout(tick, Math.max(0, Math.min(options.tickMs ?? RUNNER_TICK_MS, next - now())))
  }
  void tick()
  return {
    stop: async () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      await Promise.all([...running])
    },
  }
}
