import { createStateCache, type Database, lockedStorage, sql } from '@git-forge/accounts'
import { libsqlDatabase } from '@git-forge/libsql'
import { continueImport, createConsoleEmailSender, type ImportJob } from '@git-forge/core'
import { nodeDigests } from '@git-forge/node'
import { S3Storage } from '@git-forge/s3'
import { createSesEmailSender } from '@git-forge/ses'
import { type AppJob, createForge, type Forge } from 'forge-worker/app'
import { ACTIONS_CRON, loadIdTokenKeys, loadSecretsKey, parseActionsSettings, parseSettings } from 'forge-worker/config'
import { type NodeVars, parseNodeConfig } from 'forge-node/config'
import { type CronSchedule, nextRun, parseCron } from 'forge-node/cron'
import { createSqliteJobQueue, type SqliteJobQueue } from 'forge-node/jobs'
import { databaseFetch, markEnqueued, vars } from './runtime.ts'

declare const GIT_FORGE_VERSION: string | undefined

export type Edge = { readonly forge: Forge; readonly db: Database; background(enqueued: boolean): Promise<void> }

const CHECK_MS = 60_000

const drain = async <J>(queue: SqliteJobQueue<J>): Promise<void> => {
  queue.start()
  await queue.idle()
  await queue.stop(0)
}

const dueCrons = async (db: Database, crons: readonly { id: string; schedule: CronSchedule }[], at: number): Promise<string[]> => {
  const results = await db.batch(
    crons.flatMap((cron) => [
      sql("INSERT OR IGNORE INTO jobs (id, queue, payload, attempts, run_at, created_at) VALUES (?, 'cron', '{}', 0, ?, ?)", `cron:${cron.id}`, at, at),
      sql("UPDATE jobs SET run_at = ? WHERE id = ? AND queue = 'cron' AND run_at <= ?", nextRun(cron.schedule, new Date(at)).getTime(), `cron:${cron.id}`, at),
    ]),
  )
  return crons.filter((_, i) => (results[i * 2 + 1]?.changes ?? 0) > 0).map((cron) => cron.id)
}

const build = async (): Promise<Edge> => {
  const env = vars() as NodeVars
  const config = parseNodeConfig({ DATABASE: 'libsql', STORAGE: 's3', CONDITIONAL_WRITES: 'database', ...env })
  if (config.database.kind !== 'libsql' || config.storage.kind !== 's3') throw new Error('Bunny Edge Scripting needs DATABASE=libsql and STORAGE=s3')
  const settings = await parseSettings(env)
  const actions = parseActionsSettings(env)
  const secretsKey = await loadSecretsKey(actions, env)
  const idTokenKeys = await loadIdTokenKeys(actions, settings.instanceKey)
  const db = libsqlDatabase({ ...config.database, fetch: databaseFetch })
  const bucket = new S3Storage(config.storage.config)
  const storage = config.conditionalWrites === 'database' ? lockedStorage(bucket, db) : bucket
  const onError = (error: unknown) => console.error(JSON.stringify({ event: 'error', error: error instanceof Error ? error.stack : String(error) }))
  let forge: Forge | undefined
  const jobQueue = () => createSqliteJobQueue<AppJob>({ db, onError, queue: 'jobs', leaseMs: 120_000, handler: (job, attempt) => forge!.runJob(job, attempt) })
  const importQueue = (): SqliteJobQueue<ImportJob> =>
    createSqliteJobQueue<ImportJob>({
      db,
      onError,
      queue: 'imports',
      maxAttempts: 3,
      leaseMs: 120_000,
      handler: async (job) => {
        await continueImport(job, {
          storage,
          fetch: forge!.services.remoteFetch,
          digests: nodeDigests,
          schedule: enqueueImport,
          scheduleLfs: (lfs) => jobs.enqueue(lfs),
          metadata: (next, state) => forge!.importMetadata(next, state),
        })
        await forge!.refreshRepository(job)
      },
    })
  const queue = jobQueue()
  const imports = importQueue()
  const jobs: typeof queue = { ...queue, enqueue: (job, options) => (markEnqueued(), queue.enqueue(job, options)) }
  const enqueueImport = (job: ImportJob, delaySeconds: number) => (markEnqueued(), imports.enqueue(job, { delaySeconds }))
  const email = config.email?.provider === 'console' ? createConsoleEmailSender(config.email.from) : config.email?.provider === 'ses' ? createSesEmailSender(config.email) : undefined
  forge = createForge({
    ...settings,
    ...(email ? { email } : {}),
    storage,
    db,
    stateCache: createStateCache(db),
    digests: nodeDigests,
    version: typeof GIT_FORGE_VERSION === 'string' ? GIT_FORGE_VERSION : 'dev',
    ...(secretsKey ? { secretsKey } : {}),
    clientAddress: (request) => request.headers.get('x-real-ip'),
    jobs,
    scheduleImport: enqueueImport,
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
  const crons = [
    { id: 'mirror-sync', schedule: config.schedule },
    { id: 'actions', schedule: parseCron(ACTIONS_CRON) },
  ]
  let nextCheck = 0
  const instance = forge
  return {
    forge: instance,
    db,
    background: async (enqueued) => {
      const at = Date.now()
      const due = at >= nextCheck ? ((nextCheck = at + CHECK_MS), await dueCrons(db, crons, at)) : []
      if (due.includes('mirror-sync')) await instance.scheduled(new Date(at))
      if (due.includes('actions')) await instance.actionsTick()
      if (enqueued || due.length > 0) {
        await drain(jobQueue())
        await drain(importQueue())
      }
    },
  }
}

let edge: Promise<Edge> | undefined

export const edgeForge = (): Promise<Edge> => {
  edge ??= build().catch((error: unknown) => {
    edge = undefined
    throw error
  })
  return edge
}
