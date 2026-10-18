import { d1Database, MIGRATIONS, migrateOnStart } from '@git-forge/accounts'
import { consumeJobs, createCloudflareEmailSender, digestStreams, QueueJobs, R2Storage } from '@git-forge/cloudflare'
import { continueImport, createConsoleEmailSender, type EmailSender, type ImportJob, type ImportScheduler, storagePublisher } from '@git-forge/core'
import { S3Storage } from '@git-forge/s3'
import { createSesEmailSender } from '@git-forge/ses'
import { type AppJob, createForge, type Forge } from './app.ts'
import { ACTIONS_CRON, type EmailSettings, type ForgeVars, loadIdTokenKeys, loadSecretsKey, parseActionsSettings, parseEmailSettings, parseR2Signing, parseSettings, uiEnabled } from './config.ts'
import { containerLauncher } from './runner-launcher.ts'
import { captureLoginPage } from './ui/login-pages.ts'

export type Env = ForgeVars & {
  readonly BUCKET: R2Bucket
  readonly CDN_BUCKET?: R2Bucket
  readonly BACKUP?: R2Bucket
  readonly DB: D1Database
  readonly RUNNER?: DurableObjectNamespace
  readonly IMPORTS?: Queue<ImportJob>
  readonly JOBS?: Queue<AppJob>
  readonly EMAIL?: SendEmail
}

const importScheduler =
  (queue: Queue<ImportJob>): ImportScheduler =>
  async (job, delaySeconds) => {
    await queue.send(job, delaySeconds > 0 ? { delaySeconds } : {})
  }

const emailSender = (settings: EmailSettings | undefined, binding: SendEmail | undefined): EmailSender | undefined => {
  if (!settings) return undefined
  if (settings.provider === 'console') return createConsoleEmailSender(settings.from)
  if (settings.provider === 'cloudflare') return binding && createCloudflareEmailSender(binding, settings.from)
  return createSesEmailSender(settings)
}

let forge: Promise<Forge> | undefined

export const forgeFor = (env: Env): Promise<Forge> => {
  forge ??= parseSettings(env)
    .then(async (settings) => {
      await migrateOnStart(d1Database(env.DB), MIGRATIONS)
      const actions = parseActionsSettings(env)
      const secretsKey = await loadSecretsKey(actions, env)
      const idTokenKeys = await loadIdTokenKeys(actions, settings.instanceKey)
      const email = emailSender(parseEmailSettings(env, env.EMAIL !== undefined), env.EMAIL)
      const signing = parseR2Signing(env)
      return createForge({
        ...settings,
        storage: new R2Storage(env.BUCKET),
        db: d1Database(env.DB),
        digests: digestStreams,
        ...(secretsKey ? { secretsKey } : {}),
        clientAddress: (request) => request.headers.get('CF-Connecting-IP'),
        ...(uiEnabled(env) ? { renderLoginPage: captureLoginPage } : {}),
        ...(env.IMPORTS ? { scheduleImport: importScheduler(env.IMPORTS) } : {}),
        ...(env.JOBS ? { jobs: new QueueJobs(env.JOBS) } : {}),
        ...(email ? { email } : {}),
        ...(signing ? { presigner: new S3Storage({ ...signing, region: 'auto', forcePathStyle: true }) } : {}),
        ...(env.BACKUP ? { backup: new R2Storage(env.BACKUP) } : {}),
        ...(env.CDN_BUCKET ? { lfsPublisher: storagePublisher(new R2Storage(env.CDN_BUCKET), env.LFS_PUBLISH_PREFIX?.trim() ?? '') } : {}),
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
                ...(env.RUNNER ? { launcher: containerLauncher(env.RUNNER) } : {}),
              },
            }
          : {}),
      })
    })
    .catch((error: unknown) => {
      forge = undefined
      throw error
    })
  return forge
}

const isJobQueue = (name: string): boolean => name.endsWith('-jobs')

export const backgroundHandlers = {
  async scheduled(controller, env): Promise<void> {
    if (controller.cron === ACTIONS_CRON) {
      const tick = await (await forgeFor(env)).actionsTick()
      console.log(JSON.stringify({ event: 'scheduled', cron: controller.cron, at: new Date(controller.scheduledTime).toISOString(), task: 'actions', scheduled: tick?.scheduled.length ?? 0, reaped: tick?.reaped ?? null }))
      return
    }
    const runs = await (await forgeFor(env)).scheduled(new Date(controller.scheduledTime))
    console.log(JSON.stringify({ event: 'scheduled', cron: controller.cron, at: new Date(controller.scheduledTime).toISOString(), task: 'mirror-sync', runs }))
  },
  async queue(batch, env): Promise<void> {
    if (isJobQueue(batch.queue)) {
      const instance = await forgeFor(env)
      const outcomes = await consumeJobs(batch as MessageBatch<AppJob>, (job) => instance.runJob(job))
      console.log(JSON.stringify({ event: 'jobs', outcomes }))
      return
    }
    const queue = env.IMPORTS
    if (!queue) throw new Error('IMPORTS queue binding is missing')
    const instance = await forgeFor(env)
    for (const message of (batch as MessageBatch<ImportJob>).messages) {
      const jobs = env.JOBS ? new QueueJobs(env.JOBS) : null
      const state = await continueImport(message.body, {
        storage: instance.services.storage,
        digests: digestStreams,
        schedule: importScheduler(queue),
        metadata: async (job, state) => (await forgeFor(env)).importMetadata(job, state),
        ...(jobs ? { scheduleLfs: (job) => jobs.enqueue(job) } : {}),
      })
      await (await forgeFor(env)).refreshRepository(message.body)
      console.log(JSON.stringify({ event: 'import-step', repo: `${message.body.owner}/${message.body.name}`, phase: state.phase, steps: state.steps, error: state.error }))
      message.ack()
    }
  },
} satisfies Omit<ExportedHandler<Env, ImportJob | AppJob>, 'fetch'>
