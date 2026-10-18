import type { Page, Principal, RepositoryListing, RepositorySort } from '@git-forge/accounts'
import type { ForgeServices } from '../app.ts'
import { parsePage } from './history.ts'

export type RepositoryPage = Page<RepositoryListing> & { readonly sort: RepositorySort }

export const REPOSITORIES_PER_PAGE = 30

export const repositoryPage = async (forge: ForgeServices, principal: Principal, url: URL, owner?: string, perPage = REPOSITORIES_PER_PAGE): Promise<RepositoryPage> => {
  const sort: RepositorySort = url.searchParams.get('sort') === 'name' ? 'name' : 'updated'
  const page = await forge.listRepositories(principal, { sort, page: parsePage(url.searchParams.get('page')), perPage, ...(owner !== undefined ? { owner } : {}) })
  return { ...page, sort }
}

export const pageHref = (url: URL, changes: Readonly<Record<string, string | number | null>>): string => {
  const params = new URLSearchParams(url.search)
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) params.delete(key)
    else params.set(key, String(value))
  }
  const query = params.toString()
  return query ? `?${query}` : url.pathname
}
