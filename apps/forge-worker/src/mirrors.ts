import { type AccountsStore, mintInstanceToken, normalizeIssuer, type SigningKey } from '@git-forge/accounts'
import {
  type AuthorizationSupplier,
  type FetchFunction,
  isMirrorDue,
  isValidName,
  listMirrors,
  type MirrorConfig,
  readMirrorStatus,
  type RepositoryName,
  type Storage,
  syncMirror,
  type SyncResult,
} from '@git-forge/core'

export type MirrorContext = {
  readonly storage: Storage
  readonly store: AccountsStore
  readonly issuer: string | undefined
  readonly instanceKey: SigningKey | undefined
  readonly fetch?: FetchFunction
}

const UPSTREAM_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/

export const upstreamRepository = (url: string): string | null => {
  const match = UPSTREAM_PATH.exec(new URL(url).pathname)
  if (!match) return null
  const [, owner, name] = match as unknown as [string, string, string]
  return isValidName(owner) && isValidName(name) ? `${owner}/${name}` : null
}

export class MirrorAuthError extends Error {}

export const mirrorAuthorization = (context: MirrorContext, config: MirrorConfig): AuthorizationSupplier | undefined => {
  if (config.auth !== 'instance') return undefined
  const { issuer, instanceKey } = context
  if (!issuer || !instanceKey) throw new MirrorAuthError('instance federation needs PUBLIC_URL and INSTANCE_KEY')
  const repository = upstreamRepository(config.url)
  if (!repository) throw new MirrorAuthError(`cannot derive owner/name from ${config.url}`)
  const audience = normalizeIssuer(new URL(config.url).origin)
  return async () => `Bearer ${await mintInstanceToken({ key: instanceKey, issuer, audience, repositories: [repository] })}`
}

export const runMirrorSync = async (context: MirrorContext, repo: RepositoryName, config: MirrorConfig): Promise<SyncResult> => {
  const getAuthorization = mirrorAuthorization(context, config)
  return syncMirror({
    storage: context.storage,
    repo,
    remote: config.remote,
    strategy: 'auto',
    ...(context.fetch ? { fetch: context.fetch } : {}),
    ...(getAuthorization ? { getAuthorization } : {}),
  })
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
