import {
  type AccountsStore,
  AccountsError,
  canAdministerInstance,
  constantTimeEqual,
  DEFAULT_OIDC_SCOPES,
  discoverOidc,
  InstanceAdministrationError,
  isReservedLogin,
  type LoginStore,
  normalizeOidcIssuer,
  type OidcClientConfig,
  type Principal,
  type UserPrincipal,
} from '@git-forge/accounts'
import { type ImportState, readImportState, type Storage } from '@git-forge/core'
import { type CostEstimate, estimateMonthlyCost } from './costs.ts'
import type { JobFailure, JobFailures } from './jobs.ts'
import type { InstanceSettings } from './settings.ts'
import { type Location, median, type SetupCheck, type SetupFacts, setupChecks } from './setup.ts'
import { commitPin, INSTANCE_CONFIG_PATH, INSTANCE_REPOSITORY, isNewer, type Outbound, parseVersion, readPin, RELEASE_CHECK_MS, RELEASE_REPOSITORY, type ReleaseCheck, releaseChecksum, UpdateError } from './updates.ts'
import type { RepositoryUsage, UsageMeter, UsageScanJob } from './usage.ts'

export class AdminError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export type OidcSettings = { readonly issuer: string; readonly clientId: string; readonly name: string }

export type OidcView = { readonly source: 'vars' | 'settings' | null; readonly issuer: string | null; readonly clientId: string | null; readonly name: string | null; readonly hasSecret: boolean }

export type SetupView = { readonly checks: readonly SetupCheck[]; readonly oidc: OidcView; readonly canSeal: boolean }

export type ImportEntry = { readonly repository: string; readonly state: ImportState }

export type UpdateView = {
  readonly running: string
  readonly release: ReleaseCheck | null
  readonly newer: boolean
  readonly pin: string | null
  readonly repository: string | null
  readonly last: { readonly version: string; readonly commitUrl: string; readonly at: number } | null
}

export type AdminOverview = {
  readonly update: UpdateView
  readonly imports: readonly ImportEntry[]
  readonly failures: readonly JobFailure[]
  readonly usage: readonly RepositoryUsage[]
  readonly cost: CostEstimate
}

export type Claim = { readonly login: string; readonly token?: string; readonly invitePath?: string }

export type AdminOperationsOptions = {
  readonly store: AccountsStore
  readonly logins: LoginStore
  readonly storage: Storage
  readonly settings: InstanceSettings
  readonly failures: JobFailures
  readonly meter: UsageMeter
  readonly fetch: Outbound
  readonly now: () => number
  readonly version: string
  readonly bootstrapToken: string | undefined
  readonly varsOidc: OidcClientConfig | null
  readonly facts: Omit<SetupFacts, keyof Location | 'databaseMs' | 'storageMs' | 'oidc'>
  readonly location: (request: Request) => Promise<Location>
  readonly pingDatabase: () => Promise<unknown>
  readonly enqueue: (job: Record<string, unknown> & { readonly kind: string }) => Promise<void>
  readonly onOidcChanged: () => void
}

const OIDC = 'oidc'
const OIDC_SECRET = 'oidc:secret'
const RELEASE = 'release:latest'
const UPDATE_REPOSITORY = 'update:repository'
const UPDATE_TOKEN = 'update:token'
const UPDATE_LAST = 'update:last'
const RECENT_IMPORT_MS = 7 * 24 * 60 * 60 * 1000

export const readOidcSettings = async (settings: InstanceSettings): Promise<OidcClientConfig | null> => {
  const stored = await settings.get<OidcSettings>(OIDC)
  if (!stored) return null
  const secret = await settings.secret(OIDC_SECRET)
  return { issuer: stored.issuer, clientId: stored.clientId, clientSecret: secret ?? undefined, scopes: [...DEFAULT_OIDC_SCOPES], name: stored.name || 'single sign-on' }
}

const failed = (error: unknown): AdminError => new AdminError(error instanceof UpdateError ? 502 : 500, (error as Error).message)

