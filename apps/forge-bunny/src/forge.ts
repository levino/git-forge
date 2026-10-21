import { AsyncLocalStorage } from 'node:async_hooks'
import { createStateCache, type Database, lockedStorage, REMOTE_WINDOW_MS, requestScope, type ScopeState, sha256Hex } from '@git-forge/accounts'
import { cacheApiObjectCache, cacheApiPageCache } from '@git-forge/cloudflare/cache'
import { continueImport, createConsoleEmailSender, type ImportJob } from '@git-forge/core'
import { libsqlDatabase } from '@git-forge/libsql'
import { nodeDigests } from '@git-forge/node'
import { S3Storage } from '@git-forge/s3'
import { createSesEmailSender } from '@git-forge/ses'
import { type AppJob, createForge, type Forge } from 'forge-worker/app'
import { ACTIONS_CRON, loadIdTokenKeys, loadSecretsKey, parseActionsSettings, parseSettings } from 'forge-worker/config'
import { RUNNER_STALE_MS, runnerSeenAt } from 'forge-worker/jobs'
import { PAGE_CACHE_SECONDS } from 'forge-worker/page-cache'
import { type NodeVars, parseNodeConfig } from 'forge-node/config'
import { parseCron } from 'forge-node/cron'
import { createSqliteJobQueue, type SqliteJobQueue } from 'forge-node/jobs'
import { claimDueCrons } from 'forge-node/runner'
import { databaseFetch, markEnqueued, vars } from './runtime.ts'

declare const GIT_FORGE_VERSION: string | undefined

export type Edge = { readonly forge: Forge; readonly db: Database; background(enqueued: boolean): Promise<void> }

const CHECK_MS = 60_000

const CACHE_VERSION = 'v1'

const drain = async <J>(queue: SqliteJobQueue<J>): Promise<void> => {
  queue.start()
  await queue.idle()
  await queue.stop(0)
}

const build = async (): Promise<Edge> => {
  const env = vars() as NodeVars
  const config = parseNodeConfig({ DATABASE: 'libsql', STORAGE: 's3', CONDITIONAL_WRITES: 'database', ...env })
  if (config.database.kind !== 'libsql' || config.storage.kind !== 's3') throw new Error('Bunny Edge Scripting needs DATABASE=libsql and STORAGE=s3')
  const settings = await parseSettings(env)
  const actions = parseActionsSettings(env)
  const secretsKey = await loadSecretsKey(actions, env)
  const idTokenKeys = await loadIdTokenKeys(actions, settings.instanceKey)
  const scope = requestScope(new AsyncLocalStorage<ScopeState>(), REMOTE_WINDOW_MS)
  const db = scope.database(libsqlDatabase({ ...config.database, fetch: databaseFetch }))
  const locked = config.conditionalWrites === 'database'
  const storage = locked ? lockedStorage(new S3Storage(config.storage.config), db) : new S3Storage(config.storage.config)
  const origin = settings.publicUrl ? `${new URL(settings.publicUrl).origin}/_cache/${(await sha256Hex(`cache:${env.INSTANCE_KEY ?? ''}`)).slice(0, 32)}` : undefined
  const named = (name: string) => ({ cache: caches.open(`git-forge-${name}-${CACHE_VERSION}`), ...(origin ? { origin: `${origin}/${name}` } : {}) })
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
          storage: forge!.services.storage,
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
    requestScope: scope,
    stateCache: createStateCache(db, locked ? { locks: {} } : {}),
    objectCache: cacheApiObjectCache(named('objects')),
    pageCache: cacheApiPageCache(PAGE_CACHE_SECONDS, named('pages')),
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
  let checkedAt = 0
  let drainedAt = 0
  let stale = false
  const instance = forge
  return {
    forge: instance,
    db,
    background: async (enqueued) => {
      const at = Date.now()
      if (at - checkedAt >= CHECK_MS) {
        checkedAt = at
        const seen = await runnerSeenAt(db)
        stale = seen === null || at - seen > RUNNER_STALE_MS
        if (stale) {
          const due = await claimDueCrons(db, crons, at)
          if (due.includes('mirror-sync')) await instance.scheduled(new Date(at))
          if (due.includes('actions')) await instance.actionsTick()
        }
      }
      if (!stale || (!enqueued && at - drainedAt < CHECK_MS)) return
      drainedAt = at
      await drain(jobQueue())
      await drain(importQueue())
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
