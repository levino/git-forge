import { R2Storage } from '@git-forge/cloudflare'
import { continueImport, type ImportJob, type ImportScheduler } from '@git-forge/core'
import { handleRequest } from './app.ts'

export type Env = {
  readonly BUCKET: R2Bucket
  readonly DB: D1Database
  readonly IMPORTS?: Queue<ImportJob>
  readonly ADMIN_TOKEN?: string
  readonly READ_TOKEN?: string
  readonly PUBLIC_READ?: string
  readonly MAX_PUSH_BYTES?: string
}

const DEFAULT_MAX_PUSH_BYTES = 16 * 1024 * 1024

const maxPushBytes = (value: string | undefined): number => {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_PUSH_BYTES
}

const importScheduler = (queue: Queue<ImportJob>): ImportScheduler => async (job, delaySeconds) => {
  await queue.send(job, delaySeconds > 0 ? { delaySeconds } : {})
}

export default {
  async fetch(request, env): Promise<Response> {
    return handleRequest(request, {
      storage: new R2Storage(env.BUCKET),
      adminToken: env.ADMIN_TOKEN,
      readToken: env.READ_TOKEN,
      publicRead: env.PUBLIC_READ !== 'false',
      maxPushBytes: maxPushBytes(env.MAX_PUSH_BYTES),
      ...(env.IMPORTS ? { scheduleImport: importScheduler(env.IMPORTS) } : {}),
    })
  },
  async queue(batch, env): Promise<void> {
    const queue = env.IMPORTS
    if (!queue) throw new Error('IMPORTS queue binding is missing')
    for (const message of batch.messages) {
      const state = await continueImport(message.body, { storage: new R2Storage(env.BUCKET), schedule: importScheduler(queue) })
      console.log(JSON.stringify({ event: 'import-step', repo: `${message.body.owner}/${message.body.name}`, phase: state.phase, steps: state.steps, error: state.error }))
      message.ack()
    }
  },
  async scheduled(controller): Promise<void> {
    console.log(JSON.stringify({ event: 'scheduled', cron: controller.cron, at: new Date(controller.scheduledTime).toISOString(), task: 'mirror-sync', status: 'not-implemented' }))
  },
} satisfies ExportedHandler<Env, ImportJob>
