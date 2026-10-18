import { type Database, sql } from '@git-forge/accounts'
import { lfsPrefix, packKey, type RepositoryName, type Storage } from '@git-forge/core'
import { monthKey, type UsageMetric } from './costs.ts'

export type StoredKind = 'git' | 'lfs'

export type RepositoryUsage = { readonly repository: string; readonly gitBytes: number; readonly lfsBytes: number; readonly objects: number }

export type UsageScanJob = { readonly kind: 'usage-scan'; readonly repository: string }

const METERED = /^repos\/([^/]+\/[^/]+)\/(?:(git)\/objects\/pack\/[^/]+|(lfs)\/objects\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64})$/

export const classifyKey = (key: string): { readonly repository: string; readonly kind: StoredKind } | null => {
  const match = METERED.exec(key)
  return match ? { repository: match[1]!, kind: (match[2] ?? match[3]) as StoredKind } : null
}

export type UsageMeter = {
  readonly storage: (storage: Storage) => Storage
  readonly database: (db: Database) => Database
  readonly record: (objects: readonly { readonly key: string; readonly size: number }[]) => Promise<void>
  readonly count: (metric: UsageMetric, amount?: number) => void
  readonly flush: (force?: boolean) => Promise<void>
  readonly repositories: () => Promise<RepositoryUsage[]>
  readonly counters: (at: number) => Promise<Partial<Record<UsageMetric, number>>>
  readonly scan: (storage: Storage, job: UsageScanJob) => Promise<number>
}

export const FLUSH_COUNT = 1000

export const FLUSH_MS = 60_000

export const createUsageMeter = (db: Database, now: () => number): UsageMeter => {
  const pending = new Map<UsageMetric, number>()
  let total = 0
  let flushedAt = now()
  const count = (metric: UsageMetric, amount = 1) => {
    pending.set(metric, (pending.get(metric) ?? 0) + amount)
    total += amount
  }
  const record = async (objects: readonly { readonly key: string; readonly size: number }[]) => {
    const statements = objects.flatMap(({ key, size }) => {
      const kind = classifyKey(key)
      return kind ? [sql('INSERT OR IGNORE INTO storage_objects (key, repository, kind, size, created_at) VALUES (?, ?, ?, ?, ?)', key, kind.repository, kind.kind, size, now())] : []
    })
    if (statements.length > 0) await db.batch(statements)
  }
  return {
    count,
    record,
    storage: (inner) => ({
      get: (key, range) => (count('r2_class_b'), inner.get(key, range)),
      head: (key) => (count('r2_class_b'), inner.head(key)),
      put: async (key, body, size, options) => {
        count('r2_class_a')
        const result = await inner.put(key, body, size, options)
        if (result.ok) await record([{ key, size }])
        return result
      },
      list: (prefix) => (count('r2_class_a'), inner.list(prefix)),
      ...(inner.presignGet ? { presignGet: inner.presignGet.bind(inner) } : {}),
      ...(inner.presignPut ? { presignPut: inner.presignPut.bind(inner) } : {}),
    }),
    database: (inner) => ({
      all: (statement) => (count('d1_reads'), inner.all(statement)),
      run: (statement) => (count('d1_writes'), inner.run(statement)),
      batch: (statements) => (count('d1_writes', statements.length), inner.batch(statements)),
    }),
    flush: async (force = false) => {
      if (total === 0 || (!force && total < FLUSH_COUNT && now() - flushedAt < FLUSH_MS)) return
      const month = monthKey(now())
      const entries = [...pending]
      pending.clear()
      total = 0
      flushedAt = now()
      await db.batch(
        entries.map(([metric, value]) =>
          sql('INSERT INTO usage_counters (month, metric, value) VALUES (?, ?, ?) ON CONFLICT (month, metric) DO UPDATE SET value = value + excluded.value', month, metric, value),
        ),
      )
    },
    repositories: async () =>
      (
        await db.all<{ repository: string; git_bytes: number; lfs_bytes: number; objects: number }>(
          sql('SELECT repository, git_bytes, lfs_bytes, objects FROM repository_usage ORDER BY git_bytes + lfs_bytes DESC, repository'),
        )
      ).map((row) => ({ repository: row.repository, gitBytes: Number(row.git_bytes), lfsBytes: Number(row.lfs_bytes), objects: Number(row.objects) })),
    counters: async (at) =>
      Object.fromEntries((await db.all<{ metric: string; value: number }>(sql('SELECT metric, value FROM usage_counters WHERE month = ?', monthKey(at)))).map((row) => [row.metric, Number(row.value)])),
    scan: async (storage, job) => {
      const [owner, name] = job.repository.split('/') as [string, string]
      const repo: RepositoryName = { owner, name }
      let seen = 0
      for (const prefix of [packKey(repo, ''), `${lfsPrefix(repo)}objects/`]) {
        let batch: { key: string; size: number }[] = []
        for await (const object of storage.list(prefix)) {
          batch.push({ key: object.key, size: object.size })
          seen++
          if (batch.length === 50) {
            await record(batch)
            batch = []
          }
        }
        await record(batch)
      }
      return seen
    },
  }
}
