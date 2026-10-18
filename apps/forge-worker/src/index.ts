import { d1Database } from '@git-forge/accounts'
import { R2Storage } from '@git-forge/cloudflare'
import { type ActionsConfig, handleRequest } from './app.ts'
import { containerLauncher, type RunnerContainer } from './runner-container.ts'

export { RunnerContainer } from './runner-container.ts'

export type Env = {
  readonly BUCKET: R2Bucket
  readonly DB: D1Database
  readonly RUNNER?: DurableObjectNamespace<RunnerContainer>
  readonly ADMIN_TOKEN?: string
  readonly PUBLIC_READ?: string
  readonly MAX_PUSH_BYTES?: string
  readonly ACTIONS?: string
  readonly INSTANCE_ID?: string
  readonly PUBLIC_URL?: string
  readonly ACTIONS_SECRETS?: string
}

const DEFAULT_MAX_PUSH_BYTES = 16 * 1024 * 1024

const DEFAULT_INSTANCE_ID = '00000000-0000-0000-0000-000000000000'

const maxPushBytes = (value: string | undefined): number => {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_PUSH_BYTES
}

const instanceSecrets = (value: string | undefined): Record<string, string> => {
  if (!value) return {}
  const parsed: unknown = JSON.parse(value)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('ACTIONS_SECRETS must be a JSON object')
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

const actionsConfig = (env: Env): ActionsConfig | undefined => {
  if (env.ACTIONS !== 'true') return undefined
  const secrets = instanceSecrets(env.ACTIONS_SECRETS)
  return {
    db: d1Database(env.DB),
    instanceId: env.INSTANCE_ID ?? DEFAULT_INSTANCE_ID,
    secrets: async () => secrets,
    ...(env.RUNNER ? { launcher: containerLauncher(env.RUNNER) } : {}),
    ...(env.PUBLIC_URL ? { publicUrl: env.PUBLIC_URL } : {}),
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const actions = actionsConfig(env)
    return handleRequest(request, {
      storage: new R2Storage(env.BUCKET),
      adminToken: env.ADMIN_TOKEN,
      publicRead: env.PUBLIC_READ !== 'false',
      maxPushBytes: maxPushBytes(env.MAX_PUSH_BYTES),
      ...(actions ? { actions } : {}),
    })
  },
  async scheduled(controller): Promise<void> {
    console.log(JSON.stringify({ event: 'scheduled', cron: controller.cron, at: new Date(controller.scheduledTime).toISOString(), task: 'mirror-sync', status: 'not-implemented' }))
  },
} satisfies ExportedHandler<Env>
