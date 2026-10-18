import { R2Storage } from '@git-forge/cloudflare'
import { handleRequest } from './app.ts'

export type Env = {
  readonly BUCKET: R2Bucket
  readonly DB: D1Database
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

export default {
  async fetch(request, env): Promise<Response> {
    return handleRequest(request, {
      storage: new R2Storage(env.BUCKET),
      adminToken: env.ADMIN_TOKEN,
      readToken: env.READ_TOKEN,
      publicRead: env.PUBLIC_READ !== 'false',
      maxPushBytes: maxPushBytes(env.MAX_PUSH_BYTES),
    })
  },
  async scheduled(controller): Promise<void> {
    console.log(JSON.stringify({ event: 'scheduled', cron: controller.cron, at: new Date(controller.scheduledTime).toISOString(), task: 'mirror-sync', status: 'not-implemented' }))
  },
} satisfies ExportedHandler<Env>
