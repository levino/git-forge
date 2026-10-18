import { type Database, sha256Hex, sql } from '@git-forge/accounts'
import { DEFAULT_MAX_ATTEMPTS, PermanentJobError } from '@git-forge/core'
import type { InstanceSettings } from './settings.ts'

export type JobFailure = {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly attempts: number
  readonly error: string
  readonly final: boolean
  readonly updatedAt: number
}

type Job = { readonly kind: string; readonly authorization?: string } & Record<string, unknown>

type Row = { id: string; kind: string; label: string; payload: string; sealed_authorization: string | null; attempts: number; error: string; final: number; updated_at: number }

export const jobLabel = (job: Record<string, unknown>): string => {
  if (typeof job.repository === 'string') return job.repository
  if (typeof job.owner === 'string' && typeof job.name === 'string') return `${job.owner}/${job.name}`
  return ''
}

export type JobFailures = {
  readonly recorded: (job: Job, attempt: number, error: unknown) => Promise<void>
  readonly succeeded: (job: Job) => Promise<void>
  readonly list: (limit: number) => Promise<JobFailure[]>
  readonly take: (id: string) => Promise<Job | null>
}

const strip = ({ authorization, ...rest }: Job): { readonly payload: Job; readonly authorization: string | undefined } => ({ payload: rest as Job, authorization })

export const createJobFailures = (db: Database, settings: InstanceSettings, now: () => number, maxAttempts = DEFAULT_MAX_ATTEMPTS): JobFailures => {
  const idOf = async (job: Job) => (await sha256Hex(JSON.stringify(strip(job).payload))).slice(0, 32)
  return {
    recorded: async (job, attempt, error) => {
      const id = await idOf(job)
      const { payload, authorization } = strip(job)
      const sealed = authorization && (await settings.canSeal()) ? await settings.seal(`job:${id}`, authorization) : null
      const final = error instanceof PermanentJobError || attempt >= maxAttempts ? 1 : 0
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000)
      await db.run(
        sql(
          'INSERT INTO job_failures (id, kind, label, payload, sealed_authorization, attempts, error, final, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET attempts = excluded.attempts, error = excluded.error, final = excluded.final, sealed_authorization = excluded.sealed_authorization, updated_at = excluded.updated_at',
          id,
          job.kind,
          jobLabel(job),
          JSON.stringify(payload),
          sealed,
          attempt,
          message,
          final,
          now(),
          now(),
        ),
      )
    },
    succeeded: async (job) => void (await db.run(sql('DELETE FROM job_failures WHERE id = ?', await idOf(job)))),
    list: async (limit) =>
      (await db.all<Row>(sql('SELECT id, kind, label, attempts, error, final, updated_at FROM job_failures ORDER BY updated_at DESC LIMIT ?', limit))).map((row) => ({
        id: row.id,
        kind: row.kind,
        label: row.label,
        attempts: Number(row.attempts),
        error: row.error,
        final: Number(row.final) === 1,
        updatedAt: Number(row.updated_at),
      })),
    take: async (id) => {
      const [row] = await db.all<Row>(sql('DELETE FROM job_failures WHERE id = ? RETURNING payload, sealed_authorization', id))
      if (!row) return null
      const payload = JSON.parse(row.payload) as Job
      const authorization = row.sealed_authorization ? await settings.open(`job:${id}`, row.sealed_authorization) : null
      return authorization ? { ...payload, authorization } : payload
    },
  }
}
