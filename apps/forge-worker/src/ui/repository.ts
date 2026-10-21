import type { Access, Decision, Principal, RepositorySubject } from '@git-forge/accounts'
import { atLeast } from '@git-forge/accounts'
import {
  defaultBranch,
  isValidName,
  type NamedRef,
  namedRefs,
  ObjectDatabase,
  readRefs,
  type RefsState,
  type RepositoryName,
  listMirrors,
  type MirrorConfig,
  commitReach,
  type ObjectId,
  type PathReach,
  type ReadView,
  UPSTREAM_PREFIX,
  visibleRefs,
} from '@git-forge/core'
import { type ForkInfo, type Scope } from '@git-forge/collaboration'
import type { ForgeServices } from '../app.ts'
import { encodePath } from './format.ts'

export type OpenRepository = {
  readonly kind: 'ok'
  readonly name: RepositoryName
  readonly subject: RepositorySubject
  readonly access: Access
  readonly odb: ObjectDatabase
  readonly refs: RefsState
  readonly branches: readonly NamedRef[]
  readonly tags: readonly NamedRef[]
  readonly defaultBranch: string | null
  readonly mirrors: readonly MirrorConfig[]
  readonly canAdmin: boolean
  readonly canWrite: boolean
  readonly view: ReadView | null
}

export type RepositoryResult = OpenRepository | { readonly kind: 'denied'; readonly decision: Exclude<Decision, 'allow'> }

export type OpenOptions = { readonly partial?: boolean; readonly request?: Request }

export type HeaderData = { readonly scope: Scope | null; readonly issues?: number; readonly pulls?: number; readonly fork: ForkInfo | null; readonly forks: readonly RepositorySubject[] }

const memos = new WeakMap<Request, WeakMap<Principal, Map<string, Promise<unknown>>>>()

const perRequest = <T>(request: Request, principal: Principal, key: string, load: () => Promise<T>): Promise<T> => {
  if (request.method !== 'GET') return load()
  const byRequest = memos.get(request) ?? memos.set(request, new WeakMap()).get(request)!
  const byPrincipal = byRequest.get(principal) ?? byRequest.set(principal, new Map()).get(principal)!
  const known = byPrincipal.get(key)
  if (known) return known as Promise<T>
  const loaded = load()
  byPrincipal.set(key, loaded)
  return loaded
}

const resolvedFor = new WeakMap<object, { readonly principal: Principal; readonly subject: RepositorySubject; readonly access: Access }>()

export const scopeFor = (forge: ForgeServices, request: Request, principal: Principal, repo: { readonly name: RepositoryName }): Promise<Scope | null> =>
  perRequest(request, principal, `scope:${repo.name.owner}/${repo.name.name}`, () => {
    const resolved = resolvedFor.get(repo)
    const known = resolved?.principal === principal ? { repository: resolved.subject, access: resolved.access } : undefined
    return forge.collaboration(request, principal, repo.name.owner, repo.name.name, known)
  })

export const headerData = (forge: ForgeServices, request: Request, principal: Principal, repo: { readonly name: RepositoryName; readonly view: ReadView | null; readonly subject: RepositorySubject }): Promise<HeaderData> =>
  perRequest(request, principal, `header:${repo.name.owner}/${repo.name.name}`, async () => {
    if (repo.view) return { scope: null, fork: null, forks: [] }
    const [scope, header] = await Promise.all([scopeFor(forge, request, principal, repo), forge.repositoryHeader(principal, repo.subject)])
    return scope ? { scope, ...header } : { scope, fork: null, forks: [] }
  })

export const accessFor = (forge: ForgeServices, request: Request | undefined, principal: Principal, repo: RepositoryName) =>
  request ? perRequest(request, principal, `access:${repo.owner}/${repo.name}`, () => forge.repositoryAccess(principal, repo, 'read')) : forge.repositoryAccess(principal, repo, 'read')

export const openRepository = async (forge: ForgeServices, principal: Principal, owner: string, name: string, options: OpenOptions = {}): Promise<RepositoryResult> => {
  if (!isValidName(owner) || !isValidName(name)) return { kind: 'denied', decision: 'not-found' }
  const check = await accessFor(forge, options.request, principal, { owner, name })
  const view = check.decision !== 'allow' && options.partial ? (check.view ?? null) : null
  if ((check.decision !== 'allow' && !view) || !check.repository) return { kind: 'denied', decision: check.decision === 'allow' ? 'not-found' : check.decision }
  const repo = { owner: check.repository.owner, name: check.repository.name }
  const odb = new ObjectDatabase(forge.storage, repo)
  const resolved = { principal, subject: check.repository, access: check.access }
  if (options.request?.method === 'GET') {
    odb.packs().catch(() => {})
    const early = { name: repo, view, subject: check.repository }
    resolvedFor.set(early, resolved)
    headerData(forge, options.request, principal, early).catch(() => {})
  }
  const stored = await readRefs(forge.storage, repo)
  const mirrored = !view && Object.keys(stored?.state.refs ?? {}).some((name) => name.startsWith(UPSTREAM_PREFIX))
  const mirrors = mirrored ? await listMirrors(forge.storage, repo) : []
  const refs: RefsState = view ? visibleRefs(stored?.state ?? EMPTY_REFS, view) : (stored?.state ?? EMPTY_REFS)
  const named = namedRefs(refs)
  const opened: OpenRepository = {
    kind: 'ok',
    name: repo,
    subject: check.repository,
    access: check.access,
    odb,
    refs,
    branches: named.branches,
    tags: named.tags,
    defaultBranch: defaultBranch(refs),
    mirrors,
    canAdmin: atLeast(check.access, 'admin'),
    canWrite: atLeast(check.access, 'write'),
    view,
  }
  resolvedFor.set(opened, resolved)
  return opened
}

const EMPTY_REFS: RefsState = { head: 'refs/heads/main', refs: {} }

export const reachOf = async (repo: OpenRepository, commit: ObjectId): Promise<PathReach> =>
  repo.view ? ((await commitReach(repo.odb, repo.refs, repo.view, commit)) ?? (() => 'none')) : () => 'inside'

export const repoUrl = (repo: RepositoryName, ...rest: readonly string[]): string =>
  `/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}${rest.length > 0 ? `/${rest.join('/')}` : ''}`

export const treeUrl = (repo: RepositoryName, ref: string, path: readonly string[] = []): string => repoUrl(repo, 'tree', encodePath([...ref.split('/'), ...path]))

export const blobUrl = (repo: RepositoryName, ref: string, path: readonly string[]): string => repoUrl(repo, 'blob', encodePath([...ref.split('/'), ...path]))

export const blameUrl = (repo: RepositoryName, ref: string, path: readonly string[]): string => repoUrl(repo, 'blame', encodePath([...ref.split('/'), ...path]))

export const rawUrl = (repo: RepositoryName, ref: string, path: readonly string[]): string => repoUrl(repo, 'raw', encodePath([...ref.split('/'), ...path]))

export const commitsUrl = (repo: RepositoryName, ref: string, path: readonly string[] = []): string =>
  repoUrl(repo, 'commits', encodePath([...ref.split('/'), ...path]))

export const commitUrl = (repo: RepositoryName, id: string): string => repoUrl(repo, 'commit', id)

export const mediaUrl = (repo: RepositoryName, oid: string, filename: string): string => repoUrl(repo, 'media', oid, encodeURIComponent(filename))

export const cloneUrl = (origin: string, repo: RepositoryName): string => `${origin}/${repo.owner}/${repo.name}.git`
