import { describe, expect, it } from 'vitest'
import {
  applyMigrations,
  canAdministerOrganization,
  createAccountsStore,
  createOrganizationOperations,
  MIGRATIONS,
  OrganizationError,
  type Principal,
  resolveAccess,
  type UserPrincipal,
} from '@git-forge/accounts'
import { openSqliteDatabase } from '../src/index.ts'

const setup = async () => {
  const { db } = openSqliteDatabase()
  await applyMigrations(db, MIGRATIONS)
  const store = createAccountsStore(db)
  const operations = createOrganizationOperations(store)
  const user = async (login: string): Promise<UserPrincipal> => ({ kind: 'user', id: (await store.createUser({ login })).id, login, limits: null, tokenId: null })
  return { store, operations, user }
}

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    if (error instanceof OrganizationError) return error.status
    throw error
  }
  throw new Error('expected an OrganizationError')
}

describe('organization operations', () => {
  it('decides administration from membership and instance admin', () => {
    expect(canAdministerOrganization('owner', false)).toBe(true)
    expect(canAdministerOrganization('member', false)).toBe(false)
    expect(canAdministerOrganization(null, true)).toBe(true)
    expect(canAdministerOrganization(null, false)).toBe(false)
  })

  it('creates an organization owned by its creator and manages members', async () => {
    const { store, operations, user } = await setup()
    const ada = await user('ada')
    const bob = await user('bob')
    expect(await failure(operations.create({ kind: 'anonymous' }, 'acme'))).toBe(401)
    await operations.create(ada, 'acme')
    expect(await failure(operations.create(ada, 'acme'))).toBe(409)
    expect(await failure(operations.create(ada, 'bad name'))).toBe(422)
    expect(await failure(operations.create(ada, 'Settings'))).toBe(422)
    await operations.setMember(ada, 'acme', 'bob', 'member')
    const view = await operations.view(bob, 'acme')
    expect(view).toMatchObject({ membership: 'member', canAdminister: false })
    expect(view.members.map((member) => `${member.login}:${member.role}`)).toEqual(['ada:owner', 'bob:member'])
    expect(await operations.view({ kind: 'anonymous' }, 'acme')).toMatchObject({ members: [], teams: [] })
    expect(await failure(operations.setMember(bob, 'acme', 'bob', 'owner'))).toBe(403)
    expect(await failure(operations.setMember(await user('eve'), 'acme', 'eve', 'owner'))).toBe(404)
    expect(await failure(operations.setMember(ada, 'acme', 'ada', 'member'))).toBe(422)
    expect(await failure(operations.removeMember(ada, 'acme', 'ada'))).toBe(422)
    const limited: Principal = { ...ada, limits: { ceiling: 'write', repositoryIds: null }, tokenId: 't' }
    expect(await failure(operations.setMember(limited, 'acme', 'bob', 'owner'))).toBe(403)
    await operations.removeMember(ada, 'acme', 'bob')
    expect(await store.organizationRole((await store.findAccount('acme'))!.id, bob.id)).toBeNull()
  })

  it('manages teams, their members and their repository roles', async () => {
    const { store, operations, user } = await setup()
    const ada = await user('ada')
    const bob = await user('bob')
    const org = await operations.create(ada, 'acme')
    const repository = await store.createRepository({ ownerId: org.id, name: 'site', visibility: 'private' })
    await operations.createTeam(ada, 'acme', 'web', 'Web team')
    expect(await failure(operations.setTeamMember(ada, 'acme', 'web', 'bob', 'member'))).toBe(422)
    await operations.setMember(ada, 'acme', 'bob', 'member')
    await operations.setTeamMember(ada, 'acme', 'web', 'bob', 'maintainer')
    await operations.setTeamRepository(ada, 'acme', 'web', 'site', 'write')
    const team = await operations.team(bob, 'acme', 'web')
    expect(team.members).toEqual([expect.objectContaining({ login: 'bob', role: 'maintainer' })])
    expect(team.repositories).toEqual([{ id: repository.id, name: 'site', role: 'write' }])
    const subject = (await store.findRepository('acme', 'site'))!
    expect(resolveAccess(bob, subject, await store.grantsFor(bob, subject))).toBe('write')
    expect(await failure(operations.team({ kind: 'anonymous' }, 'acme', 'web'))).toBe(404)
    await operations.removeTeamRepository(ada, 'acme', 'web', 'site')
    await operations.removeTeamMember(ada, 'acme', 'web', 'bob')
    expect((await operations.team(ada, 'acme', 'web')).members).toEqual([])
    expect(resolveAccess(bob, subject, await store.grantsFor(bob, subject))).toBe('none')
  })
})
