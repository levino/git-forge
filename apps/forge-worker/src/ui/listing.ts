import type { Principal, RepositorySubject } from '@git-forge/accounts'
import { defaultBranch, ObjectDatabase, readCommit, readRefs } from '@git-forge/core'
import type { ForgeServices } from '../app.ts'

export type RepositorySummary = RepositorySubject & { readonly defaultBranch: string | null; readonly updatedAt: number | null }

export const visibleRepositories = async (forge: ForgeServices, principal: Principal, owner?: string): Promise<RepositorySubject[]> => {
  const all = await forge.store.listRepositories()
  const candidates = owner === undefined ? all : all.filter((repo) => repo.owner.toLowerCase() === owner.toLowerCase())
  const checks = await Promise.all(candidates.map(async (repo) => ((await forge.repositoryAccess(principal, repo, 'read')).decision === 'allow' ? repo : null)))
  return checks.filter((repo): repo is RepositorySubject => repo !== null).sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`))
}

const summarize = async (forge: ForgeServices, repo: RepositorySubject): Promise<RepositorySummary> => {
  const state = (await readRefs(forge.storage, repo))?.state
  const head = state?.refs[state.head]
  const commit = head ? await readCommit(new ObjectDatabase(forge.storage, repo), head).catch(() => null) : null
  return { ...repo, defaultBranch: state ? defaultBranch(state) : null, updatedAt: commit?.committer.timestamp ?? null }
}

export const repositorySummaries = async (forge: ForgeServices, repositories: readonly RepositorySubject[]): Promise<RepositorySummary[]> =>
  (await Promise.all(repositories.map((repo) => summarize(forge, repo)))).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