export const createAdminOperations = (options: AdminOperationsOptions) => {
  const { store, settings, now } = options
  let claimed = false

  const administrator = async (principal: Principal): Promise<UserPrincipal> => {
    if (principal.kind !== 'user') throw new InstanceAdministrationError(401, 'authentication required')
    if (!canAdministerInstance(principal, await store.isInstanceAdmin(principal.id))) throw new InstanceAdministrationError(403, 'instance admin required')
    return principal
  }

  const claimable = async (): Promise<boolean> => {
    if (claimed) return false
    claimed = (await store.listInstanceAdmins()).length > 0
    return !claimed
  }

  const releaseCheck = async (force: boolean): Promise<ReleaseCheck> => {
    const cached = await settings.get<ReleaseCheck>(RELEASE)
    if (cached && !force && now() - cached.checkedAt < RELEASE_CHECK_MS) return cached
    let check: ReleaseCheck
    try {
      const response = await options.fetch(`https://github.com/${RELEASE_REPOSITORY}/releases/latest`, { redirect: 'manual', headers: { 'User-Agent': 'git-forge' } })
      const location = response.headers.get('Location') ?? ''
      const version = /\/releases\/tag\/v?([^/?#]+)$/.exec(location)?.[1] ?? ''
      if (!parseVersion(version)) throw new UpdateError(`no release found (GitHub answered ${response.status})`)
      check = { checkedAt: now(), latest: { version, url: location, sha256: await releaseChecksum(options.fetch, version) } }
    } catch (error) {
      check = { checkedAt: now(), latest: cached?.latest ?? null, error: (error as Error).message }
    }
    await settings.set(RELEASE, check)
    return check
  }

  const updateView = async (force: boolean): Promise<UpdateView> => {
    const release = await releaseCheck(force)
    const latest = release.latest
    return {
      running: options.version,
      release,
      newer: latest !== null && isNewer(latest.version, options.version),
      pin: latest ? `V=${latest.version} S=${latest.sha256}` : null,
      repository: (await settings.get<string>(UPDATE_REPOSITORY)) ?? null,
      last: await settings.get(UPDATE_LAST),
    }
  }

  const imports = async (): Promise<ImportEntry[]> => {
    const entries: ImportEntry[] = []
    for (const subject of await store.listRepositories()) {
      const state = await readImportState(options.storage, { owner: subject.owner, name: subject.name })
      if (state && (state.phase !== 'done' || now() - Date.parse(state.finishedAt ?? state.updatedAt) < RECENT_IMPORT_MS)) entries.push({ repository: `${subject.owner}/${subject.name}`, state })
    }
    return entries
  }

  const oidcView = async (): Promise<OidcView> => {
    if (options.varsOidc) return { source: 'vars', issuer: options.varsOidc.issuer, clientId: options.varsOidc.clientId, name: options.varsOidc.name, hasSecret: options.varsOidc.clientSecret !== undefined }
    const stored = await settings.get<OidcSettings>(OIDC)
    return stored
      ? { source: 'settings', issuer: stored.issuer, clientId: stored.clientId, name: stored.name, hasSecret: (await settings.get(OIDC_SECRET)) !== null }
      : { source: null, issuer: null, clientId: null, name: null, hasSecret: false }
  }

  return {
    claimable,

    claim: async (presented: string, input: { readonly login: string; readonly email?: string }, issue: 'token' | 'invite'): Promise<Claim> => {
      if (!options.bootstrapToken) throw new AdminError(503, 'BOOTSTRAP_TOKEN is not configured')
      if (!(await constantTimeEqual(presented, options.bootstrapToken))) throw new AdminError(401, 'invalid bootstrap token')
      if (isReservedLogin(input.login)) throw new AdminError(422, `${input.login} is reserved`)
      let admin: { readonly id: string } | null
      try {
        admin = await store.bootstrapInstanceAdmin(input)
      } catch (error) {
        if (error instanceof AccountsError) throw new AdminError(400, error.message)
        throw error
      }
      if (!admin) throw new AdminError(409, 'this instance already has an admin')
      claimed = true
      if (issue === 'token') {
        const token = await store.createPersonalAccessToken(admin.id, { name: 'bootstrap', scopes: ['repo:admin'], expiresAt: null }, { kind: 'system' })
        return { login: input.login, token: token.token }
      }
      const invite = await options.logins.createInvite({ userId: admin.id }, { kind: 'system' })
      return { login: input.login, invitePath: `/login/invite/${invite.code}` }
    },

    oidc: async (): Promise<OidcClientConfig | null> => options.varsOidc ?? (await readOidcSettings(settings)),

    setup: async (principal: Principal, request: Request): Promise<SetupView> => {
      await administrator(principal)
      const oidc = await oidcView()
      const location = await options.location(request).catch(() => ({ colo: null, databaseRegion: null }))
      const databaseMs = await median(3, options.pingDatabase)
      const storageMs = await median(3, () => options.storage.head('setup/latency-probe'))
      return { checks: setupChecks({ ...options.facts, ...location, databaseMs, storageMs, oidc: oidc.source }), oidc, canSeal: await settings.canSeal() }
    },

    saveOidc: async (principal: Principal, input: { readonly issuer: string; readonly clientId: string; readonly clientSecret?: string; readonly name?: string }): Promise<OidcView> => {
      await administrator(principal)
      if (options.varsOidc) throw new AdminError(409, 'OIDC is configured by the OIDC_ISSUER and OIDC_CLIENT_ID vars, which win; change it in wrangler.toml')
      let issuer: string
      try {
        issuer = normalizeOidcIssuer(input.issuer)
      } catch (error) {
        throw new AdminError(422, (error as Error).message)
      }
      const clientId = input.clientId.trim()
      if (!clientId) throw new AdminError(422, 'client id is required')
      try {
        await discoverOidc(issuer, options.fetch)
      } catch (error) {
        throw new AdminError(422, `discovery at ${issuer} failed: ${(error as Error).message}`)
      }
      const secret = input.clientSecret?.trim()
      if (secret) {
        if (!(await settings.canSeal())) throw new AdminError(422, 'a client secret needs ACTIONS_SECRETS_KEY or BOOTSTRAP_TOKEN to be encrypted')
        await settings.setSecret(OIDC_SECRET, secret)
      }
      await settings.set(OIDC, { issuer, clientId, name: input.name?.trim() ?? '' } satisfies OidcSettings)
      options.onOidcChanged()
      return oidcView()
    },

    clearOidc: async (principal: Principal): Promise<void> => {
      await administrator(principal)
      await settings.remove(OIDC)
      await settings.remove(OIDC_SECRET)
      options.onOidcChanged()
    },

    overview: async (principal: Principal): Promise<AdminOverview> => {
      await administrator(principal)
      const usage = await options.meter.repositories()
      const stored = usage.reduce((sum, entry) => sum + entry.gitBytes + entry.lfsBytes, 0)
      return {
        update: await updateView(false),
        imports: await imports(),
        failures: await options.failures.list(50),
        usage,
        cost: estimateMonthlyCost(stored, await options.meter.counters(now()), now()),
      }
    },

    checkUpdate: async (principal: Principal): Promise<UpdateView> => {
      await administrator(principal)
      return updateView(true)
    },

    setUpdateRepository: async (principal: Principal, input: { readonly repository: string; readonly token: string }): Promise<string> => {
      await administrator(principal)
      const repository = input.repository.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')
      if (!INSTANCE_REPOSITORY.test(repository)) throw new AdminError(422, 'repository must look like owner/name')
      const token = input.token.trim()
      if (!token) throw new AdminError(422, 'token is required')
      if (!(await settings.canSeal())) throw new AdminError(422, 'storing a token needs ACTIONS_SECRETS_KEY or BOOTSTRAP_TOKEN to encrypt it')
      const response = await options.fetch(`https://api.github.com/repos/${repository}/contents/${INSTANCE_CONFIG_PATH}`, {
        headers: { Accept: 'application/vnd.github.raw+json', Authorization: `Bearer ${token}`, 'User-Agent': 'git-forge' },
      })
      if (!response.ok) throw new AdminError(422, `cannot read ${INSTANCE_CONFIG_PATH} in ${repository} with this token (GitHub answered ${response.status})`)
      if (!readPin(await response.text())) throw new AdminError(422, `${repository}/${INSTANCE_CONFIG_PATH} has no V=<version> S=<sha256> pin`)
      await settings.setSecret(UPDATE_TOKEN, token)
      await settings.set(UPDATE_REPOSITORY, repository)
      return repository
    },

    clearUpdateRepository: async (principal: Principal): Promise<void> => {
      await administrator(principal)
      await settings.remove(UPDATE_REPOSITORY)
      await settings.remove(UPDATE_TOKEN)
    },

    update: async (principal: Principal): Promise<{ readonly version: string; readonly commitUrl: string }> => {
      await administrator(principal)
      const repository = await settings.get<string>(UPDATE_REPOSITORY)
      const token = await settings.secret(UPDATE_TOKEN)
      if (!repository || !token) throw new AdminError(409, 'connect the instance repository first')
      const view = await updateView(true)
      if (!view.release?.latest || !view.newer) throw new AdminError(409, view.release?.error ?? `${options.version} is the latest release`)
      const { version, sha256 } = view.release.latest
      try {
        const { commitUrl } = await commitPin(options.fetch, { repository, token }, { version, sha256 })
        await settings.set(UPDATE_LAST, { version, commitUrl, at: now() })
        return { version, commitUrl }
      } catch (error) {
        throw failed(error)
      }
    },

    retryJob: async (principal: Principal, id: string): Promise<void> => {
      await administrator(principal)
      const job = await options.failures.take(id)
      if (!job) throw new AdminError(404, 'job not found')
      await options.enqueue(job)
    },

    recountUsage: async (principal: Principal): Promise<number> => {
      await administrator(principal)
      const repositories = await store.listRepositories()
      for (const subject of repositories) await options.enqueue({ kind: 'usage-scan', repository: `${subject.owner}/${subject.name}` } satisfies UsageScanJob)
      return repositories.length
    },
  }
}

export type AdminOperations = ReturnType<typeof createAdminOperations>
