import type { Principal, RepositorySubject } from '@git-forge/accounts'
import type { ForgeServices } from '../app.ts'

export const visibleRepositories = async (forge: ForgeServices, principal: Principal, owner?: string): Promise<RepositorySubject[]> => {
  const all = await forge.store.listRepositories()
  const candidates = owner === undefined ? all : all.filter((repo) => repo.owner.toLowerCase() === owner.toLowerCase())
  const checks = await Promise.all(candidates.map(async (repo) => ((await forge.repositoryAccess(principal, repo, 'read')).decision === 'allow' ? repo : null)))
  return checks.filter((repo): repo is RepositorySubject => repo !== null).sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`))
}
