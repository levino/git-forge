import { R2Storage } from '@git-forge/cloudflare'
import { handleRequest } from './app.ts'

export type Env = {
  readonly BUCKET: R2Bucket
  readonly DB: D1Database
  readonly ADMIN_TOKEN?: string
  readonly PUBLIC_READ?: string
  readonly MAX_PUSH_BYTES?: string
  readonly PACKFILE_URI_BASE?: string
  readonly COMPACT_MAX_BYTES?: string
}

const positive = (value: string | undefined): number | undefined => {
  const parsed = Number(value)
  return value && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const maxPushBytes = positive(env.MAX_PUSH_BYTES)
    const compactMaxBytes = positive(env.COMPACT_MAX_BYTES)
    return handleRequest(request, {
      storage: new R2Storage(env.BUCKET),
      adminToken: env.ADMIN_TOKEN,
      publicRead: env.PUBLIC_READ !== 'false',
      ...(maxPushBytes !== undefined ? { maxPushBytes } : {}),
      ...(compactMaxBytes !== undefined ? { compactMaxBytes } : {}),
      ...(env.PACKFILE_URI_BASE ? { packfileUriBase: env.PACKFILE_URI_BASE } : {}),
      waitUntil: (promise) => ctx.waitUntil(promise),
    })
  },
  async scheduled(controller): Promise<void> {
    console.log(JSON.stringify({ event: 'scheduled', cron: controller.cron, at: new Date(controller.scheduledTime).toISOString(), task: 'mirror-sync', status: 'not-implemented' }))
  },
} satisfies ExportedHandler<Env>
