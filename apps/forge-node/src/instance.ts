import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { applyMigrations, type Database, lockedStorage, MIGRATIONS, pendingMigrations } from '@git-forge/accounts'
import { openSqliteDatabase } from '@git-forge/accounts-node'
import { libsqlDatabase } from '@git-forge/libsql'
import { continueImport, createConsoleEmailSender, type EmailSender, type FetchFunction, type ImportJob, type JobOutcome, type Storage, storagePublisher } from '@git-forge/core'
import { CLIENT_ADDRESS_HEADER, FsStorage, nodeDigests } from '@git-forge/node'
import { S3Storage } from '@git-forge/s3'
import { createSesEmailSender } from '@git-forge/ses'
import { createSmtpEmailSender } from '@git-forge/smtp'
import { type AppJob, createForge, type Forge } from 'forge-worker/app'
import { type RestoreResult, restoreBackup, restoreSql, verifyBackup } from 'forge-worker/backup'
import { ConfigurationError, loadIdTokenKeys, loadSecretsKey, parseActionsSettings, parseSettings } from 'forge-worker/config'
import { type DatabaseConfig, type NodeConfig, type NodeEmailSettings, type NodeVars, parseNodeConfig, type StorageConfig } from './config.ts'
import { createSqliteJobQueue, type SqliteJobQueue } from './jobs.ts'

declare const GIT_FORGE_VERSION: string | undefined

export type Log = (event: Record<string, unknown>) => void

export type NodeInstance = {
  readonly config: NodeConfig
  readonly forge: Forge
  readonly storage: Storage
  readonly db: Database
  readonly jobs: SqliteJobQueue<AppJob>
  readonly imports: SqliteJobQueue<ImportJob>
  close(graceMs?: number): Promise<void>
}

export type InstanceOverrides = {
  readonly fetch?: FetchFunction
  readonly now?: () => Date
  readonly log?: Log
  readonly email?: EmailSender
  readonly jobLeaseMs?: number
  readonly jobDelayMs?: (seconds: number) => number
}

export class PendingMigrationsError extends ConfigurationError {
  constructor(readonly pending: readonly string[]) {
    super(`the database has pending migrations (${pending.join(', ')}); run the migrate command first`)
  }
}

export const jsonLog: Log = (event) => console.log(JSON.stringify(event))

export type OpenedDatabase = { readonly db: Database; close(): void }

export const openDatabase = async (config: DatabaseConfig): Promise<OpenedDatabase> => {
  if (config.kind === 'libsql') return { db: libsqlDatabase(config), close: () => undefined }
  if (config.path !== ':memory:') await mkdir(dirname(config.path), { recursive: true })
  const { db, handle } = openSqliteDatabase(config.path)
  return { db, close: () => handle.close() }
}

export const migrate = async (vars: NodeVars): Promise<string[]> => {
  const { db, close } = await openDatabase(parseNodeConfig(vars).database)
  try {
    return await applyMigrations(db, MIGRATIONS)
  } finally {
    close()
  }
}

const instanceStorage = async (config: NodeConfig, db: Database): Promise<Storage> => {
  const storage = await openStorage(config.storage)
  return config.conditionalWrites === 'database' ? lockedStorage(storage, db) : storage
}

const backupTarget = async (config: NodeConfig): Promise<Storage> => {
  if (!config.backup) throw new ConfigurationError('this command needs a backup target: set BACKUP_STORAGE (fs or s3) and its BACKUP_* settings')
  return openStorage(config.backup)
}

export const restore = async (vars: NodeVars, id?: string): Promise<RestoreResult & { readonly migrated: string[] }> => {
  const config = parseNodeConfig(vars)
  const target = await backupTarget(config)
  const { db, close } = await openDatabase(config.database)
  try {
    const result = await restoreBackup(target, await instanceStorage(config, db), db, nodeDigests, id)
    return { ...result, migrated: await applyMigrations(db, MIGRATIONS) }
  } finally {
    close()
  }
}

export const restoreSqlFrom = async (vars: NodeVars, id?: string): Promise<AsyncIterable<Uint8Array>> => restoreSql(await backupTarget(parseNodeConfig(vars)), id)

export const verify = async (vars: NodeVars, sample: number): Promise<{ readonly checked: number; readonly failures: string[] }> => {
  const config = parseNodeConfig(vars)
  const target = await backupTarget(config)
  const { db, close } = await openDatabase(config.database)
  try {
    return await verifyBackup(db, target, nodeDigests, sample)
  } finally {
    close()
  }
}

