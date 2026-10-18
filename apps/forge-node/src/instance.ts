import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { applyMigrations, type Database, MIGRATIONS, pendingMigrations } from '@git-forge/accounts'
import { openSqliteDatabase } from '@git-forge/accounts-node'
import { continueImport, createMemoryJobQueue, type FetchFunction, type ImportJob, type JobOutcome, type MemoryJobQueue, type Storage } from '@git-forge/core'
import { CLIENT_ADDRESS_HEADER, FsStorage, nodeDigests } from '@git-forge/node'
import { S3Storage } from '@git-forge/s3'
import { type AppJob, createForge, type Forge } from 'forge-worker/app'
import { ConfigurationError, loadSecretsKey, parseActionsSettings, parseSettings } from 'forge-worker/config'
import { type NodeConfig, type NodeVars, parseNodeConfig, type StorageConfig } from './config.ts'

export type Log = (event: Record<string, unknown>) => void

export type NodeInstance = {
  readonly config: NodeConfig
  readonly forge: Forge
  readonly storage: Storage
  readonly db: Database
  readonly jobs: MemoryJobQueue<AppJob>
  readonly imports: MemoryJobQueue<ImportJob>
  close(graceMs?: number): Promise<void>
}

export type InstanceOverrides = {
  readonly fetch?: FetchFunction
  readonly now?: () => Date
  readonly log?: Log
}

export class PendingMigrationsError extends ConfigurationError {
  constructor(readonly pending: readonly string[]) {
    super(`the database has pending migrations (${pending.join(', ')}); run the migrate command first`)
  }
}

export const jsonLog: Log = (event) => console.log(JSON.stringify(event))

export const openDatabase = async (path: string): Promise<{ readonly db: Database; readonly handle: DatabaseSync }> => {
  if (path !== ':memory:') await mkdir(dirname(path), { recursive: true })
  return openSqliteDatabase(path)
}

export const migrate = async (vars: NodeVars): Promise<string[]> => {
  const { databasePath } = parseNodeConfig(vars)
  const { db, handle } = await openDatabase(databasePath)
  try {
    return await applyMigrations(db, MIGRATIONS)
  } finally {
    handle.close()
  }
}

export const openStorage = async (config: StorageConfig): Promise<Storage> => {
  if (config.kind === 's3') return new S3Storage(config.config)
  await mkdir(config.dir, { recursive: true })
  return new FsStorage(config.dir)
}

const outcomeLog =
  <J>(log: Log, event: string, describe: (job: J) => Record<string, unknown>) =>
  (outcome: JobOutcome<J>) =>
    log({ event, ...describe(outcome.job), attempts: outcome.attempts, outcome: outcome.outcome, ...('error' in outcome ? { error: outcome.error } : {}) })

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref())

export const createInstance = async (vars: NodeVars, overrides: InstanceOverrides = {}): Promise<NodeInstance> => {
  const log = overrides.log ?? jsonLog
  const config = parseNodeConfig(vars)
  const settings = await parseSettings(vars)
  const actions = parseActionsSettings(vars)
  const secretsKey = await loadSecretsKey(actions)
  const { db, handle } = await openDatabase(config.databasePath)
  try {
    const pending = await pendingMigrations(db, MIGRATIONS)
    if (pending.length > 0) throw new PendingMigrationsError(pending)
  } catch (error) {
    handle.close()
    throw error
  }
  const storage = await openStorage(config.storage)
  let forge: Forge | undefined
  const jobs = createMemoryJobQueue<AppJob>((job) => forge!.runJob(job), {
    concurrency: config.jobConcurrency,
    keepHistory: false,
    onOutcome: outcomeLog<AppJob>(log, 'job', (job) => ({ ...job })),
  })
  const imports: MemoryJobQueue<ImportJob> = createMemoryJobQueue<ImportJob>(
    async (job) => {
      const state = await continueImport(job, { storage, schedule: (next, delaySeconds) => imports.enqueue(next, { delaySeconds }) })
      log({ event: 'import-step', repo: `${job.owner}/${job.name}`, phase: state.phase, steps: state.steps, error: state.error })
    },
    {
      maxAttempts: 3,
      concurrency: 1,
      keepHistory: false,
      onOutcome: outcomeLog<ImportJob>(log, 'import', (job) => ({ repo: `${job.owner}/${job.name}` })),
    },
  )
  forge = createForge({
    ...settings,
    storage,
    db,
    digests: nodeDigests,
    clientAddress: (request) => request.headers.get(CLIENT_ADDRESS_HEADER),
    jobs,
    scheduleImport: (job, delaySeconds) => imports.enqueue(job, { delaySeconds }),
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(actions
      ? {
          actions: {
            instanceId: actions.instanceId,
            secrets: async () => actions.secrets,
            ...(secretsKey ? { secretsKey } : {}),
            repositories: actions.repositories,
            githubFallback: actions.githubFallback,
          },
        }
      : {}),
  })
  let closed = false
  return {
    config,
    forge,
    storage,
    db,
    jobs,
    imports,
    close: async (graceMs = 10_000) => {
      if (closed) return
      closed = true
      await Promise.race([Promise.all([jobs.idle(), imports.idle()]), sleep(graceMs)])
      handle.close()
    },
  }
}
