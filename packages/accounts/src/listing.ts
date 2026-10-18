import { type Database, type SqlValue, sql, type Statement } from './database.ts'
import { type OwnerKind, type Principal, type RepositorySubject, type Visibility } from './permissions.ts'
import type { Role } from './roles.ts'

export type RepositorySort = 'updated' | 'name'

export type RepositoryListing = RepositorySubject & {
  readonly defaultBranch: string | null
  readonly lastCommitAt: number | null
  readonly statsAt: number | null
}

export type RepositoryStats = { readonly defaultBranch: string | null; readonly lastCommitAt: number | null }

export type PageRequest = { readonly page?: number; readonly perPage?: number }

export type Page<T> = { readonly items: readonly T[]; readonly total: number; readonly page: number; readonly perPage: number }

export const MAX_PER_PAGE = 100

export const pageWindow = (request: PageRequest, fallback = 30): { readonly page: number; readonly perPage: number; readonly offset: number } => {
  const perPage = Math.min(Math.max(Math.trunc(request.perPage ?? fallback) || fallback, 1), MAX_PER_PAGE)
  const page = Math.min(Math.max(Math.trunc(request.page ?? 1) || 1, 1), 1000)
  return { page, perPage, offset: (page - 1) * perPage }
}

const fragment = (text: string, ...params: SqlValue[]): Statement => sql(text, ...params)

const inList = (column: string, values: readonly string[]): Statement =>
  values.length === 0 ? fragment('0') : fragment(`${column} IN (${values.map(() => '?').join(', ')})`, ...values)

const and = (...parts: readonly Statement[]): Statement => fragment(parts.map((part) => `(${part.sql})`).join(' AND '), ...parts.flatMap((part) => part.params))

const userGrants = (id: string): Statement =>
  fragment(
    `EXISTS (SELECT 1 FROM instance_admins WHERE user_id = ?)
     OR (a.kind = 'user' AND r.owner_id = ?)
     OR EXISTS (SELECT 1 FROM repository_collaborators WHERE repository_id = r.id AND user_id = ?)
     OR (a.kind = 'organization' AND EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = r.owner_id AND m.user_id = ? AND (
       m.role = 'owner' OR a.default_repository_role IS NOT NULL
       OR EXISTS (SELECT 1 FROM repository_teams rt JOIN team_members tm ON tm.team_id = rt.team_id WHERE rt.repository_id = r.id AND tm.user_id = ?))))`,
    id,
    id,
    id,
    id,
    id,
  )

const grantsOf = (principal: Principal): Statement => {
  switch (principal.kind) {
    case 'anonymous':
      return fragment('0')
    case 'user':
      return userGrants(principal.id)
    case 'app':
      return fragment('EXISTS (SELECT 1 FROM app_repositories WHERE app_id = ? AND repository_id = r.id)', principal.id)
    case 'instance':
      if (!principal.scopes.includes('git:read')) return fragment('0')
      return and(
        inList("lower(a.login || '/' || r.name)", principal.repositories.map((name) => name.toLowerCase())),
        fragment(
          'EXISTS (SELECT 1 FROM instance_repositories ir JOIN trusted_instances ti ON ti.issuer = ir.issuer WHERE ir.issuer = ? AND ir.repository_id = r.id AND ti.disabled_at IS NULL)',
          principal.issuer,
        ),
      )
  }
}

export const readableRepositories = (principal: Principal): Statement => {
  const limits = principal.kind === 'user' || principal.kind === 'app' ? principal.limits : null
  const parts = [grantsOf(principal)]
  if (limits?.ceiling === 'none') parts.push(fragment('0'))
  if (limits?.repositoryIds) parts.push(inList('r.id', limits.repositoryIds))
  const granted = and(...parts)
  return fragment(`r.deleted_at IS NULL AND a.disabled_at IS NULL AND (r.visibility = 'public' OR (${granted.sql}))`, ...granted.params)
}

const or = (...parts: readonly Statement[]): Statement => fragment(parts.map((part) => `(${part.sql})`).join(' OR '), ...parts.flatMap((part) => part.params))

