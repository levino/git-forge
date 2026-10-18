import type { Database } from '@git-forge/accounts'
import { isValidName, type RepositoryName, readRefs, resolveCommitish, type Storage } from '@git-forge/core'
import { issueToken } from './store.ts'

export type ActionReference = {
  readonly nameWithOwner: string
  readonly ref: string
  readonly path?: string
}

export type ActionDownloadInfo = {
  readonly nameWithOwner: string
  readonly resolvedNameWithOwner: string
  readonly ref: string
  readonly resolvedSha: string
  readonly tarballUrl: string
  readonly zipballUrl: string
  readonly authentication: { readonly token: string; readonly expiresAt: string } | null
}

export type ActionSources = {
  readonly repositories?: Readonly<Record<string, string>>
  readonly githubFallback?: string | null
  readonly canUse?: (job: RepositoryName, action: RepositoryName) => Promise<boolean>
}

export type ActionJob = {
  readonly owner: string
  readonly repo: string
  readonly jobId: string
  readonly expiresAt: number
}

export type ActionResolution = {
  readonly resolved: Readonly<Record<string, ActionDownloadInfo>>
  readonly unresolved: readonly string[]
}

export const GITHUB_API = 'https://api.github.com'

export const actionKey = (reference: ActionReference): string => `${reference.nameWithOwner}@${reference.ref}`

const splitName = (nameWithOwner: string): RepositoryName | null => {
  const [owner, name, ...rest] = nameWithOwner.split('/')
  return owner && name && rest.length === 0 && isValidName(owner) && isValidName(name) ? { owner, name } : null
}

export const mapActionRepository = (nameWithOwner: string, repositories: Readonly<Record<string, string>> = {}): RepositoryName | null => {
  const exact = Object.entries(repositories).find(([pattern]) => pattern.toLowerCase() === nameWithOwner.toLowerCase())
  if (exact) return splitName(exact[1])
  const [owner, name] = nameWithOwner.split('/')
  for (const [pattern, target] of Object.entries(repositories)) {
    if (!pattern.endsWith('/*') || pattern.slice(0, -2).toLowerCase() !== owner?.toLowerCase()) continue
    return splitName(target.replace(/\*/g, name ?? ''))
  }
  return splitName(nameWithOwner)
}

const isMappedTarget = (repo: RepositoryName, repositories: Readonly<Record<string, string>> = {}): boolean =>
  Object.values(repositories).some((target) => {
    const [owner, name] = target.split('/')
    return owner === repo.owner && (name === '*' || name === repo.name || (name?.includes('*') ?? false))
  })

export const resolveActionDownloads = async (
  db: Database,
  storage: Storage,
  serverUrl: string,
  sources: ActionSources,
  job: ActionJob,
  references: readonly ActionReference[],
  now: number,
): Promise<ActionResolution> => {
  const resolved: Record<string, ActionDownloadInfo> = {}
  const unresolved: string[] = []
  for (const reference of references) {
    const key = actionKey(reference)
    if (resolved[key]) continue
    const local = mapActionRepository(reference.nameWithOwner, sources.repositories)
    const allowed =
      local !== null &&
      (await readRefs(storage, local)) !== null &&
      (sources.canUse ? await sources.canUse({ owner: job.owner, name: job.repo }, local) : local.owner === job.owner || isMappedTarget(local, sources.repositories))
    const sha = allowed && local ? await resolveCommitish(storage, local, reference.ref) : null
    if (local && sha) {
      const token = await issueToken(db, { kind: 'github', jobId: job.jobId, owner: local.owner, repo: local.name, ttlMs: Math.max(60_000, job.expiresAt - now) }, now)
      const base = `${serverUrl}/api/v3/repos/${local.owner}/${local.name}`
      resolved[key] = {
        nameWithOwner: reference.nameWithOwner,
        resolvedNameWithOwner: `${local.owner}/${local.name}`,
        ref: reference.ref,
        resolvedSha: sha,
        tarballUrl: `${base}/tarball/${sha}`,
        zipballUrl: `${base}/zipball/${sha}`,
        authentication: { token, expiresAt: new Date(job.expiresAt).toISOString() },
      }
      continue
    }
    if (sources.githubFallback) {
      const base = `${sources.githubFallback.replace(/\/$/, '')}/repos/${reference.nameWithOwner}`
      resolved[key] = {
        nameWithOwner: reference.nameWithOwner,
        resolvedNameWithOwner: reference.nameWithOwner,
        ref: reference.ref,
        resolvedSha: reference.ref,
        tarballUrl: `${base}/tarball/${encodeURIComponent(reference.ref)}`,
        zipballUrl: `${base}/zipball/${encodeURIComponent(reference.ref)}`,
        authentication: null,
      }
      continue
    }
    unresolved.push(key)
  }
  return { resolved, unresolved }
}
