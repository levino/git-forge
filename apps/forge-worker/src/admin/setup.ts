export type CheckStatus = 'ok' | 'warn' | 'info'

export type SetupCheck = {
  readonly id: string
  readonly title: string
  readonly status: CheckStatus
  readonly detail: string
  readonly steps?: readonly string[]
  readonly link?: string
}

export type Location = { readonly colo: string | null; readonly databaseRegion: string | null }

export type SetupFacts = Location & {
  readonly databaseMs: number
  readonly storageMs: number
  readonly presigned: boolean
  readonly maxLfsObjectBytes: number
  readonly imports: boolean
  readonly jobs: boolean
  readonly actions: boolean
  readonly runners: boolean
  readonly oidc: 'vars' | 'settings' | null
  readonly publicUrl: string | null
}

export const DATABASE_SLOW_MS = 50

export const STORAGE_SLOW_MS = 100

const README = 'https://github.com/levino/git-forge/tree/main/templates/instance'

export const median = async (samples: number, measure: () => Promise<unknown>): Promise<number> => {
  const times: number[] = []
  for (let i = 0; i < samples; i++) {
    const start = performance.now()
    await measure()
    times.push(performance.now() - start)
  }
  return Math.round(times.sort((a, b) => a - b)[Math.floor(samples / 2)]!)
}

const mib = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MiB`

export const setupChecks = (facts: SetupFacts): SetupCheck[] => {
  const where = [facts.colo ? `Worker in ${facts.colo}` : null, facts.databaseRegion ? `database in ${facts.databaseRegion}` : null].filter(Boolean).join(', ')
  return [
    {
      id: 'public-url',
      title: 'Public URL',
      status: facts.publicUrl ? 'ok' : 'info',
      detail: facts.publicUrl ?? 'PUBLIC_URL is not set; the request origin is used.',
      ...(facts.publicUrl ? {} : { steps: ['Set PUBLIC_URL under [vars] in wrangler.toml when the instance has its own domain.'], link: `${README}#domain` }),
    },
    {
      id: 'oidc',
      title: 'Single sign-on (OIDC)',
      status: facts.oidc ? 'ok' : 'info',
      detail: facts.oidc === 'vars' ? 'Configured by OIDC_* vars in wrangler.toml.' : facts.oidc === 'settings' ? 'Configured here.' : 'Not configured; passkeys only.',
    },
    {
      id: 'database',
      title: 'D1 location',
      status: facts.databaseMs > DATABASE_SLOW_MS ? 'warn' : 'ok',
      detail: `${facts.databaseMs} ms per query${where ? ` (${where})` : ''}.`,
      ...(facts.databaseMs > DATABASE_SLOW_MS
        ? { steps: ['The database is far from where the Worker runs. D1 stays where it was created; a new database with a location hint near your users fixes it.'], link: 'https://developers.cloudflare.com/d1/configuration/data-location/' }
        : {}),
    },
    {
      id: 'storage',
      title: 'R2 location',
      status: facts.storageMs > STORAGE_SLOW_MS ? 'warn' : 'ok',
      detail: `${facts.storageMs} ms per request${facts.colo ? ` (Worker in ${facts.colo})` : ''}.`,
      ...(facts.storageMs > STORAGE_SLOW_MS
        ? { steps: ['The bucket is far from where the Worker runs. A bucket keeps its location; a new bucket with a location hint near your users fixes it.'], link: 'https://developers.cloudflare.com/r2/reference/data-location/' }
        : {}),
    },
    {
      id: 'presigned-lfs',
      title: 'Large LFS objects',
      status: facts.presigned ? 'ok' : 'info',
      detail: facts.presigned ? `Uploads go straight to R2, up to ${mib(facts.maxLfsObjectBytes)} per object.` : `Uploads go through the Worker, up to ${mib(facts.maxLfsObjectBytes)} per object.`,
      ...(facts.presigned
        ? {}
        : {
            steps: [
              'Cloudflare dashboard: R2 → Manage API tokens → Create Account API token, permission "Object Read & Write", only this instance\'s bucket.',
              'Worker → Settings → Variables and Secrets: add the secrets R2_ACCESS_KEY_ID (Access Key ID) and R2_SECRET_ACCESS_KEY (Secret Access Key).',
              'wrangler.toml, under [vars]: R2_S3_ENDPOINT = "https://<account id>.r2.cloudflarestorage.com", R2_BUCKET_NAME = "<bucket_name of BUCKET>", MAX_LFS_OBJECT_BYTES = "5368709120". Commit; Workers Builds deploys.',
            ],
            link: `${README}#large-lfs-objects`,
          }),
    },
    {
      id: 'queues',
      title: 'Queues',
      status: facts.imports && facts.jobs ? 'ok' : 'warn',
      detail: [`imports ${facts.imports ? 'present' : 'missing'}`, `jobs ${facts.jobs ? 'present' : 'missing'}`].join(', ') + '.',
      ...(facts.imports && facts.jobs
        ? {}
        : { steps: ['Copy the [[queues.producers]] (IMPORTS, JOBS) and [[queues.consumers]] entries from the template\'s wrangler.toml; the jobs queue name must end in -jobs.'], link: README }),
    },
    {
      id: 'actions',
      title: 'Actions',
      status: facts.actions ? 'ok' : 'info',
      detail: !facts.actions ? 'Off.' : facts.runners ? 'On, with runner containers.' : 'On, without runner containers: jobs wait for runners you register.',
      ...(facts.actions && facts.runners ? {} : { steps: ['Add ACTIONS = "true" and the [[containers]] entries from the README to wrangler.toml.'], link: `${README}#ci-opt-in` }),
    },
  ]
}
