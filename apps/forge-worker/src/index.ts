import { applyMigrations, createAccountsStore, createJwksCache, d1Database, importSigningKey, MIGRATIONS, normalizeIssuer, type PrivateJwk } from '@git-forge/accounts'
import { consumeJobs, QueueJobs, R2Storage } from '@git-forge/cloudflare'
import { handleRequest } from './app.ts'
import { DEFAULT_DEEP_CHECK_DAYS, DEFAULT_SAFETY_SYNC_HOURS, type ForgeJob, type MirrorFederation, runJob, scheduleSafetyNet } from './mirror-federation.ts'

export type Env = {
  readonly BUCKET: R2Bucket
  readonly DB: D1Database
  readonly JOBS?: Queue<ForgeJob>
  readonly ADMIN_TOKEN?: string
  readonly READ_TOKEN?: string
  readonly PUBLIC_READ?: string
  readonly MAX_PUSH_BYTES?: string
  readonly PUBLIC_URL?: string
  readonly INSTANCE_KEY?: string
  readonly ALLOW_INSECURE_FEDERATION?: string
  readonly MIRROR_SAFETY_SYNC_HOURS?: string
  readonly MIRROR_DEEP_CHECK_DAYS?: string
}

const DEFAULT_MAX_PUSH_BYTES = 16 * 1024 * 1024

const integer = (value: string | undefined, fallback: number, allowZero = false): number => {
  const parsed = Number(value)
  return value !== undefined && value.trim() !== '' && Number.isSafeInteger(parsed) && (parsed > 0 || (allowZero && parsed === 0)) ? parsed : fallback
}

let federation: Promise<MirrorFederation | undefined> | undefined

const federationFor = (env: Env): Promise<MirrorFederation | undefined> => {
  federation ??= (async () => {
    if (!env.PUBLIC_URL || !env.INSTANCE_KEY || !env.JOBS) return undefined
    const db = d1Database(env.DB)
    await applyMigrations(db, MIGRATIONS)
    const publicRead = env.PUBLIC_READ !== 'false'
    return {
      storage: new R2Storage(env.BUCKET),
      store: createAccountsStore(db),
      issuer: normalizeIssuer(env.PUBLIC_URL),
      key: await importSigningKey(JSON.parse(env.INSTANCE_KEY) as PrivateJwk),
      jwks: createJwksCache({ allowInsecureHttp: env.ALLOW_INSECURE_FEDERATION === 'true' }),
      jobs: new QueueJobs(env.JOBS),
      canRead: async () => publicRead,
      safetySyncHours: integer(env.MIRROR_SAFETY_SYNC_HOURS, DEFAULT_SAFETY_SYNC_HOURS, true),
      deepCheckDays: integer(env.MIRROR_DEEP_CHECK_DAYS, DEFAULT_DEEP_CHECK_DAYS, true),
    }
  })().catch((error: unknown) => {
    federation = undefined
    throw error
  })
  return federation
}

export default {
  async fetch(request, env): Promise<Response> {
    const mirrors = await federationFor(env)
    return handleRequest(request, {
      storage: new R2Storage(env.BUCKET),
      adminToken: env.ADMIN_TOKEN,
      readToken: env.READ_TOKEN,
      publicRead: env.PUBLIC_READ !== 'false',
      maxPushBytes: integer(env.MAX_PUSH_BYTES, DEFAULT_MAX_PUSH_BYTES),
      ...(mirrors ? { federation: mirrors } : {}),
    })
  },
  async queue(batch, env): Promise<void> {
    const mirrors = await federationFor(env)
    if (!mirrors) {
      batch.retryAll({ delaySeconds: 3600 })
      return
    }
    const outcomes = await consumeJobs(batch, (job) => runJob(mirrors, job))
    console.log(JSON.stringify({ event: 'jobs', outcomes }))
  },
  async scheduled(controller, env): Promise<void> {
    const mirrors = await federationFor(env)
    const work = mirrors ? await scheduleSafetyNet(mirrors, new Date(controller.scheduledTime)) : null
    console.log(JSON.stringify({ event: 'scheduled', cron: controller.cron, at: new Date(controller.scheduledTime).toISOString(), task: 'mirror-safety-net', work }))
  },
} satisfies ExportedHandler<Env, ForgeJob>
