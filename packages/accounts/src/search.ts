import { type Database, sql, type SqlValue, type Statement } from './database.ts'
import { type ListingRow, type Page, type PageRequest, pageWindow, readableRepositories, REPOSITORY_COLUMNS, type RepositoryListing, toListing } from './listing.ts'
import type { OwnerKind, Principal } from './permissions.ts'

export const SEARCH_TYPES = ['repositories', 'issues', 'discussions', 'users'] as const

export type SearchType = (typeof SEARCH_TYPES)[number]

export const isSearchType = (value: unknown): value is SearchType => typeof value === 'string' && (SEARCH_TYPES as readonly string[]).includes(value)

export type SearchQuery = {
  readonly match: string | null
  readonly repo: { readonly owner: string; readonly name: string } | null
  readonly owner: string | null
  readonly kind: 'issue' | 'pr' | null
  readonly state: 'open' | 'closed' | null
}

const MAX_TERMS = 12

export const parseSearchQuery = (q: string): SearchQuery => {
  const terms: string[] = []
  let repo: SearchQuery['repo'] = null
  let owner: string | null = null
  let kind: SearchQuery['kind'] = null
  let state: SearchQuery['state'] = null
  for (const word of q.split(/\s+/).filter(Boolean)) {
    const qualifier = /^(repo|user|org|is):(.+)$/i.exec(word)
    if (!qualifier) {
      terms.push(...(word.match(/[\p{L}\p{N}_]+/gu) ?? []))
      continue
    }
    const key = qualifier[1]!.toLowerCase()
    const value = qualifier[2]!
    if (key === 'repo' && /^[^/]+\/[^/]+$/.test(value)) {
      const [repoOwner, name] = value.split('/') as [string, string]
      repo = { owner: repoOwner, name }
    } else if (key === 'user' || key === 'org') owner = value
    else if (value === 'issue' || value === 'pr') kind = value
    else if (value === 'open' || value === 'closed') state = value
  }
  const unique = [...new Set(terms.map((term) => term.toLowerCase()))].slice(0, MAX_TERMS)
  return { match: unique.length > 0 ? unique.map((term) => `"${term}"*`).join(' ') : null, repo, owner, kind, state }
}

export type IssueHit = {
  readonly repository: RepositoryListing
  readonly id: number
  readonly number: number
  readonly title: string
  readonly body: string | null
  readonly state: 'open' | 'closed'
  readonly isPull: boolean
  readonly authorKind: 'user' | 'app'
  readonly authorId: string
  readonly comments: number
  readonly createdAt: number
  readonly updatedAt: number
}

export type DiscussionHit = Omit<IssueHit, 'isPull'>

export type AccountHit = { readonly id: string; readonly login: string; readonly kind: OwnerKind; readonly displayName: string | null }

export type SearchResults =
  | { readonly type: 'repositories'; readonly page: Page<RepositoryListing> }
  | { readonly type: 'issues'; readonly page: Page<IssueHit> }
  | { readonly type: 'discussions'; readonly page: Page<DiscussionHit> }
  | { readonly type: 'users'; readonly page: Page<AccountHit> }

type Filter = { readonly where: string; readonly params: readonly SqlValue[] }

const filters = (query: SearchQuery, extra: readonly Filter[] = []): Filter => {
  const parts: Filter[] = [...extra]
  if (query.repo) parts.push({ where: 'a.login = ? AND r.name = ?', params: [query.repo.owner, query.repo.name] })
  if (query.owner) parts.push({ where: 'a.login = ?', params: [query.owner] })
  return { where: parts.map((part) => ` AND ${part.where}`).join(''), params: parts.flatMap((part) => part.params) }
}

type ThreadRow = ListingRow & {
  item_id: number
  item_number: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  is_pull: number
  author_kind: 'user' | 'app'
  author_id: string
  comment_count: number
  created_at: number
  updated_at: number
}

