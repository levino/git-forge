import { d1Database } from '@git-forge/accounts'
import { consumeJobs, QueueJobs, R2Storage } from '@git-forge/cloudflare'
import { createForge, type Forge } from './app.ts'
import { type ForgeVars, parseSettings } from './config.ts'
import type { ForgeJob } from './mirror-federation.ts'

export type Env = ForgeVars & {
  readonly BUCKET: R2Bucket
  readonly DB: D1Database
  readonly JOBS?: Queue<ForgeJob>
}

let forge: Promise<Forge> | undefined

const forgeFor = (env: Env): Promise<Forge> => {
  forge ??= parseSettings(env)
    .then((settings) =>
      createForge({ ...settings, storage: new R2Storage(env.BUCKET), db: d1Database(env.DB), ...(env.JOBS ? { jobs: new QueueJobs(env.JOBS) } : {}) }),
    )
    .catch((error: unknown) => {
      forge = undefined
      throw error
    })
  return forge
}

export default {
  async fetch(request, env): Promise<Response> {
    return (await forgeFor(env)).fetch(request)
  },
  async queue(batch, env): Promise<void> {
    const instance = await forgeFor(env)
    const outcomes = await consumeJobs(batch, (job) => instance.runJob(job))
    console.log(JSON.stringify({ event: 'jobs', outcomes }))
  },
  async scheduled(controller, env): Promise<void> {
    const runs = await (await forgeFor(env)).scheduled(new Date(controller.scheduledTime))
    console.log(JSON.stringify({ event: 'scheduled', cron: controller.cron, at: new Date(controller.scheduledTime).toISOString(), task: 'mirror-sync', runs }))
  },
} satisfies ExportedHandler<Env, ForgeJob>
