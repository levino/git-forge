import { type Database, isSearchType, type IssueHit, type Principal, type RepositoryListing, search, type SearchResults, type SearchType } from '@git-forge/accounts'
import { iso, loadUsers, repoApi, repoWeb, type Urls, userJson } from '@git-forge/collaboration'

export type SearchRequest = { readonly type: SearchType; readonly q: string; readonly page: number; readonly perPage: number }

export const parseSearchRequest = (url: URL, fallback: SearchType = 'repositories'): SearchRequest => {
  const type = url.searchParams.get('type')
  return {
    type: isSearchType(type) ? type : fallback,
    q: (url.searchParams.get('q') ?? '').slice(0, 256),
    page: Number(url.searchParams.get('page') ?? '1'),
    perPage: Number(url.searchParams.get('per_page') ?? '30'),
  }
}

export const runSearch = (db: Database, principal: Principal, request: SearchRequest): Promise<SearchResults> =>
  search(db, principal, request.type, request.q, { page: request.page, perPage: request.perPage })

export const repositoryJson = (urls: Urls, repo: RepositoryListing) => ({
  id: repo.id,
  node_id: `R_${repo.id}`,
  name: repo.name,
  full_name: `${repo.owner}/${repo.name}`,
  private: repo.visibility === 'private',
  visibility: repo.visibility,
  owner: { login: repo.owner, id: repo.ownerId, type: repo.ownerKind === 'organization' ? 'Organization' : 'User', html_url: `${urls.web}/${encodeURIComponent(repo.owner)}` },
  html_url: repoWeb(urls, repo),
  url: repoApi(urls, repo),
  clone_url: `${repoWeb(urls, repo)}.git`,
  default_branch: repo.defaultBranch,
  pushed_at: iso(repo.lastCommitAt),
  score: 1,
})

const issuesJson = async (db: Database, urls: Urls, hits: readonly IssueHit[]) => {
  const users = await loadUsers(db, hits.map((hit) => ({ kind: hit.authorKind, id: hit.authorId })))
  return hits.map((hit) => {
    const api = `${repoApi(urls, hit.repository)}/issues/${hit.number}`
    const web = `${repoWeb(urls, hit.repository)}/${hit.isPull ? 'pull' : 'issues'}/${hit.number}`
    return {
      id: hit.id,
      number: hit.number,
      title: hit.title,
      body: hit.body,
      state: hit.state,
      user: userJson(urls, users({ kind: hit.authorKind, id: hit.authorId })),
      comments: hit.comments,
      created_at: iso(hit.createdAt),
      updated_at: iso(hit.updatedAt),
      url: api,
      html_url: web,
      repository_url: repoApi(urls, hit.repository),
      ...(hit.isPull ? { pull_request: { url: `${repoApi(urls, hit.repository)}/pulls/${hit.number}`, html_url: web } } : {}),
      score: 1,
    }
  })
}

const itemsJson = async (db: Database, urls: Urls, results: SearchResults): Promise<unknown[]> => {
  switch (results.type) {
    case 'repositories':
      return results.page.items.map((repo) => repositoryJson(urls, repo))
    case 'issues':
      return issuesJson(db, urls, results.page.items)
    case 'discussions':
      return results.page.items.map((hit) => ({
        id: hit.id,
        number: hit.number,
        title: hit.title,
        body: hit.body,
        state: hit.state,
        comments: hit.comments,
        created_at: iso(hit.createdAt),
        updated_at: iso(hit.updatedAt),
        html_url: `${repoWeb(urls, hit.repository)}/discussions/${hit.number}`,
        repository_url: repoApi(urls, hit.repository),
        score: 1,
      }))
    case 'users':
      return results.page.items.map((hit) => ({ login: hit.login, id: hit.id, type: hit.kind === 'organization' ? 'Organization' : 'User', name: hit.displayName, html_url: `${urls.web}/${encodeURIComponent(hit.login)}`, score: 1 }))
  }
}

export const searchResponseJson = async (db: Database, urls: Urls, results: SearchResults) => ({
  total_count: results.page.total,
  incomplete_results: false,
  items: await itemsJson(db, urls, results),
})
