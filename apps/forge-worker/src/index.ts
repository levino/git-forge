import { d1Database } from '@git-forge/accounts'
import { R2Storage } from '@git-forge/cloudflare'
import { createForge, type Forge } from './app.ts'
import { type ForgeVars, parseActionsSettings, parseSettings } from './config.ts'
import type { RunnerContainer } from './runner-container.ts'
import { containerLauncher } from './runner-launcher.ts'

export type Env = ForgeVars & {
  readonly BUCKET: R2Bucket
  readonly DB: D1Database
  readonly RUNNER?: DurableObjectNamespace<RunnerContainer>
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
} satisfies ExportedHandler<Env>
