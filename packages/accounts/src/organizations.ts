import type { OrganizationRole, Principal, UserPrincipal } from './permissions.ts'
import { isRole, type Role } from './roles.ts'
import { type AccountsStore, isReservedLogin } from './store.ts'

export class OrganizationError extends Error {
  constructor(
    readonly status: 401 | 403 | 404 | 409 | 422,
    message: string,
  ) {
    super(message)
  }
}

export const canAdministerOrganization = (membership: OrganizationRole | null, instanceAdmin: boolean): boolean => instanceAdmin || membership === 'owner'

export const canSeeOrganizationMembers = (membership: OrganizationRole | null, instanceAdmin: boolean): boolean => instanceAdmin || membership !== null

export const isOrganizationRole = (value: unknown): value is OrganizationRole => value === 'member' || value === 'owner'

export const isTeamRole = (value: unknown): value is 'member' | 'maintainer' => value === 'member' || value === 'maintainer'

export type OrganizationStore = Pick<
  AccountsStore,
  | 'findAccount'
  | 'isInstanceAdmin'
  | 'createOrganization'
  | 'organizationRole'
  | 'listOrganizationMembers'
  | 'setOrganizationMember'
  | 'removeOrganizationMember'
  | 'listTeams'
  | 'findTeam'
  | 'createTeam'
  | 'listTeamMembers'
  | 'setTeamMember'
  | 'removeTeamMember'
  | 'listTeamRepositories'
  | 'setTeamRepositoryRole'
  | 'removeTeamRepository'
  | 'findRepository'
>

export type OrganizationView = {
  readonly organization: { readonly id: string; readonly login: string }
  readonly membership: OrganizationRole | null
  readonly canAdminister: boolean
  readonly members: readonly { readonly id: string; readonly login: string; readonly role: OrganizationRole }[]
  readonly teams: readonly { readonly id: string; readonly slug: string; readonly name: string; readonly members: number }[]
}

export type TeamView = {
  readonly team: { readonly id: string; readonly slug: string; readonly name: string }
  readonly canAdminister: boolean
  readonly members: readonly { readonly id: string; readonly login: string; readonly role: 'member' | 'maintainer' }[]
  readonly repositories: readonly { readonly id: string; readonly name: string; readonly role: Role }[]
}

const userOf = (principal: Principal): UserPrincipal => {
  if (principal.kind !== 'user') throw new OrganizationError(401, 'authentication required')
  if (principal.limits !== null && principal.limits.ceiling !== 'admin') throw new OrganizationError(403, 'this needs a session or a token with the repo:admin scope')
  return principal
}

