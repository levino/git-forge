import { atLeast, type Principal, type RepositorySubject, sql } from '@git-forge/accounts'
import { forkRepository, isValidName, RepositoryExistsError } from '@git-forge/core'
import { type AccountsDirectory, CollaborationError, invalid, resolveActor, type Scope } from './context.ts'

export type ForkInput = { readonly organization?: unknown; readonly name?: unknown; readonly defaultBranchOnly?: unknown }

export type ForkInfo = { readonly parent: RepositorySubject; readonly source: RepositorySubject }

const readable = async (accounts: AccountsDirectory, principal: Principal, repository: RepositorySubject): Promise<boolean> =>
  atLeast((await resolveActor(accounts, principal, repository)).access, 'read')

const filterReadable = async <T extends RepositorySubject>(scope: Scope, repositories: readonly T[]): Promise<T[]> => {
  const visible: T[] = []
  for (const repository of repositories) if (await readable(scope.accounts, scope.actor.principal, repository)) visible.push(repository)
  return visible
}

export const createFork = async (scope: Scope, input: ForkInput): Promise<RepositorySubject> => {
  const principal = scope.actor.principal
  if (principal.kind !== 'user') throw new CollaborationError(principal.kind === 'anonymous' ? 401 : 403, 'Forks are created by users')
  if (!scope.actor.writable) throw new CollaborationError(403, 'Resource not accessible by integration')
  if (input.organization !== undefined && input.organization !== null && typeof input.organization !== 'string') throw invalid('organization must be a string')
  if (input.name !== undefined && input.name !== null && typeof input.name !== 'string') throw invalid('name must be a string')
  if (input.defaultBranchOnly !== undefined && typeof input.defaultBranchOnly !== 'boolean') throw invalid('default_branch_only must be a boolean')
  const name = typeof input.name === 'string' ? input.name : scope.repository.name
  if (!isValidName(name)) throw invalid('name must match [A-Za-z0-9][A-Za-z0-9._-]* and must not end in .git')
  let owner: { readonly id: string; readonly login: string }
  if (typeof input.organization === 'string') {
    const organization = await scope.accounts.findAccount(input.organization)
    if (!organization || organization.kind !== 'organization') throw invalid(`${input.organization} is not an organization`)
    const role = await scope.accounts.organizationRole(organization.id, principal.id)
    if (role !== 'owner' && !(await scope.accounts.isInstanceAdmin(principal.id))) throw new CollaborationError(403, `You cannot create repositories in ${organization.login}`)
    owner = organization
  } else {
    owner = { id: principal.id, login: principal.login }
  }
  if (owner.id === scope.repository.ownerId && name.toLowerCase() === scope.repository.name.toLowerCase()) throw invalid('A repository cannot be forked into itself')
  const block = await scope.accounts.repositoryNameBlock(owner.id, name)
  if (block) throw new CollaborationError(422, block)
  const claimed = await scope.accounts.storagePathClaimed(`${owner.login}/${name}`)
  const target = { owner: owner.login, name: claimed ? `${name.slice(0, 90)}.${crypto.randomUUID().slice(0, 8)}` : name }
  try {
    await forkRepository(scope.storage, scope.repo, target, { defaultBranchOnly: input.defaultBranchOnly === true })
  } catch (error) {
    if (error instanceof RepositoryExistsError) throw new CollaborationError(422, `${owner.login}/${name} already exists`)
    throw error
  }
  await scope.accounts.createFork(
    { ownerId: owner.id, name, visibility: scope.repository.visibility, parentId: scope.repository.id, storagePath: `${target.owner}/${target.name}` },
    { kind: 'user', id: principal.id },
  )
  const created = await scope.accounts.findRepository(owner.login, name)
  if (!created) throw new CollaborationError(422, `${owner.login}/${name} could not be created`)
  return created
}

export const forkInfo = async (scope: Scope): Promise<ForkInfo | null> => {
  const info = await scope.accounts.forkInfo(scope.repository.id)
  if (!info) return null
  const [parent, source] = await Promise.all([
    readable(scope.accounts, scope.actor.principal, info.parent),
    readable(scope.accounts, scope.actor.principal, info.root),
  ])
  return parent && source ? { parent: info.parent, source: info.root } : null
}

export const listForks = async (scope: Scope): Promise<RepositorySubject[]> => filterReadable(scope, await scope.accounts.listForks(scope.repository.id))

export type ForkNetwork = { readonly root: RepositorySubject | null; readonly forks: readonly (RepositorySubject & { readonly parentId: string })[] }

export const forkNetwork = async (scope: Scope): Promise<ForkNetwork> => {
  const network = await scope.accounts.forkNetwork(scope.repository.id)
  if (!network) return { root: null, forks: [] }
  const root = (await readable(scope.accounts, scope.actor.principal, network.root)) ? network.root : null
  return { root, forks: await filterReadable(scope, network.forks) }
}

export const maintainerPushBranches = async (
  options: { readonly db: Scope['db']; readonly accounts: AccountsDirectory },
  principal: Principal,
  repository: RepositorySubject,
): Promise<string[]> => {
  if (principal.kind !== 'user' && principal.kind !== 'app') return []
  const rows = await options.db.all<{ head_ref: string; base_id: string }>(
    sql(
      `SELECT p.head_ref, i.repository_id AS base_id FROM pull_requests p JOIN issues i ON i.id = p.issue_id
       WHERE p.head_repository_id = ? AND p.maintainer_can_modify = 1 AND i.state = 'open'`,
      repository.id,
    ),
  )
  const branches = new Set<string>()
  const access = new Map<string, boolean>()
  for (const row of rows) {
    if (!access.has(row.base_id)) {
      const base = await options.accounts.findRepositoryById(row.base_id)
      const actor = base ? await resolveActor(options.accounts, principal, base) : null
      access.set(row.base_id, actor !== null && actor.writable && atLeast(actor.access, 'write'))
    }
    if (access.get(row.base_id)) branches.add(row.head_ref)
  }
  return [...branches]
}
