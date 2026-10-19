import { describe, expect, it } from 'vitest'
import {
  applyMigrations,
  createAccountsStore,
  createInstanceAdministration,
  InstanceAdministrationError,
  MIGRATIONS,
  type Principal,
  type UserPrincipal,
} from '@git-forge/accounts'
import { testDatabase } from './database.ts'

const setup = async () => {
  const db = await testDatabase()
  await applyMigrations(db, MIGRATIONS)
  const store = createAccountsStore(db)
  const user = async (login: string): Promise<UserPrincipal> => ({ kind: 'user', id: (await store.createUser({ login })).id, login, limits: null, tokenId: null })
  return { store, operations: createInstanceAdministration(store), user }
}

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    if (error instanceof InstanceAdministrationError) return error.status
    throw error
  }
  throw new Error('expected an InstanceAdministrationError')
}

describe('instance administration', () => {
  it('lets instance admins manage admins and keeps the last one', async () => {
    const { store, operations, user } = await setup()
    const ada = await user('ada')
    const bob = await user('bob')
    await store.setInstanceAdmin(ada.id, true)
    expect(await failure(operations.view({ kind: 'anonymous' }))).toBe(401)
    expect(await failure(operations.view(bob))).toBe(403)
    const limited: Principal = { ...ada, limits: { ceiling: 'write', repositoryIds: null }, tokenId: 't' }
    expect(await failure(operations.view(limited))).toBe(403)
    expect(await operations.isAdministrator(limited)).toBe(false)
    expect(await failure(operations.setAdmin(ada, 'ada', false))).toBe(422)
    expect(await failure(operations.setAdmin(ada, 'nobody', true))).toBe(404)
    await operations.setAdmin(ada, 'bob', true)
    expect((await operations.view(bob)).admins.map((admin) => admin.login)).toEqual(['ada', 'bob'])
    await operations.setAdmin(bob, 'ada', false)
    expect(await operations.isAdministrator(ada)).toBe(false)
    expect((await store.auditLog()).map((entry) => entry.action)).toContain('instance.admin.revoke')
  })

  it('trusts and distrusts instances with normalized issuers', async () => {
    const { store, operations, user } = await setup()
    const ada = await user('ada')
    await store.setInstanceAdmin(ada.id, true)
    expect(await operations.trust(ada, 'https://mirror.example/', ' abc ')).toEqual({ issuer: 'https://mirror.example', pinnedThumbprint: 'abc' })
    await operations.trust(ada, 'https://backup.example', null)
    expect(await failure(operations.trust(ada, 'ftp://nope.example', null))).toBe(422)
    expect((await operations.view(ada)).trustedInstances).toEqual([
      expect.objectContaining({ issuer: 'https://backup.example', pinnedThumbprint: null }),
      expect.objectContaining({ issuer: 'https://mirror.example', pinnedThumbprint: 'abc' }),
    ])
    await operations.distrust(ada, 'https://mirror.example/')
    expect(await store.lookupTrustedIssuer('https://mirror.example')).toBeNull()
    expect((await operations.view(ada)).trustedInstances.map((trusted) => trusted.issuer)).toEqual(['https://backup.example'])
  })
})