export const ruleAudience = (principal: Principal, surface: 'git' | 'lfs' = 'git'): Statement => {
  const everyone = fragment("v.audience = 'public'")
  if (principal.kind === 'user' && principal.limits?.ceiling !== 'none') {
    const own = fragment(
      "(v.audience = 'user' AND v.subject = ?) OR (v.audience = 'team' AND v.subject IN (SELECT team_id FROM team_members WHERE user_id = ?))",
      principal.id,
      principal.id,
    )
    return or(everyone, principal.limits?.repositoryIds ? and(inList('r.id', principal.limits.repositoryIds), own) : own)
  }
  if (principal.kind !== 'instance' || !principal.scopes.includes(`${surface}:read`)) return everyone
  return or(
    everyone,
    and(
      fragment("v.audience = 'instance' AND v.subject = ?", principal.issuer),
      inList("lower(a.login || '/' || r.name)", principal.repositories.map((name) => name.toLowerCase())),
      fragment('EXISTS (SELECT 1 FROM trusted_instances ti WHERE ti.issuer = v.subject AND ti.disabled_at IS NULL)'),
    ),
  )
}

export const listableRepositories = (principal: Principal): Statement => {
  const readable = readableRepositories(principal)
  const audience = ruleAudience(principal)
  return fragment(
    `(${readable.sql}) OR (r.deleted_at IS NULL AND a.disabled_at IS NULL AND EXISTS (SELECT 1 FROM visibility_rules v WHERE v.repository_id = r.id AND (${audience.sql})))`,
    ...readable.params,
    ...audience.params,
  )
}

export const REPOSITORY_COLUMNS = `r.id, r.name, r.visibility, r.owner_id, a.login AS owner_login, a.kind AS owner_kind, a.default_repository_role,
  r.description, r.homepage, r.topics, r.archived_at, r.default_branch, r.last_commit_at, r.stats_at`

export type ListingRow = {
  id: string
  name: string
  visibility: Visibility
  owner_id: string
  owner_login: string
  owner_kind: OwnerKind
  default_repository_role: Role | null
  description: string | null
  homepage: string | null
  topics: string
  archived_at: number | null
  default_branch: string | null
  last_commit_at: number | null
  stats_at: number | null
  total: number
}

export const toListing = (row: ListingRow): RepositoryListing => ({
  id: row.id,
  owner: row.owner_login,
  name: row.name,
  ownerId: row.owner_id,
  ownerKind: row.owner_kind,
  visibility: row.visibility,
  defaultRole: row.default_repository_role,
  description: row.description,
  homepage: row.homepage,
  topics: JSON.parse(row.topics) as string[],
  archived: row.archived_at !== null,
  defaultBranch: row.default_branch,
  lastCommitAt: row.last_commit_at,
  statsAt: row.stats_at,
})

const ORDER: Record<RepositorySort, string> = {
  updated: 'r.last_commit_at IS NULL, r.last_commit_at DESC, a.login, r.name',
  name: 'a.login, r.name',
}

export type RepositoryListOptions = PageRequest & { readonly owner?: string; readonly sort?: RepositorySort }

export const listReadableRepositories = async (db: Database, principal: Principal, options: RepositoryListOptions = {}): Promise<Page<RepositoryListing>> => {
  const { page, perPage, offset } = pageWindow(options)
  const readable = listableRepositories(principal)
  const owner = options.owner === undefined ? fragment('1') : fragment('a.login = ?', options.owner)
  const rows = await db.all<ListingRow>(
    sql(
      `SELECT ${REPOSITORY_COLUMNS}, count(*) OVER () AS total FROM repositories r JOIN accounts a ON a.id = r.owner_id
       WHERE (${readable.sql}) AND ${owner.sql} ORDER BY ${ORDER[options.sort ?? 'updated']} LIMIT ? OFFSET ?`,
      ...readable.params,
      ...owner.params,
      perPage,
      offset,
    ),
  )
  return { items: rows.map(toListing), total: rows[0]?.total ?? 0, page, perPage }
}

export const setRepositoryStats = (db: Database, repositoryId: string, stats: RepositoryStats, at: number): Promise<unknown> =>
  db.run(sql('UPDATE repositories SET default_branch = ?, last_commit_at = ?, stats_at = ? WHERE id = ?', stats.defaultBranch, stats.lastCommitAt, at, repositoryId))
