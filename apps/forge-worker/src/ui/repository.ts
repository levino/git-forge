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
  visibleRefs,
} from '@git-forge/core'
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

export const openRepository = async (forge: ForgeServices, principal: Principal, owner: string, name: string, partial = false): Promise<RepositoryResult> => {
  if (!isValidName(owner) || !isValidName(name)) return { kind: 'denied', decision: 'not-found' }
  const check = await forge.repositoryAccess(principal, { owner, name }, 'read')
  const view = check.decision !== 'allow' && partial ? (check.view ?? null) : null
  if ((check.decision !== 'allow' && !view) || !check.repository) return { kind: 'denied', decision: check.decision === 'allow' ? 'not-found' : check.decision }
  const repo = { owner: check.repository.owner, name: check.repository.name }
  const stored = (await readRefs(forge.storage, repo))?.state ?? { head: 'refs/heads/main', refs: {} }
  const refs: RefsState = view ? visibleRefs(stored, view) : stored
  const named = namedRefs(refs)
  return {
    kind: 'ok',
    name: repo,
    subject: check.repository,
    access: check.access,
    odb: new ObjectDatabase(forge.storage, repo),
    refs,
    branches: named.branches,
    tags: named.tags,
    defaultBranch: defaultBranch(refs),
    mirrors: view ? [] : await listMirrors(forge.storage, repo),
    canAdmin: atLeast(check.access, 'admin'),
    canWrite: atLeast(check.access, 'write'),
    view,
  }
}

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
