import { d1Database } from '@git-forge/accounts'
import { R2Storage } from '@git-forge/cloudflare'
import { continueImport, type ImportJob, type ImportScheduler } from '@git-forge/core'
import { createForge, type Forge } from './app.ts'
import { type ForgeVars, parseActionsSettings, parseSettings } from './config.ts'
import { containerLauncher } from './runner-launcher.ts'

export { RunnerContainer } from './runner-container.ts'

export type Env = ForgeVars & {
  readonly BUCKET: R2Bucket
  readonly DB: D1Database
  readonly RUNNER?: DurableObjectNamespace
  readonly IMPORTS?: Queue<ImportJob>
}

const importScheduler =
  (queue: Queue<ImportJob>): ImportScheduler =>
  async (job, delaySeconds) => {
    await queue.send(job, delaySeconds > 0 ? { delaySeconds } : {})
  }

let forge: Promise<Forge> | undefined

const forgeFor = (env: Env): Promise<Forge> => {
  forge ??= parseSettings(env)
    .then((settings) => {
      const actions = parseActionsSettings(env)
      return createForge({
        ...settings,
        storage: new R2Storage(env.BUCKET),
        db: d1Database(env.DB),
        ...(env.IMPORTS ? { scheduleImport: importScheduler(env.IMPORTS) } : {}),
        ...(actions
          ? {
              actions: {
                instanceId: actions.instanceId,
                secrets: async () => actions.secrets,
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

export default {
  async fetch(request, env): Promise<Response> {
    return (await forgeFor(env)).fetch(request)
  },
  async scheduled(controller, env): Promise<void> {
    const runs = await (await forgeFor(env)).scheduled(new Date(controller.scheduledTime))
    console.log(JSON.stringify({ event: 'scheduled', cron: controller.cron, at: new Date(controller.scheduledTime).toISOString(), task: 'mirror-sync', runs }))
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
} satisfies ExportedHandler<Env, ImportJob>
