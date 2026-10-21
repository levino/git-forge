import { type Database, sql, type Statement } from '@git-forge/accounts'
import { lfsPrefix, packKey, type RepositoryName, type Storage } from '@git-forge/core'
import { monthKey, type UsageMetric } from './costs.ts'

export type StoredKind = 'git' | 'lfs'

export type RepositoryUsage = { readonly repository: string | null; readonly path: string; readonly gitBytes: number; readonly lfsBytes: number; readonly objects: number }

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
  readonly paths: () => Promise<string[]>
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
  const stored: Statement[] = []
  const objectStatements = (objects: readonly { readonly key: string; readonly size: number }[]) =>
    objects.flatMap(({ key, size }) => {
      const kind = classifyKey(key)
      return kind ? [sql('INSERT OR IGNORE INTO storage_objects (key, repository, kind, size, created_at) VALUES (?, ?, ?, ?, ?)', key, kind.repository, kind.kind, size, now())] : []
    })
  const record = async (objects: readonly { readonly key: string; readonly size: number }[]) => {
    const statements = objectStatements(objects)
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
        if (result.ok) stored.push(...objectStatements([{ key, size }]))
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
      read: (statements) => (count('d1_reads', statements.length), inner.read(statements)),
    }),
    flush: async (force = false) => {
      const due = total > 0 && (force || total >= FLUSH_COUNT || now() - flushedAt >= FLUSH_MS)
      if (!due && stored.length === 0) return
      const month = monthKey(now())
      const entries = due ? [...pending] : []
      if (due) {
        pending.clear()
        total = 0
        flushedAt = now()
      }
      await db.batch([
        ...stored.splice(0),
        ...entries.map(([metric, value]) =>
          sql('INSERT INTO usage_counters (month, metric, value) VALUES (?, ?, ?) ON CONFLICT (month, metric) DO UPDATE SET value = value + excluded.value', month, metric, value),
        ),
      ])
    },
    repositories: async () =>
      (
        await db.all<{ name: string | null; path: string; git_bytes: number; lfs_bytes: number; objects: number }>(
          sql(
            "SELECT a.login || '/' || r.name AS name, u.repository AS path, u.git_bytes, u.lfs_bytes, u.objects FROM repository_usage u LEFT JOIN repositories r ON r.storage_path = u.repository AND r.deleted_at IS NULL LEFT JOIN accounts a ON a.id = r.owner_id ORDER BY u.git_bytes + u.lfs_bytes DESC, u.repository",
          ),
        )
      ).map((row) => ({ repository: row.name, path: row.path, gitBytes: Number(row.git_bytes), lfsBytes: Number(row.lfs_bytes), objects: Number(row.objects) })),
    paths: async () => (await db.all<{ path: string }>(sql('SELECT storage_path AS path FROM repositories WHERE deleted_at IS NULL AND storage_path IS NOT NULL ORDER BY storage_path'))).map((row) => row.path),
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