export const openStorage = async (config: StorageConfig): Promise<Storage> => {
  if (config.kind === 's3') return new S3Storage(config.config)
  await mkdir(config.dir, { recursive: true })
  return new FsStorage(config.dir)
}

export const emailSender = (settings: NodeEmailSettings | undefined): EmailSender | undefined => {
  if (!settings) return undefined
  if (settings.provider === 'console') return createConsoleEmailSender(settings.from)
  if (settings.provider === 'smtp') {
    const { provider: _, ...smtp } = settings
    return createSmtpEmailSender(smtp)
  }
  return createSesEmailSender(settings)
}

const outcomeLog =
  <J>(log: Log, event: string, describe: (job: J) => Record<string, unknown>) =>
  (outcome: JobOutcome<J>) =>
    log({ event, ...describe(outcome.job), attempts: outcome.attempts, outcome: outcome.outcome, ...('error' in outcome ? { error: outcome.error } : {}) })

export const createInstance = async (vars: NodeVars, overrides: InstanceOverrides = {}): Promise<NodeInstance> => {
  const log = overrides.log ?? jsonLog
  const config = parseNodeConfig(vars)
  const settings = await parseSettings(vars)
  const actions = parseActionsSettings(vars)
  const secretsKey = await loadSecretsKey(actions, vars)
  const idTokenKeys = await loadIdTokenKeys(actions, settings.instanceKey)
  const { db, close: closeDatabase } = await openDatabase(config.database)
  try {
    const pending = await pendingMigrations(db, MIGRATIONS)
    if (pending.length > 0) throw new PendingMigrationsError(pending)
  } catch (error) {
    closeDatabase()
    throw error
  }
  const storage = await instanceStorage(config, db)
  const backup = config.backup ? await openStorage(config.backup) : undefined
  let forge: Forge | undefined
  const queueOptions = {
    db,
    onError: (error: unknown) => log({ event: 'error', error: error instanceof Error ? error.stack : String(error) }),
    ...(overrides.jobLeaseMs ? { leaseMs: overrides.jobLeaseMs } : {}),
    ...(overrides.jobDelayMs ? { delayMs: overrides.jobDelayMs } : {}),
  }
  const jobs = createSqliteJobQueue<AppJob>({
    ...queueOptions,
    queue: 'jobs',
    handler: (job, attempt) => forge!.runJob(job, attempt),
    concurrency: config.jobConcurrency,
    onOutcome: outcomeLog<AppJob>(log, 'job', (job) => ({ ...job, ...('authorization' in job ? { authorization: 'redacted' } : {}) })),
  })
  const imports: SqliteJobQueue<ImportJob> = createSqliteJobQueue<ImportJob>({
    ...queueOptions,
    queue: 'imports',
    handler: async (job) => {
      const state = await continueImport(job, {
        storage: forge!.services.storage,
        digests: nodeDigests,
        schedule: (next, delaySeconds) => imports.enqueue(next, { delaySeconds }),
        scheduleLfs: (lfs) => jobs.enqueue(lfs),
        metadata: (next, current) => forge!.importMetadata(next, current),
      })
      await forge!.refreshRepository(job)
      log({ event: 'import-step', repo: `${job.owner}/${job.name}`, phase: state.phase, steps: state.steps, error: state.error })
    },
    maxAttempts: 3,
    concurrency: 1,
    onOutcome: outcomeLog<ImportJob>(log, 'import', (job) => ({ repo: `${job.owner}/${job.name}` })),
  })
  const email = overrides.email ?? emailSender(config.email)
  forge = createForge({
    ...settings,
    ...(email ? { email } : {}),
    storage,
    db,
    digests: nodeDigests,
    version: typeof GIT_FORGE_VERSION === 'string' ? GIT_FORGE_VERSION : 'dev',
    ...(secretsKey ? { secretsKey } : {}),
    clientAddress: (request) => request.headers.get(CLIENT_ADDRESS_HEADER),
    jobs,
    ...(backup ? { backup } : {}),
    scheduleImport: (job, delaySeconds) => imports.enqueue(job, { delaySeconds }),
    ...(config.lfsPublishDir ? { lfsPublisher: storagePublisher(new FsStorage(config.lfsPublishDir), vars.LFS_PUBLISH_PREFIX?.trim() ?? '') } : {}),
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
                idTokenKeys,
                artifactRetentionDays: actions.artifactRetentionDays,
                cacheLimits: actions.cacheLimits,
          },
        }
      : {}),
  })
  jobs.start()
  imports.start()
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
      await Promise.all([jobs.stop(graceMs), imports.stop(graceMs)])
      closeDatabase()
    },
  }
}