const toThread = (row: ThreadRow): IssueHit => ({
  repository: toListing(row),
  id: row.item_id,
  number: row.item_number,
  title: row.title,
  body: row.body,
  state: row.state,
  isPull: row.is_pull === 1,
  authorKind: row.author_kind,
  authorId: row.author_id,
  comments: row.comment_count,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const threads = (
  table: 'issues' | 'discussions',
  comments: 'issue_comments' | 'discussion_comments',
  parent: 'issue_id' | 'discussion_id',
  enabled: string,
  pull: string,
  match: string,
  readable: Statement,
  filter: Filter,
  perPage: number,
  offset: number,
): Statement =>
  sql(
    `WITH hits AS (
       SELECT rowid AS item_id, bm25(search_${table}) AS score FROM search_${table} WHERE search_${table} MATCH ?
       UNION ALL
       SELECT c.${parent}, bm25(search_${comments}) FROM search_${comments} JOIN ${comments} c ON c.id = search_${comments}.rowid
         WHERE search_${comments} MATCH ? AND c.deleted_at IS NULL
     ), best AS (SELECT item_id, min(score) AS score FROM hits GROUP BY item_id)
     SELECT ${REPOSITORY_COLUMNS}, t.id AS item_id, t.number AS item_number, t.title, t.body, t.state, ${pull} AS is_pull, t.author_kind, t.author_id,
       t.comment_count, t.created_at, t.updated_at, count(*) OVER () AS total
     FROM best JOIN ${table} t ON t.id = best.item_id JOIN repositories r ON r.id = t.repository_id JOIN accounts a ON a.id = r.owner_id
       LEFT JOIN collaboration_settings cs ON cs.repository_id = r.id
     WHERE (${readable.sql}) AND (${enabled})${filter.where}
     ORDER BY best.score, t.updated_at DESC LIMIT ? OFFSET ?`,
    match,
    match,
    ...readable.params,
    ...filter.params,
    perPage,
    offset,
  )

export const search = async (db: Database, principal: Principal, type: SearchType, q: string, request: PageRequest = {}): Promise<SearchResults> => {
  const query = parseSearchQuery(q)
  const { page, perPage, offset } = pageWindow(request)
  const empty = { items: [], total: 0, page, perPage }
  if (query.match === null) return { type, page: empty } as SearchResults
  const readable = readableRepositories(principal)
  const paged = <T>(rows: readonly (T & { total: number })[], map: (row: T & { total: number }) => unknown) => ({ items: rows.map(map), total: rows[0]?.total ?? 0, page, perPage })
  switch (type) {
    case 'repositories': {
      const filter = filters(query)
      const rows = await db.all<ListingRow>(
        sql(
          `SELECT ${REPOSITORY_COLUMNS}, count(*) OVER () AS total FROM (SELECT repository_id, bm25(search_repositories) AS score FROM search_repositories WHERE search_repositories MATCH ?) s
           JOIN repositories r ON r.id = s.repository_id JOIN accounts a ON a.id = r.owner_id
           WHERE (${readable.sql})${filter.where} ORDER BY s.score, r.last_commit_at DESC LIMIT ? OFFSET ?`,
          query.match,
          ...readable.params,
          ...filter.params,
          perPage,
          offset,
        ),
      )
      return { type, page: paged(rows, toListing) as Page<RepositoryListing> }
    }
    case 'issues': {
      const extra: Filter[] = []
      if (query.kind) extra.push({ where: 't.is_pull = ?', params: [query.kind === 'pr' ? 1 : 0] })
      if (query.state) extra.push({ where: 't.state = ?', params: [query.state] })
      const rows = await db.all<ThreadRow>(threads('issues', 'issue_comments', 'issue_id', 't.is_pull = 1 OR coalesce(cs.has_issues, 1) = 1', 't.is_pull', query.match, readable, filters(query, extra), perPage, offset))
      return { type, page: paged(rows, toThread) as Page<IssueHit> }
    }
    case 'discussions': {
      const extra: Filter[] = query.state ? [{ where: 't.state = ?', params: [query.state] }] : []
      const rows = await db.all<ThreadRow>(threads('discussions', 'discussion_comments', 'discussion_id', 'coalesce(cs.has_discussions, 1) = 1', '0', query.match, readable, filters(query, extra), perPage, offset))
      return { type, page: paged(rows, (row) => { const { isPull: _, ...hit } = toThread(row); return hit }) as Page<DiscussionHit> }
    }
    case 'users': {
      const rows = await db.all<{ id: string; login: string; kind: OwnerKind; display_name: string | null; total: number }>(
        sql(
          `SELECT a.id, a.login, a.kind, a.display_name, count(*) OVER () AS total FROM (SELECT account_id, bm25(search_accounts) AS score FROM search_accounts WHERE search_accounts MATCH ?) s
           JOIN accounts a ON a.id = s.account_id WHERE a.disabled_at IS NULL ORDER BY s.score, a.login LIMIT ? OFFSET ?`,
          query.match,
          perPage,
          offset,
        ),
      )
      return { type, page: paged(rows, (row) => ({ id: row.id, login: row.login, kind: row.kind, displayName: row.display_name })) as Page<AccountHit> }
    }
  }
}

export const SEARCH_INDEX_REBUILD: readonly Statement[] = [
  sql('DELETE FROM search_repositories'),
  sql("INSERT INTO search_repositories (repository_id, owner, name, description, topics) SELECT r.id, a.login, r.name, '', '' FROM repositories r JOIN accounts a ON a.id = r.owner_id"),
  sql('DELETE FROM search_accounts'),
  sql("INSERT INTO search_accounts (account_id, login, display_name) SELECT id, login, coalesce(display_name, '') FROM accounts"),
  ...['issues', 'issue_comments', 'discussions', 'discussion_comments'].map((table) => sql(`INSERT INTO search_${table} (search_${table}) VALUES ('rebuild')`)),
]