export const createOrganizationOperations = (store: OrganizationStore) => {
  const organization = async (login: string) => {
    const account = await store.findAccount(login)
    if (!account || account.kind !== 'organization') throw new OrganizationError(404, 'organization not found')
    return account
  }

  const membershipOf = async (user: UserPrincipal, organizationId: string) => {
    const [membership, instanceAdmin] = await Promise.all([store.organizationRole(organizationId, user.id), store.isInstanceAdmin(user.id)])
    return { membership, instanceAdmin }
  }

  const administer = async (principal: Principal, login: string) => {
    const user = userOf(principal)
    const org = await organization(login)
    const { membership, instanceAdmin } = await membershipOf(user, org.id)
    if (!canAdministerOrganization(membership, instanceAdmin)) throw new OrganizationError(membership ? 403 : 404, membership ? 'organization owners only' : 'organization not found')
    return { user, org }
  }

  const user = async (login: string) => {
    const account = await store.findAccount(login)
    if (!account || account.kind !== 'user') throw new OrganizationError(404, `user ${login} not found`)
    return account
  }

  const team = async (organizationId: string, slug: string) => {
    const found = await store.findTeam(organizationId, slug)
    if (!found) throw new OrganizationError(404, 'team not found')
    return found
  }

  const actor = (user: UserPrincipal) => ({ kind: 'user', id: user.id }) as const

  return {
    create: async (principal: Principal, login: string): Promise<{ readonly id: string; readonly login: string }> => {
      const creator = userOf(principal)
      if (isReservedLogin(login)) throw new OrganizationError(422, `${login} is reserved`)
      if (await store.findAccount(login)) throw new OrganizationError(409, `${login} already exists`)
      let created: { readonly id: string }
      try {
        created = await store.createOrganization({ login }, actor(creator))
      } catch (error) {
        throw new OrganizationError(422, (error as Error).message)
      }
      await store.setOrganizationMember(created.id, creator.id, 'owner', actor(creator))
      return { id: created.id, login }
    },

    view: async (principal: Principal, login: string): Promise<OrganizationView> => {
      const org = await organization(login)
      const viewer = principal.kind === 'user' ? principal : null
      const { membership, instanceAdmin } = viewer ? await membershipOf(viewer, org.id) : { membership: null, instanceAdmin: false }
      const visible = canSeeOrganizationMembers(membership, instanceAdmin)
      return {
        organization: { id: org.id, login: org.login },
        membership,
        canAdminister: viewer !== null && (viewer.limits === null || viewer.limits.ceiling === 'admin') && canAdministerOrganization(membership, instanceAdmin),
        members: visible ? await store.listOrganizationMembers(org.id) : [],
        teams: visible ? await store.listTeams(org.id) : [],
      }
    },

    setMember: async (principal: Principal, login: string, memberLogin: string, role: string): Promise<void> => {
      const { user: admin, org } = await administer(principal, login)
      if (!isOrganizationRole(role)) throw new OrganizationError(422, 'role must be member or owner')
      const member = await user(memberLogin)
      if (role === 'member') {
        const owners = (await store.listOrganizationMembers(org.id)).filter((entry) => entry.role === 'owner')
        if (owners.length === 1 && owners[0]!.id === member.id) throw new OrganizationError(422, 'an organization needs at least one owner')
      }
      await store.setOrganizationMember(org.id, member.id, role, actor(admin))
    },

    removeMember: async (principal: Principal, login: string, memberLogin: string): Promise<void> => {
      const { user: admin, org } = await administer(principal, login)
      const member = await user(memberLogin)
      const owners = (await store.listOrganizationMembers(org.id)).filter((entry) => entry.role === 'owner')
      if (owners.length === 1 && owners[0]!.id === member.id) throw new OrganizationError(422, 'an organization needs at least one owner')
      await store.removeOrganizationMember(org.id, member.id, actor(admin))
    },

    createTeam: async (principal: Principal, login: string, slug: string, name: string): Promise<void> => {
      const { user: admin, org } = await administer(principal, login)
      if (await store.findTeam(org.id, slug)) throw new OrganizationError(409, `team ${slug} already exists`)
      try {
        await store.createTeam(org.id, { slug, name: name.trim() === '' ? slug : name.trim() }, actor(admin))
      } catch (error) {
        throw new OrganizationError(422, (error as Error).message)
      }
    },

    team: async (principal: Principal, login: string, slug: string): Promise<TeamView> => {
      const org = await organization(login)
      const viewer = principal.kind === 'user' ? principal : null
      const { membership, instanceAdmin } = viewer ? await membershipOf(viewer, org.id) : { membership: null, instanceAdmin: false }
      if (!canSeeOrganizationMembers(membership, instanceAdmin)) throw new OrganizationError(404, 'team not found')
      const found = await team(org.id, slug)
      return {
        team: found,
        canAdminister: viewer !== null && (viewer.limits === null || viewer.limits.ceiling === 'admin') && canAdministerOrganization(membership, instanceAdmin),
        members: await store.listTeamMembers(found.id),
        repositories: await store.listTeamRepositories(found.id),
      }
    },

    setTeamMember: async (principal: Principal, login: string, slug: string, memberLogin: string, role: string): Promise<void> => {
      const { user: admin, org } = await administer(principal, login)
      if (!isTeamRole(role)) throw new OrganizationError(422, 'role must be member or maintainer')
      const found = await team(org.id, slug)
      const member = await user(memberLogin)
      if (!(await store.organizationRole(org.id, member.id))) throw new OrganizationError(422, `${member.login} is not a member of ${org.login}`)
      await store.setTeamMember(found.id, member.id, role, actor(admin))
    },

    removeTeamMember: async (principal: Principal, login: string, slug: string, memberLogin: string): Promise<void> => {
      const { user: admin, org } = await administer(principal, login)
      const found = await team(org.id, slug)
      await store.removeTeamMember(found.id, (await user(memberLogin)).id, actor(admin))
    },

    setTeamRepository: async (principal: Principal, login: string, slug: string, repositoryName: string, role: string): Promise<void> => {
      const { user: admin, org } = await administer(principal, login)
      if (!isRole(role)) throw new OrganizationError(422, 'role must be read, triage, write, maintain or admin')
      const found = await team(org.id, slug)
      const repository = await store.findRepository(org.login, repositoryName)
      if (!repository) throw new OrganizationError(404, `${org.login}/${repositoryName} not found`)
      await store.setTeamRepositoryRole(repository.id, found.id, role, actor(admin))
    },

    removeTeamRepository: async (principal: Principal, login: string, slug: string, repositoryName: string): Promise<void> => {
      const { user: admin, org } = await administer(principal, login)
      const found = await team(org.id, slug)
      const repository = await store.findRepository(org.login, repositoryName)
      if (!repository) throw new OrganizationError(404, `${org.login}/${repositoryName} not found`)
      await store.removeTeamRepository(repository.id, found.id, actor(admin))
    },
  }
}

export type OrganizationOperations = ReturnType<typeof createOrganizationOperations>
