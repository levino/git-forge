import { type Access, atLeast, maxAccess, minAccess, type Role } from './roles.ts'

export type Visibility = 'public' | 'private'

export type OwnerKind = 'user' | 'organization'

export type RepositorySubject = {
  readonly id: string
  readonly owner: string
  readonly name: string
  readonly ownerId: string
  readonly ownerKind: OwnerKind
  readonly visibility: Visibility
  readonly defaultRole: Role | null
  readonly description: string | null
  readonly homepage: string | null
  readonly topics: readonly string[]
  readonly archived: boolean
}

export const archivedBlocks = (repository: Pick<RepositorySubject, 'archived'>, required: Role): boolean => repository.archived && required !== 'read' && required !== 'admin'

export type OrganizationRole = 'member' | 'owner'

export type Grants = {
  readonly organizationRole: OrganizationRole | null
  readonly collaboratorRole: Role | null
  readonly teamRoles: readonly Role[]
  readonly appRole: Role | null
  readonly instanceRole: 'read' | null
  readonly upstreamDenied?: boolean
}

export const NO_GRANTS: Grants = { organizationRole: null, collaboratorRole: null, teamRoles: [], appRole: null, instanceRole: null }

export type TokenLimits = {
  readonly ceiling: Access
  readonly repositoryIds: readonly string[] | null
}

export type AnonymousPrincipal = { readonly kind: 'anonymous' }

export type UserPrincipal = {
  readonly kind: 'user'
  readonly id: string
  readonly login: string
  readonly limits: TokenLimits | null
  readonly tokenId: string | null
}

export type AppPrincipal = {
  readonly kind: 'app'
  readonly id: string
  readonly slug: string
  readonly limits: TokenLimits
  readonly tokenId: string
  readonly installationId?: number
  readonly permissions?: Readonly<Record<string, string>>
}

export type InstancePrincipal = {
  readonly kind: 'instance'
  readonly issuer: string
  readonly repositories: readonly string[]
  readonly scopes: readonly string[]
  readonly tokenId: string
  readonly installation?: { readonly id: string; readonly subject: string }
}

export type Principal = AnonymousPrincipal | UserPrincipal | AppPrincipal | InstancePrincipal

export const ANONYMOUS: AnonymousPrincipal = { kind: 'anonymous' }

export const fullName = (repo: { readonly owner: string; readonly name: string }): string => `${repo.owner}/${repo.name}`.toLowerCase()

const userGrant = (principal: UserPrincipal, repo: RepositorySubject, grants: Grants): Access => {
  if (repo.ownerKind === 'user') return repo.ownerId === principal.id ? 'admin' : maxAccess(grants.collaboratorRole)
  if (grants.organizationRole === 'owner') return 'admin'
  const base = grants.organizationRole === 'member' ? repo.defaultRole : null
  return maxAccess(base, grants.collaboratorRole, ...(grants.organizationRole ? grants.teamRoles : []))
}

const grantFor = (principal: Principal, repo: RepositorySubject, grants: Grants): Access => {
  switch (principal.kind) {
    case 'anonymous':
      return 'none'
    case 'user':
      return userGrant(principal, repo, grants)
    case 'app':
      return maxAccess(grants.appRole)
    case 'instance':
      return principal.repositories.includes(fullName(repo)) ? maxAccess(grants.instanceRole) : 'none'
  }
}

const limitsOf = (principal: Principal): TokenLimits | null =>
  principal.kind === 'user' || principal.kind === 'app' ? principal.limits : null

const applyLimits = (limits: TokenLimits | null, repo: RepositorySubject, access: Access): Access => {
  if (!limits) return access
  if (limits.repositoryIds && !limits.repositoryIds.includes(repo.id)) return 'none'
  return minAccess(access, limits.ceiling)
}

export const resolveAccess = (principal: Principal, repo: RepositorySubject, grants: Grants = NO_GRANTS): Access => {
  const floor: Access = repo.visibility === 'public' ? 'read' : 'none'
  if (grants.upstreamDenied) return floor
  return maxAccess(floor, applyLimits(limitsOf(principal), repo, grantFor(principal, repo, grants)))
}

export type Decision = 'allow' | 'unauthenticated' | 'forbidden' | 'not-found'

export const decide = (principal: Principal, access: Access, required: Role): Decision => {
  if (atLeast(access, required)) return 'allow'
  if (principal.kind === 'anonymous') return 'unauthenticated'
  return access === 'none' ? 'not-found' : 'forbidden'
}
