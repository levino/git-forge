import { type AccountsStore, mintInstanceToken, normalizeIssuer, type SigningKey } from '@git-forge/accounts'
import {
  type AuthorizationSupplier,
  type DigestFactory,
  type FetchFunction,
  isMirrorDue,
  isValidName,
  listMirrors,
  type MirrorConfig,
  readMirrorStatus,
  type RepositoryName,
  type Storage,
  syncMirror,
  type SyncOptions,
  type SyncResult,
  type UnitOptions,
} from '@git-forge/core'
import type { MirrorSecrets } from './mirror-secrets.ts'

export type MirrorContext = {
  readonly storage: Storage
  readonly store: AccountsStore
  readonly issuer: string | undefined
  readonly instanceKey: SigningKey | undefined
  readonly fetch?: FetchFunction
  readonly digests?: DigestFactory
  readonly secrets?: MirrorSecrets
  readonly onSynced?: (repo: RepositoryName, config: MirrorConfig, result: SyncResult) => Promise<void>
}

const UPSTREAM_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/

export const upstreamRepository = (url: string): string | null => {
  const match = UPSTREAM_PATH.exec(new URL(url).pathname)
  if (!match) return null
  const [, owner, name] = match as unknown as [string, string, string]
  return isValidName(owner) && isValidName(name) ? `${owner}/${name}` : null
}

export class MirrorAuthError extends Error {}

export const tokenAuthorization = (token: string): string => {
  let binary = ''
  for (const byte of new TextEncoder().encode(`x-access-token:${token}`)) binary += String.fromCharCode(byte)
  return `Basic ${btoa(binary)}`
}

const storedToken = (context: MirrorContext, repo: RepositoryName, config: MirrorConfig): AuthorizationSupplier => {
  let cached: Promise<string> | undefined
  return () =>
    (cached ??= (async () => {
      const token = await context.secrets?.get(repo, config.remote, 'token')
      if (!token) throw new MirrorAuthError(`no stored token for mirror ${config.remote} of ${repo.owner}/${repo.name}`)
      return tokenAuthorization(token)
    })())
}

export const mirrorAuthorization = (context: MirrorContext, config: MirrorConfig, repo?: RepositoryName): AuthorizationSupplier | undefined => {
  if (config.auth === 'token' && repo) return storedToken(context, repo, config)
  if (config.auth !== 'instance') return undefined
  const { issuer, instanceKey } = context
  if (!issuer || !instanceKey) throw new MirrorAuthError('instance federation needs PUBLIC_URL and INSTANCE_KEY')
  const repository = upstreamRepository(config.url)
  if (!repository) throw new MirrorAuthError(`cannot derive owner/name from ${config.url}`)
  const audience = normalizeIssuer(new URL(config.url).origin)
  return async () => `Bearer ${await mintInstanceToken({ key: instanceKey, issuer, audience, repositories: [repository] })}`
}

export const mirrorUnitOptions = (context: MirrorContext, repo: RepositoryName, config: MirrorConfig, maxUnitBytes?: number): UnitOptions => {
  const getAuthorization = mirrorAuthorization(context, config, repo)
  return {
    storage: context.storage,
    repo,
    remote: config.remote,
    ...(context.fetch ? { fetch: context.fetch } : {}),
    ...(getAuthorization ? { getAuthorization } : {}),
    ...(context.digests ? { digests: context.digests } : {}),
    ...(maxUnitBytes ? { maxUnitBytes } : {}),
  }
}

export const runMirrorSync = async (
  context: MirrorContext,
  repo: RepositoryName,
  config: MirrorConfig,
  extra: Pick<SyncOptions, 'deferLfs' | 'maxSteps'> = {},
): Promise<SyncResult> => {
  const result = await syncMirror({ ...mirrorUnitOptions(context, repo, config), strategy: 'auto', ...extra })
  if (context.onSynced) await context.onSynced(repo, config, result)
  return result
}

export type ScheduledMirrorRun = {
  readonly repository: string
  readonly remote: string
  readonly status: SyncResult['status'] | 'queued'
  readonly updates: number
  readonly alarms: number
  readonly error?: string
}

const MINUTE = 60_000

export const syncDueMirrors = async (context: MirrorContext, now: Date, intervalMinutes: number): Promise<ScheduledMirrorRun[]> => {
  const intervalMs = Math.max(0, intervalMinutes * MINUTE - MINUTE)
  const runs: ScheduledMirrorRun[] = []
  for (const subject of await context.store.listRepositories()) {
    const repo = { owner: subject.owner, name: subject.name }
    for (const config of await listMirrors(context.storage, repo)) {
      if (!isMirrorDue(config, await readMirrorStatus(context.storage, repo, config.remote), now, intervalMs)) continue
      const repository = `${repo.owner}/${repo.name}`
      try {
        const result = await runMirrorSync(context, repo, config)
        runs.push({
          repository,
          remote: config.remote,
          status: result.status,
          updates: result.updates.length,
          alarms: result.alarms.length,
          ...(result.error ? { error: result.error } : {}),
        })
      } catch (error) {
        runs.push({ repository, remote: config.remote, status: 'failed', updates: 0, alarms: 0, error: (error as Error).message })
      }
    }
  }
  return runs
}
